/* Webhook reference validation (Phase 7 — P0-03 follow-through).
   A provider session id attached to two payments must fail safe (operator
   ERROR), never 500-loop or double-apply. */
import { hasTestDb, purgeSettledOutbox, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "crypto";
import { POST as webhookPOST } from "../app/api/webhooks/stripe/route";
import { stripePayloadReversal, verifyStripeSignature, webhookSecrets } from "./stripe";

const prisma = testPrisma();
const hasDb = hasTestDb;
const T8 = 9992;
const T9 = 9991; // free id: 9992-9999 are taken by other suites (moderation owns 9993)
const SECRET = "whsec_test_secret";

type Env = Record<string, string | undefined>;
const penv = process.env as unknown as Env;
let keyN = 0;

/* Stripe's envelope: `t=<unix>,v1=<hex>`, an HMAC over `${t}.${rawBody}`. The
   timestamp is fresh on every call because the route checks freshness. */
async function signed(body: object) {
  return signedAt(body, Math.floor(Date.now() / 1000));
}

async function signedAt(body: object, timestamp: number) {
  const raw = JSON.stringify(body);
  const sig = createHmac("sha256", SECRET).update(`${timestamp}.${raw}`, "utf8").digest("hex");
  return webhookPOST(
    new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": `t=${timestamp},v1=${sig}` },
      body: raw,
    })
  );
}

/* A paid checkout session in the shape Stripe delivers it: integer cents,
   `payment_status: "paid"`, our paymentId in the session's own metadata. */
function sessionEvent(eventId: string, paymentId: string, opts: { id: string; amountCents?: number }) {
  return {
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        object: "checkout.session",
        id: opts.id,
        payment_status: "paid",
        currency: "usd",
        ...(opts.amountCents === undefined ? {} : { amount_total: opts.amountCents }),
        metadata: { paymentId },
      },
    },
  };
}

/* A `charge.refunded` delivery. The reversal is matched on the event type,
   because a Stripe charge's own `status` stays "succeeded" through a refund —
   the completion signal is the type, and `amount_refunded` may be partial. */
function refundEvent(eventId: string, paymentId: string, opts: { id?: string; amountCents?: number; refundedCents?: number }) {
  return {
    id: eventId,
    type: "charge.refunded",
    data: {
      object: {
        object: "charge",
        id: opts.id ?? `ch_${keyN++}`,
        status: "succeeded",
        refunded: true,
        amount: opts.amountCents ?? 0,
        amount_refunded: opts.refundedCents ?? opts.amountCents ?? 0,
        currency: "usd",
        metadata: { paymentId },
      },
    },
  };
}

beforeAll(async () => {
  if (!hasDb) return;
  penv.STRIPE_WEBHOOK_SECRET = SECRET;
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
  delete penv.STRIPE_WEBHOOK_SECRET;
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
      provider: "STRIPE",
      providerRef: ref,
      idempotencyKey: `wh-t-${Date.now()}-${keyN++}`,
      status: "PENDING",
    },
  });
}

describe.skipIf(!hasDb)("webhook reference safety", () => {
  it("mismatched reference on a claimed payment fails safe", async () => {
    const p = await pendingPayment("wh-t.dev", 10, "cs_owned");
    const res = await signed(sessionEvent(`evt_mismatch_${Date.now()}`, p.id, { id: "cs_other", amountCents: 1000 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { error?: string }).error).toMatch(/reference-mismatch/);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING");
  });
  it("reference claimed by another payment fails safe (no 500 loop)", async () => {
    const p1 = await pendingPayment("wh-t.dev", 10, "cs_shared");
    const p2 = await pendingPayment("wh2-t.dev", 10, null);
    const res = await signed(sessionEvent(`evt_claimed_${Date.now()}`, p2.id, { id: "cs_shared", amountCents: 1000 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { error?: string }).error).toMatch(/reference-claimed/);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p2.id } })).status).toBe("PENDING");
    expect(p1.id).not.toBe(p2.id);
  });
  it("matching reference settles", async () => {
    const p = await pendingPayment("wh2-t.dev", 12, "cs_mine");
    const res = await signed(sessionEvent(`evt_ok_${Date.now()}`, p.id, { id: "cs_mine", amountCents: 1200 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome?: string }).outcome).toBe("applied");
  });
  it("a delivery stating no amount settles, recorded as unverified", async () => {
    // Providers may omit the figure. The charge is real either way, so it must
    // settle — but the delivery carries the marker, because "nothing was
    // cross-checked" and "the figures agreed" are different facts.
    const p = await pendingPayment("wh2-t.dev", 12, null);
    const res = await signed(sessionEvent(`evt_noamt_${Date.now()}`, p.id, { id: `cs_noamt_${keyN++}` }));
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
    const res = await signed(sessionEvent(`evt_amt_${Date.now()}`, p.id, { id: `cs_amt_${keyN++}`, amountCents: 2000 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome?: string }).outcome).toBe("applied");
    const ev = await prisma.providerEvent.findFirstOrThrow({ where: { paymentId: p.id, outcome: "APPLIED" } });
    expect(ev.detail).toBe(null);
  });

  it("a delivery whose timestamp is outside the tolerance is refused", async () => {
    // The envelope carries its own freshness proof. Without the check a single
    // observed delivery replays forever — the signature never expires, so a
    // re-timed copy stays valid and can settle whatever payment it names.
    const p = await pendingPayment("wh2-t.dev", 18, null);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const res = await signedAt(sessionEvent(`evt_stale_${Date.now()}`, p.id, { id: `cs_stale_${keyN++}`, amountCents: 1800 }), stale);
    expect(res.status).toBe(401);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING");

    // The same bytes with a current timestamp are fine: only the age was wrong.
    const fresh = await signed(sessionEvent(`evt_fresh_${Date.now()}`, p.id, { id: `cs_fresh_${keyN++}`, amountCents: 1800 }));
    expect(((await fresh.json()) as { outcome?: string }).outcome).toBe("applied");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PAID");
  });
});

