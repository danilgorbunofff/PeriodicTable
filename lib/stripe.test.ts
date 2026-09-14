/* Stripe adapter unit tests (no DB, no network).
 *
 * These pin the provider's payload vocabulary — which event means paid, which
 * means dead, which means the money came back — and the unit conversion, since
 * every one of these is a silent failure when it drifts: nothing throws, the
 * ledger just disagrees with the bank.
 *
 * Signature verification and the request/response surface of
 * createStripeCheckoutSession are covered in webhook.test.ts and phase4.test.ts.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  stripeEnabled,
  getProviderMode,
  stripePartiallyConfigured,
  paymentIdFromStripePayload,
  stripePayloadIsPaid,
  stripePayloadIsFailed,
  stripePayloadReversal,
  stripeEventType,
  stripeEventId,
  stripeMoney,
} from "./stripe";

const event = (type: string, object: unknown) => ({ id: `evt_${type}`, type, data: { object } });

const session = (extra: Record<string, unknown> = {}) => ({
  object: "checkout.session",
  id: "cs_1",
  payment_status: "paid",
  amount_total: 500,
  currency: "usd",
  metadata: { paymentId: "pay_1" },
  ...extra,
});

afterEach(() => vi.unstubAllEnvs());

describe("provider mode", () => {
  it("needs both key and secret to be live", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    expect(stripeEnabled()).toBe(false);
    expect(getProviderMode()).toBe("dev");
    expect(stripePartiallyConfigured()).toBe(false);

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    expect(stripeEnabled()).toBe(false);
    expect(getProviderMode()).toBe("dev");
    expect(stripePartiallyConfigured()).toBe(true);

    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_x");
    expect(stripeEnabled()).toBe(true);
    // The string doubles as the Prisma PaymentProvider value.
    expect(getProviderMode()).toBe("stripe");
    expect(stripePartiallyConfigured()).toBe(false);
  });
});

describe("stripeMoney", () => {
  it("reads a session's integer cents as the dollars we charged", () => {
    expect(stripeMoney(event("checkout.session.completed", session()))).toEqual({
      amountUsd: 5,
      currency: "usd",
      providerRef: "cs_1",
    });
  });

  it("lowercases the currency and survives a fractional amount", () => {
    const money = stripeMoney(event("checkout.session.completed", session({ amount_total: 1250, currency: "USD" })));
    expect(money.amountUsd).toBe(12.5);
    expect(money.currency).toBe("usd");
  });

  // A charge/dispute/refund id is a different object's identity; storing one as
  // providerRef strands the row against the session event that follows it.
  it("never claims a providerRef from a non-session object", () => {
    expect(stripeMoney(event("charge.refunded", { object: "charge", id: "ch_1", amount: 500 }))).toEqual({
      amountUsd: 5,
      currency: null,
      providerRef: null,
    });
    expect(stripeMoney(event("charge.dispute.created", { object: "dispute", id: "dp_1", amount: 500 })).providerRef).toBeNull();
    expect(stripeMoney(event("refund.created", { object: "refund", id: "re_1", amount: 500 })).providerRef).toBeNull();
  });

  it("reports an absent amount as absent, not as zero", () => {
    expect(stripeMoney(event("checkout.session.completed", { object: "checkout.session", id: "cs_1" }))).toEqual({
      amountUsd: null,
      currency: null,
      providerRef: "cs_1",
    });
    expect(stripeMoney(event("checkout.session.completed", { object: "checkout.session", id: "cs_1", amount_total: "500" })).amountUsd).toBeNull();
    expect(stripeMoney({ type: "checkout.session.completed" }).amountUsd).toBeNull();
    expect(stripeMoney(null).providerRef).toBeNull();
  });
});

describe("stripePayloadIsPaid", () => {
  const paid = (type: string, object: unknown) => stripePayloadIsPaid(event(type, object));

  it("acts on a completed session that reports the money as paid", () => {
    expect(paid("checkout.session.completed", session())).toBe(true);
  });

  it("also acts on the async-payment follow-up", () => {
    expect(paid("checkout.session.async_payment_succeeded", session({ payment_status: "paid" }))).toBe(true);
  });

  // Async methods complete the session before the money clears; treating that
  // as paid hands over the inventory for a payment that never arrives.
  it("refuses a completed session that does not say paid", () => {
    expect(paid("checkout.session.completed", session({ payment_status: "unpaid" }))).toBe(false);
    expect(paid("checkout.session.completed", session({ payment_status: undefined }))).toBe(false);
    expect(paid("checkout.session.completed", { object: "checkout.session", id: "cs_1" })).toBe(false);
  });

  // One purchase emits all of these. They carry pi_/ch_ ids rather than the
  // cs_ id stored as providerRef, so acting on them files a reference mismatch
  // for a payment that is already settled — or settles a second stake.
  it("refuses the sibling events for the same purchase", () => {
    expect(paid("payment_intent.succeeded", { object: "payment_intent", id: "pi_1", metadata: { paymentId: "pay_1" } })).toBe(false);
    expect(paid("charge.succeeded", { object: "charge", id: "ch_1", metadata: { paymentId: "pay_1" } })).toBe(false);
    expect(paid("checkout.session.expired", session())).toBe(false);
    expect(paid("charge.refunded", session({ status: "refunded" }))).toBe(false);
  });

  it("treats an unknown or missing type as not paid", () => {
    expect(paid("", session())).toBe(false);
    expect(stripePayloadIsPaid({ data: { object: session() } })).toBe(false);
    expect(stripePayloadIsPaid(null)).toBe(false);
  });
});

describe("stripePayloadIsFailed", () => {
  const failed = (type: string, object: unknown = { object: "checkout.session", id: "cs_1" }) =>
    stripePayloadIsFailed(event(type, object));

  it("acts on the session's terminal outcomes", () => {
    expect(failed("checkout.session.expired")).toBe(true);
    expect(failed("checkout.session.async_payment_failed")).toBe(true);
  });

  // A single declined attempt leaves the session open and payable. Marking the
  // payment dead here means the retry that succeeds can never settle it.
  it("refuses a payment-intent decline", () => {
    expect(failed("payment_intent.payment_failed", { object: "payment_intent", id: "pi_1" })).toBe(false);
  });

  it("does not read a refund as a failure, or a paid session as one", () => {
    expect(stripePayloadIsFailed(event("charge.refunded", { object: "charge", id: "ch_1" }))).toBe(false);
    expect(failed("checkout.session.completed", session())).toBe(false);
    expect(stripePayloadIsFailed({})).toBe(false);
  });
});

describe("stripePayloadReversal", () => {
  // A refunded charge keeps status "succeeded", so the type is the only signal.
  it("matches the type for a refunded charge despite its succeeded status", () => {
    const payload = event("charge.refunded", { object: "charge", id: "ch_1", status: "succeeded", metadata: { paymentId: "pay_1" } });
    expect(stripePayloadReversal(payload)).toBe("type:charge.refunded");
  });

  it("matches disputes, withdrawn funds, and an explicit reversal status", () => {
    expect(stripePayloadReversal(event("charge.dispute.created", { object: "dispute", id: "dp_1" }))).toBe("type:charge.dispute.created");
    expect(stripePayloadReversal(event("charge.dispute.funds_withdrawn", { object: "dispute", id: "dp_1" }))).toBe("type:charge.dispute.funds_withdrawn");
    expect(stripePayloadReversal(event("checkout.session.completed", { object: "checkout.session", id: "cs_1", status: "refunded" }))).toBe("status:refunded");
    expect(stripePayloadReversal(event("charge.updated", { object: "charge", id: "ch_1", status: "Reversed" }))).toBe("status:reversed");
  });

  // Pending refunds can still fail; charge.refunded is the completion signal,
  // so waiting for it loses no coverage and never unwinds money we kept.
  it("ignores a refund that is still in flight", () => {
    expect(stripePayloadReversal(event("refund.created", { object: "refund", id: "re_1", status: "pending" }))).toBeNull();
    expect(stripePayloadReversal(event("refund.updated", { object: "refund", id: "re_1", status: "pending" }))).toBeNull();
    expect(stripePayloadReversal(event("charge.refund.updated", { object: "refund", id: "re_1" }))).toBeNull();
  });

  it("leaves ordinary and unknown events alone", () => {
    expect(stripePayloadReversal(event("checkout.session.completed", session()))).toBeNull();
    expect(stripePayloadReversal(event("customer.created", { object: "customer", id: "cus_1" }))).toBeNull();
    expect(stripePayloadReversal({})).toBeNull();
  });
});

describe("stripeEventType / paymentIdFromStripePayload / stripeEventId", () => {
  it("reads the type, defaulting to unknown", () => {
    expect(stripeEventType(event("charge.refunded", {}))).toBe("charge.refunded");
    expect(stripeEventType({ type: "" })).toBe("unknown");
    expect(stripeEventType(null)).toBe("unknown");
  });

  // Reversal events deliver a charge, and a charge only carries the payment
  // intent's metadata — which is why the create call writes it twice.
  it("finds the payment id on both a session and a charge", () => {
    expect(paymentIdFromStripePayload(event("checkout.session.completed", session()))).toBe("pay_1");
    expect(paymentIdFromStripePayload(event("charge.refunded", { object: "charge", id: "ch_1", metadata: { paymentId: "pay_1" } }))).toBe("pay_1");
  });

  it("returns null when metadata is missing or empty", () => {
    expect(paymentIdFromStripePayload(event("checkout.session.completed", { object: "checkout.session", id: "cs_1" }))).toBeNull();
    expect(paymentIdFromStripePayload(event("checkout.session.completed", { object: "checkout.session", metadata: { paymentId: "" } }))).toBeNull();
    expect(paymentIdFromStripePayload(event("checkout.session.completed", { object: "checkout.session", metadata: null }))).toBeNull();
    expect(paymentIdFromStripePayload(event("checkout.session.completed", {}))).toBeNull();
  });

  it("namespaces the provider event id, falling back to the body hash", () => {
    expect(stripeEventId({ id: "evt_123" }, "raw")).toBe("stripe:evt_123");
    const body = '{"type":"charge.refunded"}';
    const hashed = stripeEventId({}, body);
    expect(hashed).toMatch(/^stripe:sha:[0-9a-f]{32}$/);
    // Byte-identical redeliveries must dedupe.
    expect(stripeEventId({}, body)).toBe(hashed);
    expect(stripeEventId({ id: "" }, body)).toBe(hashed);
  });
});
