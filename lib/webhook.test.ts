/* Webhook reference validation (Phase 7 — P0-03 follow-through).
   A provider session id attached to two payments must fail safe (operator
   ERROR), never 500-loop or double-apply. */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "crypto";
import { POST as webhookPOST } from "../app/api/webhooks/whop/route";
import { whopPayloadReversal } from "./whop";

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
  await prisma.outboxEvent.deleteMany({ where: { OR: [{ dedupeKey: { contains: "wh-t" } }, { dedupeKey: { contains: "wh2-t" } }] } });
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
