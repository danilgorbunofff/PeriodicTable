/* Webhook reference validation (Phase 7 — P0-03 follow-through).
   A provider session id attached to two payments must fail safe (operator
   ERROR), never 500-loop or double-apply. */
import { hasTestDb, purgeSettledOutbox, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "crypto";
import { POST as webhookPOST } from "../app/api/webhooks/whop/route";
import { whopPayloadReversal, whopSignatureScheme } from "./whop";

const prisma = testPrisma();
const hasDb = hasTestDb;
const T8 = 9992;
const T9 = 9991; // free id: 9992-9999 are taken by other suites (moderation owns 9993)
const SECRET = "test-whop-secret";

type Env = Record<string, string | undefined>;
const penv = process.env as unknown as Env;
let keyN = 0;

async function signed(body: object) {
  const raw = JSON.stringify(body);
  const sig = createHmac("sha256", SECRET).update(raw, "utf8").digest("hex");
  return webhookPOST(
    new NextRequest("http://localhost/api/webhooks/whop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-whop-signature": sig },
      body: raw,
    })
  );
}

/* The same delivery, shaped as a Standard Webhooks request (api_version v1). */
async function signedStandard(body: object, id = `sm_${Date.now()}_${keyN++}`) {
  const raw = JSON.stringify(body);
  const timestamp = "1700000000";
  const sig = createHmac("sha256", SECRET).update(`${id}.${timestamp}.${raw}`, "utf8").digest("base64");
  return webhookPOST(
    new NextRequest("http://localhost/api/webhooks/whop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${sig}`,
      },
      body: raw,
    })
  );
}