/* Refund / chargeback unwind (Phase 7). Before this path existed a reversal
   satisfied neither `paid` nor `failed`, so it fell through to IGNORED /
   unrelated-event: the network returned the buyer's money while the stake
   stayed on the board and in the pool. */
async function settledPayment(domain: string, amount: number, ref: string, elementId = T9) {
  const p = await pendingPayment(domain, amount, ref, elementId);
  const res = await signed(sessionEvent(`evt_paid_${Date.now()}_${keyN++}`, p.id, { id: ref, amountCents: Math.round(amount * 100) }));
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

    const res = await signed(refundEvent(`evt_refund_${Date.now()}`, p.id, { id: "ch_1", amountCents: 2500, refundedCents: 2500 }));
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

    const ev = await prisma.providerEvent.findFirstOrThrow({ where: { paymentId: p.id, detail: "type:charge.refunded" } });
    expect(ev.outcome).toBe("REFUNDED");
  });

  it("a duplicate delivery cannot subtract twice", async () => {
    const p = await settledPayment("wh4-t.dev", 30, "cs_refund_2");
    const body = refundEvent(`evt_dup_refund_${Date.now()}`, p.id, { id: "ch_2", amountCents: 3000, refundedCents: 3000 });
    expect(((await (await signed(body)).json()) as { outcome?: string }).outcome).toBe("reversed");
    expect(((await (await signed(body)).json()) as { outcome?: string }).outcome).toBe("duplicate");
    expect((await stakeOf(T9, p.startupId)).amountUsd).toBe(0);

    // A DIFFERENT event id for an already-reversed payment is still a no-op:
    // the second subtraction would drive the stake negative.
    const again = await signed({
      id: `evt_refund_again_${Date.now()}`,
      type: "charge.dispute.funds_withdrawn",
      data: { object: { object: "dispute", id: "dp_1", status: "lost", currency: "usd", metadata: { paymentId: p.id } } },
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { outcome?: string }).outcome).toBe("already-reversed");
    expect((await stakeOf(T9, p.startupId)).amountUsd).toBe(0);
    expect((await prisma.element.findUniqueOrThrow({ where: { id: T9 } })).totalPoolUsd).toBe(0);
  });

  it("a reversal wins over a paid signal in the same payload", async () => {
    const p = await settledPayment("wh3-t.dev", 12, "cs_both_1");
    // Not a shape Stripe emits today: the ordering is the subject. Classification
    // runs reversal-first, so if it were ever paid-first this payload would apply
    // a stake *and* unwind it, instead of unwinding.
    const res = await signed({
      id: `evt_both_${Date.now()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          object: "checkout.session",
          id: "cs_both_1",
          payment_status: "paid",
          status: "refunded",
          amount_total: 1200,
          currency: "usd",
          metadata: { paymentId: p.id },
        },
      },
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
      id: `evt_pending_dispute_${Date.now()}`,
      type: "charge.dispute.created",
      data: { object: { object: "dispute", id: "dp_2", status: "needs_response", currency: "usd", metadata: { paymentId: p.id } } },
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
    const res = await signed(refundEvent(`evt_partial_${Date.now()}`, p.id, { id: "ch_3", amountCents: 4000, refundedCents: 1000 }));
    expect(((await res.json()) as { outcome?: string }).outcome).toBe("reversed");
    expect((await stakeOf(T9, p.startupId)).amountUsd).toBe(0);
  });

  it("an unrelated event still leaves the checkout alone", async () => {
    const p = await pendingPayment("wh4-t.dev", 9, "cs_noise_1", T9);
    const res = await signed({
      id: `evt_noise_${Date.now()}`,
      type: "payment_intent.created",
      data: {
        object: { object: "payment_intent", id: "pi_noise_1", status: "requires_payment_method", currency: "usd", metadata: { paymentId: p.id } },
      },
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

    const res = await signed(refundEvent(`evt_nostake_${Date.now()}`, p.id, { id: "ch_4", amountCents: 2500, refundedCents: 2500 }));
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(res.status).toBe(200); // terminal: redelivery cannot fix a broken ledger
    expect(body.ok).toBe(false);
    expect(body.error).toContain("ledger-invariant:reverse-no-stake");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PAID");

    // Leave T9 coherent for any later rerank (the corruption was the point).
    await prisma.element.update({ where: { id: T9 }, data: { currentLeaderId: null, totalPoolUsd: 0 } });
  });
});

describe("stripePayloadReversal", () => {
  it("matches reversal statuses and event types, and nothing else", () => {
    const cases: [unknown, string | null][] = [
      // What a real delivery looks like: the object's own `status` is not a
      // reversal word, so the event type is what carries the signal.
      [{ type: "charge.refunded", data: { object: { object: "charge", status: "succeeded" } } }, "type:charge.refunded"],
      [{ type: "charge.dispute.created", data: { object: { object: "dispute", status: "needs_response" } } }, "type:charge.dispute.created"],
      [{ type: "charge.dispute.funds_withdrawn", data: { object: { object: "dispute", status: "lost" } } }, "type:charge.dispute.funds_withdrawn"],
      // Over-matching is the safe direction for a reversal, so the type is
      // lowercased where the paid path is not.
      [{ type: "CHARGE.REFUNDED", data: { object: {} } }, "type:charge.refunded"],
      // The status branch, for any event that names a reversal outright.
      [{ data: { object: { status: "refunded" } } }, "status:refunded"],
      [{ data: { object: { status: "Disputed" } } }, "status:disputed"],
      [{ data: { object: { status: "chargeback" } } }, "status:chargeback"],
      [{ data: { object: { status: "reversed" } } }, "status:reversed"],
      // A reversal status wins over a paid type in the same payload.
      [{ type: "checkout.session.completed", data: { object: { status: "refunded" } } }, "status:refunded"],
      // Non-reversals stay null: the paid/failed/unrelated classification is untouched.
      [{ type: "checkout.session.completed", data: { object: { status: "complete", payment_status: "paid" } } }, null],
      // Deliberate exclusion: a refund is pending here and can still fail, so
      // unwinding on it would strip a stake for money we kept. `charge.refunded`
      // is the completion signal for the same money.
      [{ type: "refund.created", data: { object: { object: "refund", status: "pending" } } }, null],
      [{ type: "checkout.session.expired", data: { object: { status: "expired" } } }, null],
      [{}, null],
      [null, null],
    ];
    for (const [payload, expected] of cases) {
      expect(stripePayloadReversal(payload), JSON.stringify(payload)).toBe(expected);
    }
  });
});

/* Envelope verification. The HMAC covers `${t}.${rawBody}`, and `t` is also the
   freshness proof — so getting either wrong 401s every real delivery, silently,
   for as long as the provider keeps retrying. */
describe("stripe signature verification", () => {
  const ENV_SECRET = "whsec_envelope_test";
  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const raw = '{"type":"checkout.session.completed"}';
  const TS = 1700000000;

  const hexSig = (s: string, t: number = TS) => createHmac("sha256", ENV_SECRET).update(`${t}.${s}`, "utf8").digest("hex");

  beforeAll(() => {
    process.env.STRIPE_WEBHOOK_SECRET = ENV_SECRET;
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
  });

  it("accepts a v1 signature over `${t}.${body}`", () => {
    expect(verifyStripeSignature(raw, `t=${TS},v1=${hexSig(raw)}`, TS)).toBe(true);
  });

  it("accepts any matching entry when several are sent during rotation", () => {
    expect(verifyStripeSignature(raw, `t=${TS},v1=bm90LXJlYWw=,v1=${hexSig(raw)}`, TS)).toBe(true);
  });

  it("rejects a v1 signature computed over the body alone", () => {
    // The precise confusion this guards against: right secret, wrong bytes.
    const bodyOnly = createHmac("sha256", ENV_SECRET).update(raw, "utf8").digest("hex");
    expect(verifyStripeSignature(raw, `t=${TS},v1=${bodyOnly}`, TS)).toBe(false);
  });

  it("rejects a header with no timestamp, with no v1 entry, or with no header", () => {
    expect(verifyStripeSignature(raw, `v1=${hexSig(raw)}`, TS)).toBe(false);
    expect(verifyStripeSignature(raw, `t=${TS}`, TS)).toBe(false);
    expect(verifyStripeSignature(raw, null, TS)).toBe(false);
  });

  it("rejects a signature outside the tolerance window, in either direction", () => {
    // The window is the reason the envelope carries `t` at all: without it a
    // captured delivery is a valid signature forever.
    expect(verifyStripeSignature(raw, `t=${TS},v1=${hexSig(raw)}`, TS + 301)).toBe(false);
    expect(verifyStripeSignature(raw, `t=${TS},v1=${hexSig(raw)}`, TS - 301)).toBe(false);
    expect(verifyStripeSignature(raw, `t=${TS},v1=${hexSig(raw)}`, TS + 300)).toBe(true);
  });

  it("rejects a signature over a different body, and a wrong secret", () => {
    expect(verifyStripeSignature(`${raw} `, `t=${TS},v1=${hexSig(raw)}`, TS)).toBe(false);
    const other = createHmac("sha256", "whsec_someone_else").update(`${TS}.${raw}`, "utf8").digest("hex");
    expect(verifyStripeSignature(raw, `t=${TS},v1=${other}`, TS)).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    const kept = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      expect(verifyStripeSignature(raw, `t=${TS},v1=${hexSig(raw)}`, TS)).toBe(false);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = kept;
    }
  });
});

/* R17-2: the rotation overlap. `STRIPE_WEBHOOK_SECRET_OLD` exists so a rotation
   in Stripe's dashboard is not an outage: while both are set, a delivery signed
   with either is accepted. The ordering rule matters more than the overlap does
   — a stale second secret must never be able to authenticate on its own, or a
   leaked old value stays a forgery key forever. */
describe("stripe webhook secret rotation (R17-2)", () => {
  const raw = '{"type":"charge.refunded"}';
  const TS = 1700000000;
  const sign = (secret: string) =>
    `t=${TS},v1=${createHmac("sha256", secret).update(`${TS}.${raw}`, "utf8").digest("hex")}`;
  const saved = {
    current: process.env.STRIPE_WEBHOOK_SECRET,
    old: process.env.STRIPE_WEBHOOK_SECRET_OLD,
  };
  const restore = () => {
    for (const [k, v] of [
      ["STRIPE_WEBHOOK_SECRET", saved.current],
      ["STRIPE_WEBHOOK_SECRET_OLD", saved.old],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  beforeEach(restore);
  afterAll(restore);

  it("accepts the current secret, and the previous one only during an overlap", () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_new";
    expect(verifyStripeSignature(raw, sign("whsec_new"), TS)).toBe(true);
    // No overlap set: the old value is not a key. This is the case a botched
    // rotation leaves behind, and it must fail rather than half-work.
    expect(verifyStripeSignature(raw, sign("whsec_old"), TS)).toBe(false);

    process.env.STRIPE_WEBHOOK_SECRET_OLD = "whsec_old";
    expect(verifyStripeSignature(raw, sign("whsec_new"), TS)).toBe(true);
    expect(verifyStripeSignature(raw, sign("whsec_old"), TS)).toBe(true);
    // A third value is still nobody.
    expect(verifyStripeSignature(raw, sign("whsec_third"), TS)).toBe(false);

    // Deleting the overlap closes the window: verified after the fact, which is
    // the state the config advisory is meant to force.
    delete process.env.STRIPE_WEBHOOK_SECRET_OLD;
    expect(verifyStripeSignature(raw, sign("whsec_old"), TS)).toBe(false);
  });

  it("treats a lone STRIPE_WEBHOOK_SECRET_OLD as no secret at all", () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET_OLD = "whsec_orphan";
    expect(webhookSecrets()).toEqual([]);
    expect(webhookSecrets({} as NodeJS.ProcessEnv)).toEqual([]);
    // Consequence, not decoration: the verifier cannot accept the orphan, so a
    // half-rotated deploy refuses every delivery instead of accepting an
    // unmanaged key.
    expect(verifyStripeSignature(raw, sign("whsec_orphan"), TS)).toBe(false);
  });

  it("reports which secrets are loaded, without echoing them", () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET_OLD;
    expect(webhookSecrets()).toEqual([]);
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_a";
    expect(webhookSecrets()).toEqual(["whsec_a"]);
    process.env.STRIPE_WEBHOOK_SECRET_OLD = "whsec_b";
    expect(webhookSecrets()).toEqual(["whsec_a", "whsec_b"]);
    // An empty overlap string is "not set" — Vercel exports empty-string vars
    // all the time, and treating one as a key would accept a blank signature.
    process.env.STRIPE_WEBHOOK_SECRET_OLD = "";
    expect(webhookSecrets()).toEqual(["whsec_a"]);
  });
});
