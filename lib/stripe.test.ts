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
  probeStripeKey,
  logCheckoutRejection,
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

  it("mode is not permission: production with half a pair reads 'dev' (R07-1)", async () => {
    // The whole finding in three lines. getProviderMode() cannot tell a
    // production box from a laptop, so the gate that grants value must not be
    // built on it — which is why devSimulatorEnabled() lives in lib/flags.ts.
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    expect(getProviderMode()).toBe("dev");
    const { devSimulatorEnabled } = await import("./flags");
    expect(devSimulatorEnabled()).toBe(false); // VITEST makes this a test process, not a development one
    const { paymentsLiveServer } = await import("./flags");
    expect(paymentsLiveServer()).toBe(false);
  });
});

describe("probeStripeKey (R07-4)", () => {
  // Distinct keys per case: the probe caches by key for a minute, and a shared
  // literal would let one test's answer stand in for the next one's.
  const calls: { url: string; init: RequestInit }[] = [];
  const stub = (status: number, body = "") =>
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(body, { status });
    }) as unknown as typeof fetch;

  afterEach(() => {
    calls.length = 0;
    vi.useRealTimers();
  });

  it("answers 'absent' with no key anywhere, without calling out", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const impl = stub(200);
    expect(await probeStripeKey({ fetchImpl: impl })).toEqual({ status: "absent" });
    expect(impl).not.toHaveBeenCalled();
  });

  it("asks the cheapest authenticated endpoint, once, with the key in the header", async () => {
    const health = await probeStripeKey({ key: "sk_test_probe_shape", fetchImpl: stub(200, "{}") });
    expect(health).toEqual({ status: "valid" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/balance");
    expect(calls[0].init.method ?? "GET").toBe("GET");
    expect(String((calls[0].init.headers as Record<string, string>).Authorization)).toContain("sk_test_probe_shape");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a refused key is 'invalid', and the detail carries no credential", async () => {
    const body = '{"error":{"message":"Invalid API Key provided: sk_test_refused_key_9 and whsec_leaked_7"}}';
    const health = await probeStripeKey({ key: "sk_test_probe_401", fetchImpl: stub(401, body) });
    expect(health.status).toBe("invalid");
    if (health.status !== "invalid") throw new Error("unreachable");
    expect(health.detail).toContain("HTTP 401");
    expect(health.detail).not.toContain("key_9");
    expect(health.detail).not.toContain("leaked_7");
    // 403 is a restricted key: it cannot read the balance, so it cannot be
    // trusted to create a session either.
    expect((await probeStripeKey({ key: "sk_test_probe_403", fetchImpl: stub(403, "{}") })).status).toBe("invalid");
  });

  it("an unreachable or broken provider is 'unknown', never 'invalid'", async () => {
    // A network blip must not be reported as a bad key: the operator would go
    // looking for a credential problem that does not exist.
    expect((await probeStripeKey({ key: "sk_test_probe_500", fetchImpl: stub(500, "oops") })).status).toBe("unknown");
    const boom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const down = await probeStripeKey({ key: "sk_test_probe_down", fetchImpl: boom });
    expect(down.status).toBe("unknown");
    if (down.status !== "unknown") throw new Error("unreachable");
    expect(down.detail).toContain("could not be reached");
  });

  it("caches the answer for a minute, per key", async () => {
    const t0 = 1_700_000_000_000;
    const impl = stub(200, "{}");
    const key = "sk_test_probe_cache";
    await probeStripeKey({ key, fetchImpl: impl, now: t0 });
    await probeStripeKey({ key, fetchImpl: impl, now: t0 + 59_000 });
    expect(impl).toHaveBeenCalledTimes(1);
    // Past the window it asks again — a key can be revoked between two pings.
    await probeStripeKey({ key, fetchImpl: impl, now: t0 + 61_000 });
    expect(impl).toHaveBeenCalledTimes(2);
    // A different key is a different question and never reuses the answer.
    await probeStripeKey({ key: "sk_test_probe_cache_2", fetchImpl: impl, now: t0 + 61_000 });
    expect(impl).toHaveBeenCalledTimes(3);
  });
});

describe("logCheckoutRejection (R07-4)", () => {
  it("logs once a minute and counts what it stood in for", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rejected = { providerStatus: 502, keyMode: "sk_test", detail: "bad key" };
      logCheckoutRejection(rejected);
      logCheckoutRejection(rejected);
      logCheckoutRejection(rejected);
      expect(spy).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2025-01-01T00:01:01Z"));
      logCheckoutRejection(rejected);
      expect(spy).toHaveBeenCalledTimes(2);
      // The suppressed count is the difference between "one buyer had a bad
      // time" and "every buyer since the last line had a bad time" — and since
      // phase 18 (R18-11) it is a field, so that sum can be queried.
      expect(spy.mock.calls[1][0]).toContain('"suppressed":2');
      expect(spy.mock.calls[1][0]).toContain('"msg":"checkout-rejected"');
      expect(spy.mock.calls[1][0]).toContain("bad key");
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
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