beforeAll(async () => {
  if (!hasDb) return;
  penv.WHOP_WEBHOOK_SECRET = SECRET;
  await prisma.stake.deleteMany({ where: { elementId: T8 } });
  await prisma.element.upsert({
    where: { id: T8 },
    create: { id: T8, symbol: "TST8", name: "Test Eight", atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
    update: {},
  });
  await prisma.stake.deleteMany({ where: { elementId: T9 } });
  await prisma.element.upsert({
    where: { id: T9 },
    create: { id: T9, symbol: "TST9", name: "Test Nine", atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
    update: {},
  });
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
  delete penv.WHOP_WEBHOOK_SECRET;
  const domains = ["wh-t.dev", "wh2-t.dev", "wh3-t.dev", "wh4-t.dev", "wh5-t.dev", "wh6-t.dev"];
  await prisma.providerEvent.deleteMany({ where: { payment: { startup: { domain: { in: domains } } } } });
  await purgeSettledOutbox(prisma, { startup: { domain: { in: domains } } });
  await prisma.activityLog.deleteMany({ where: { domain: { in: domains } } });
  await prisma.payment.deleteMany({ where: { startup: { domain: { in: domains } } } });
  await prisma.auditLog.deleteMany({ where: { startup: { domain: { in: domains } } } });
  await prisma.firstClaim.deleteMany({ where: { elementId: { in: [T8, T9] } } });
  await prisma.stake.deleteMany({ where: { elementId: { in: [T8, T9] } } });
  await prisma.element.deleteMany({ where: { id: { in: [T8, T9] } } });
  await prisma.startup.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
});

async function pendingPayment(domain: string, amount: number, ref: string | null, elementId = T8) {
  const s = await prisma.startup.upsert({
    where: { domain },
    create: { domain, title: domain, pitch: "webhook fixture pitch", url: `https://${domain}`, logoUrl: "x" },
    update: {},
  });
  return prisma.payment.create({
    data: {
      elementId,
      startupId: s.id,
      amountUsd: amount,
      path: "JOIN",
      provider: "WHOP",
      providerRef: ref,
      idempotencyKey: `wh-t-${Date.now()}-${keyN++}`,
      status: "PENDING",
    },
  });
}

describe.skipIf(!hasDb)("webhook reference safety", () => {
  it("mismatched reference on a claimed payment fails safe", async () => {
    const p = await pendingPayment("wh-t.dev", 10, "cs_owned");
    const res = await signed({
      id: `wh-mismatch-${Date.now()}`,
      type: "payment.succeeded",
      data: { status: "succeeded", amount: 10, currency: "usd", id: "cs_other", metadata: { paymentId: p.id } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { error?: string }).error).toMatch(/reference-mismatch/);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING");
  });
  it("reference claimed by another payment fails safe (no 500 loop)", async () => {
    const p1 = await pendingPayment("wh-t.dev", 10, "cs_shared");
    const p2 = await pendingPayment("wh2-t.dev", 10, null);
    const res = await signed({
      id: `wh-claimed-${Date.now()}`,
      type: "payment.succeeded",
      data: { status: "succeeded", amount: 10, currency: "usd", id: "cs_shared", metadata: { paymentId: p2.id } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { error?: string }).error).toMatch(/reference-claimed/);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p2.id } })).status).toBe("PENDING");
    expect(p1.id).not.toBe(p2.id);
  });
  it("matching reference settles", async () => {
    const p = await pendingPayment("wh2-t.dev", 12, "cs_mine");
    const res = await signed({
      id: `wh-ok-${Date.now()}`,
      type: "payment.succeeded",
      data: { status: "succeeded", amount: 12, currency: "usd", id: "cs_mine", metadata: { paymentId: p.id } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome?: string }).outcome).toBe("applied");
  });
  it("a delivery stating no amount settles, recorded as unverified", async () => {
    // Providers may omit the figure. The charge is real either way, so it must
    // settle — but the delivery carries the marker, because "nothing was
    // cross-checked" and "the figures agreed" are different facts.
    const p = await pendingPayment("wh2-t.dev", 12, null);
    const res = await signed({
      id: `wh-noamt-${Date.now()}`,
      type: "payment.succeeded",
      data: { status: "succeeded", id: `cs_noamt_${keyN++}`, metadata: { paymentId: p.id } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome?: string }).outcome).toBe("applied");

    const paid = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(paid.status).toBe("PAID");
    expect(paid.providerAmount).toBe(null);
    const ev = await prisma.providerEvent.findFirstOrThrow({ where: { paymentId: p.id, outcome: "APPLIED" } });
    expect(ev.detail).toBe("amount-unverified:provider-stated-none");
  });
  it("a delivery stating the amount is not marked unverified", async () => {
    const p = await pendingPayment("wh2-t.dev", 20, null);
    const res = await signed({
      id: `wh-amt-${Date.now()}`,
      type: "payment.succeeded",
      data: { status: "succeeded", amount: 20, currency: "usd", id: `cs_amt_${keyN++}`, metadata: { paymentId: p.id } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome?: string }).outcome).toBe("applied");
    const ev = await prisma.providerEvent.findFirstOrThrow({ where: { paymentId: p.id, outcome: "APPLIED" } });
    expect(ev.detail).toBe(null);
  });

  it("a Standard Webhooks delivery settles too", async () => {
    // Whop fixes the envelope when the webhook resource is created
    // (api_version: v1 = Standard Webhooks; v2/v5 = legacy). A deployment that
    // understood only the legacy one would 401 every real delivery — silently,
    // for as long as the provider keeps retrying, with the stake never applied.
    const p = await pendingPayment("wh2-t.dev", 18, null);
    const res = await signedStandard({
      id: `wh-std-${Date.now()}`,
      type: "payment.succeeded",
      data: { status: "succeeded", amount: 18, currency: "usd", id: `cs_std_${keyN++}`, metadata: { paymentId: p.id } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome?: string }).outcome).toBe("applied");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PAID");
  });
});

/* Refund / chargeback unwind (Phase 7). Before this path existed a reversal
   satisfied neither `paid` nor `failed`, so it fell through to IGNORED /
   unrelated-event: the network returned the buyer's money while the stake
   stayed on the board and in the pool. */
async function settledPayment(domain: string, amount: number, ref: string, elementId = T9) {
  const p = await pendingPayment(domain, amount, ref, elementId);
  const res = await signed({
    id: `wh-paid-${Date.now()}-${keyN++}`,
    type: "payment.succeeded",
    data: { status: "succeeded", amount, currency: "usd", id: ref, metadata: { paymentId: p.id } },
  });
  expect(((await res.json()) as { outcome?: string }).outcome).toBe("applied");
  return p;
}

const stakeOf = (elementId: number, startupId: string) =>
  prisma.stake.findUniqueOrThrow({ where: { elementId_startupId: { elementId, startupId } } });

describe.skipIf(!hasDb)("webhook refund / chargeback unwind", () => {
  it("a refund removes the stake, the pool, and the crown", async () => {
    const p = await settledPayment("wh3-t.dev", 25, "cs_refund_1");
    expect((await stakeOf(T9, p.startupId)).amountUsd).toBe(25);
    expect((await prisma.element.findUniqueOrThrow({ where: { id: T9 } })).totalPoolUsd).toBe(25);

    const res = await signed({
      id: `wh-refund-${Date.now()}`,
      type: "refund.created",
      data: { status: "refunded", amount: 25, currency: "usd", id: "re_1", metadata: { paymentId: p.id } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome?: string }).outcome).toBe("reversed");

    const paid = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(paid.status).toBe("REFUNDED");
    expect(paid.refundedAt).not.toBeNull();
    expect((await stakeOf(T9, p.startupId)).amountUsd).toBe(0);

    const el = await prisma.element.findUniqueOrThrow({ where: { id: T9 } });
    expect(el.totalPoolUsd).toBe(0);
    expect(el.stakeCount).toBe(1); // decreased, never deleted (ClickEvent.stakeId is required)
    expect(el.currentLeaderId).toBe(null); // a zero-amount stake can never lead

    const log = await prisma.activityLog.findFirstOrThrow({ where: { paymentId: p.id, kind: "refund" } });
    expect(log.deltaUsd).toBe(-25);
    expect(log.resultTotalUsd).toBe(0);

    const ev = await prisma.providerEvent.findFirstOrThrow({ where: { paymentId: p.id, detail: "status:refunded" } });
    expect(ev.outcome).toBe("REFUNDED");
  });

  it("a duplicate delivery cannot subtract twice", async () => {
    const p = await settledPayment("wh4-t.dev", 30, "cs_refund_2");
    const body = {
      id: `wh-dup-refund-${Date.now()}`,
      type: "refund.created",
      data: { status: "refunded", amount: 30, currency: "usd", id: "re_2", metadata: { paymentId: p.id } },
    };
    expect(((await (await signed(body)).json()) as { outcome?: string }).outcome).toBe("reversed");
    expect(((await (await signed(body)).json()) as { outcome?: string }).outcome).toBe("duplicate");
    expect((await stakeOf(T9, p.startupId)).amountUsd).toBe(0);

    // A DIFFERENT event id for an already-reversed payment is still a no-op:
    // the second subtraction would drive the stake negative.
    const again = await signed({
      id: `wh-refund-again-${Date.now()}`,
      type: "payment.refunded",
      data: { status: "refunded", amount: 30, currency: "usd", metadata: { paymentId: p.id } },
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { outcome?: string }).outcome).toBe("already-reversed");
    expect((await stakeOf(T9, p.startupId)).amountUsd).toBe(0);
    expect((await prisma.element.findUniqueOrThrow({ where: { id: T9 } })).totalPoolUsd).toBe(0);
  });

  it("a reversal wins over a paid signal in the same payload", async () => {
    const p = await settledPayment("wh3-t.dev", 12, "cs_both_1");
    const res = await signed({
      id: `wh-both-${Date.now()}`,
      type: "payment.succeeded",
      data: { status: "refunded", amount: 12, currency: "usd", id: "cs_both_1", metadata: { paymentId: p.id } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome?: string }).outcome).toBe("reversed");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("REFUNDED");
    expect((await stakeOf(T9, p.startupId)).amountUsd).toBe(0);
  });

  it("a reversal on a pending checkout closes it so a late paid event cannot apply", async () => {
    // wh5 is used here and nowhere else: an earlier test already reversed a
    // wh4 stake on T9 to $0, and reusing the domain would read that leftover
    // row as this test's result.
    const p = await pendingPayment("wh5-t.dev", 15, "cs_pending_1", T9);
    const res = await signed({
      id: `wh-pending-refund-${Date.now()}`,
      type: "charge.dispute.created",
      data: { status: "disputed", metadata: { paymentId: p.id } },
    });
    expect(res.status).toBe(200);
    // Not "ignored": a dispute is money leaving, never an unrelated event.
    expect(((await res.json()) as { outcome?: string }).outcome).toBe("not-paid");
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe("REFUNDED");
    expect(after.refundedAt).not.toBeNull();
    expect(await prisma.stake.findUnique({ where: { elementId_startupId: { elementId: T9, startupId: p.startupId } } })).toBe(null);
  });

  it("a partial refund still unwinds the full charged amount", async () => {
    // Deliberate: the ledger moves only in whole charges it recorded. A refund
    // figure we cannot reconcile must never leave paid-for inventory behind.
    const p = await settledPayment("wh3-t.dev", 40, "cs_partial_1");
    const res = await signed({
      id: `wh-partial-${Date.now()}`,
      type: "refund.created",
      data: { status: "refunded", amount: 10, currency: "usd", id: "re_3", metadata: { paymentId: p.id } },
    });
    expect(((await res.json()) as { outcome?: string }).outcome).toBe("reversed");
    expect((await stakeOf(T9, p.startupId)).amountUsd).toBe(0);
  });

  it("an unrelated event still leaves the checkout alone", async () => {
    const p = await pendingPayment("wh4-t.dev", 9, "cs_noise_1", T9);
    const res = await signed({
      id: `wh-noise-${Date.now()}`,
      type: "membership.created",
      data: { status: "active", metadata: { paymentId: p.id } },
    });
    expect(((await res.json()) as { outcome?: string }).outcome).toBe("ignored");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING");
  });

  it("a PAID payment with no stake row is terminal, not a silent reversal", async () => {
    // Simulates a corrupted ledger: settle applies the stake in the same
    // transaction that marks the payment PAID, so this state is unreachable
    // through the app. It must not be recorded as a reversal that unwound
    // nothing — the operator has to see it.
    const p = await settledPayment("wh6-t.dev", 25, "cs_nostake_1");
    await prisma.stake.delete({ where: { elementId_startupId: { elementId: T9, startupId: p.startupId } } });

    const res = await signed({
      id: `wh-nostake-${Date.now()}`,
      type: "refund.created",
      data: { status: "refunded", amount: 25, currency: "usd", id: "re_4", metadata: { paymentId: p.id } },
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(res.status).toBe(200); // terminal: redelivery cannot fix a broken ledger
    expect(body.ok).toBe(false);
    expect(body.error).toContain("ledger-invariant:reverse-no-stake");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PAID");

    // Leave T9 coherent for any later rerank (the corruption was the point).
    await prisma.element.update({ where: { id: T9 }, data: { currentLeaderId: null, totalPoolUsd: 0 } });
  });
});

describe("whopPayloadReversal", () => {
  it("matches reversal statuses and event types, and nothing else", () => {
    const cases: [unknown, string | null][] = [
      [{ data: { status: "refunded" } }, "status:refunded"],
      [{ data: { payment: { status: "Disputed" } } }, "status:disputed"],
      [{ data: { checkout_session: { status: "chargeback" } } }, "status:chargeback"],
      [{ data: { status: "reversed" } }, "status:reversed"],
      [{ type: "charge.refunded" }, "type:charge.refunded"],
      [{ type: "PAYMENT.REFUNDED" }, "type:payment.refunded"],
      [{ type: "charge.dispute.funds_withdrawn" }, "type:charge.dispute.funds_withdrawn"],
      // A reversal status wins over a paid type in the same payload.
      [{ type: "payment.succeeded", data: { status: "refunded" } }, "status:refunded"],
      // Non-reversals stay null: the paid/failed/unrelated classification is untouched.
      [{ type: "payment.succeeded", data: { status: "succeeded" } }, null],
      [{ data: { status: "canceled" } }, null],
      [{}, null],
      [null, null],
    ];
    for (const [payload, expected] of cases) {
      expect(whopPayloadReversal(payload), JSON.stringify(payload)).toBe(expected);
    }
  });
});

/* Envelope selection. The two schemes sign *different bytes* with the same
   secret, so implementing one and receiving the other 401s every delivery. */
describe("whop signature envelopes", () => {
  const ENV_SECRET = "envelope-test-secret";
  const previousSecret = process.env.WHOP_WEBHOOK_SECRET;
  const raw = '{"type":"payment.succeeded"}';
  const ID = "msg_2A0u1";
  const TS = "1700000000";

  const hexSig = (s: string) => createHmac("sha256", ENV_SECRET).update(s, "utf8").digest("hex");
  const b64Sig = (s: string) => createHmac("sha256", ENV_SECRET).update(s, "utf8").digest("base64");
  const standard = (signature: string, id: string | null = ID, timestamp: string | null = TS) => ({
    id,
    timestamp,
    signature,
  });

  beforeAll(() => {
    process.env.WHOP_WEBHOOK_SECRET = ENV_SECRET;
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.WHOP_WEBHOOK_SECRET;
    else process.env.WHOP_WEBHOOK_SECRET = previousSecret;
  });

  it("accepts a legacy hex signature over the raw body", () => {
    expect(whopSignatureScheme(raw, hexSig(raw))).toBe("legacy");
  });

  it("accepts a Standard Webhooks v1 signature", () => {
    expect(whopSignatureScheme(raw, null, standard(`v1,${b64Sig(`${ID}.${TS}.${raw}`)}`))).toBe("standard");
  });

  it("accepts an unpadded base64 signature", () => {
    const sig = b64Sig(`${ID}.${TS}.${raw}`).replace(/=+$/, "");
    expect(whopSignatureScheme(raw, null, standard(`v1,${sig}`))).toBe("standard");
  });

  it("accepts any matching entry when several are sent during rotation", () => {
    const good = b64Sig(`${ID}.${TS}.${raw}`);
    expect(whopSignatureScheme(raw, null, standard(`v1,bm90LXJlYWw= v1,${good}`))).toBe("standard");
  });

  it("ignores a non-v1 version tag", () => {
    expect(whopSignatureScheme(raw, null, standard(`v2,${b64Sig(`${ID}.${TS}.${raw}`)}`))).toBe(null);
  });

  it("rejects a v1 signature computed over the body alone", () => {
    // The precise confusion this guards against: right secret, wrong bytes.
    expect(whopSignatureScheme(raw, null, standard(`v1,${b64Sig(raw)}`))).toBe(null);
  });

  it("rejects a legacy signature computed over the signed-content form", () => {
    expect(whopSignatureScheme(raw, hexSig(`${ID}.${TS}.${raw}`))).toBe(null);
  });

  it("rejects a v1 signature when webhook-id or webhook-timestamp is absent", () => {
    const sig = `v1,${b64Sig(`${ID}.${TS}.${raw}`)}`;
    expect(whopSignatureScheme(raw, null, standard(sig, null))).toBe(null);
    expect(whopSignatureScheme(raw, null, standard(sig, ID, null))).toBe(null);
  });

  it("rejects a signature over a different body, in either scheme", () => {
    expect(whopSignatureScheme(`${raw} `, hexSig(raw))).toBe(null);
    expect(whopSignatureScheme(`${raw} `, null, standard(`v1,${b64Sig(`${ID}.${TS}.${raw}`)}`))).toBe(null);
  });

  it("rejects everything when no secret is configured", () => {
    const kept = process.env.WHOP_WEBHOOK_SECRET;
    delete process.env.WHOP_WEBHOOK_SECRET;
    try {
      expect(whopSignatureScheme(raw, hexSig(raw))).toBe(null);
      expect(whopSignatureScheme(raw, null, standard(`v1,${b64Sig(`${ID}.${TS}.${raw}`)}`))).toBe(null);
    } finally {
      process.env.WHOP_WEBHOOK_SECRET = kept;
    }
  });
});
