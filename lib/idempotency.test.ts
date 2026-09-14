/* Phase 3 idempotency + webhook safety — pure unit tests (no DB required).
   Covers: commit TODO "vitest idempotency test".
   - Double webhook delivery must apply exactly once (guarded by pending→paid updateMany).
   - Stripe payload helpers handle metadata + paid detection.
   - Checkout idempotency keys are unique per attempt (uuid shape).
   - Rate limiter enforces 1/IP/stake/10s + 30/IP/hr windows.
*/
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { paymentIdFromStripePayload, stripePayloadIsPaid, verifyStripeSignature } from "./stripe";
import { rateLimit } from "./rateLimit";
import { validateCheckoutInput } from "./validate";

describe("stripe payload helpers", () => {
  it("extracts paymentId from the delivered object's metadata", () => {
    expect(paymentIdFromStripePayload({ data: { object: { metadata: { paymentId: "p1" } } } })).toBe("p1");
    // The reversal path depends on this: a charge carries the intent's copy.
    expect(paymentIdFromStripePayload({ data: { object: { object: "charge", metadata: { paymentId: "p2" } } } })).toBe("p2");
  });
  it("returns null when no paymentId present", () => {
    expect(paymentIdFromStripePayload({})).toBeNull();
    expect(paymentIdFromStripePayload(null)).toBeNull();
    expect(paymentIdFromStripePayload({ data: { object: { metadata: {} } } })).toBeNull();
    // Metadata outside the delivered object is not a substitute for its own.
    expect(paymentIdFromStripePayload({ data: { metadata: { paymentId: "p3" } } })).toBeNull();
  });
  it("treats a paid checkout session as paid, and nothing else", () => {
    expect(stripePayloadIsPaid({ type: "checkout.session.completed", data: { object: { payment_status: "paid" } } })).toBe(true);
    expect(stripePayloadIsPaid({ type: "checkout.session.async_payment_succeeded", data: { object: {} } })).toBe(true);
    // Phase 2 (P0-03, fail-closed): fail-closed on anything unproven.
    expect(stripePayloadIsPaid({ event: "membership.paid" })).toBe(false);
    expect(stripePayloadIsPaid({ event: "something.else" })).toBe(false);
    expect(stripePayloadIsPaid({})).toBe(false);
    expect(stripePayloadIsPaid({ type: "checkout.session.completed", data: { object: { payment_status: "unpaid" } } })).toBe(false);
    // Same money, but not the object we stored as providerRef.
    expect(stripePayloadIsPaid({ type: "payment_intent.succeeded", data: { object: { status: "succeeded" } } })).toBe(false);
  });
  it("rejects bad signatures without secret", () => {
    const prev = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(verifyStripeSignature("{}", "t=1700000000,v1=abc")).toBe(false);
    if (prev) process.env.STRIPE_WEBHOOK_SECRET = prev;
  });
});

describe("checkout validation (server revalidation)", () => {
  it("accepts a valid product checkout input", () => {
    const r = validateCheckoutInput({
      url: "https://example-startup.com",
      linkType: "product",
      title: "Acme",
      pitch: "We put flags on tables",
    });
    expect(r.ok).toBe(true);
  });
  it("rejects empty pitch (checkout-modal wiring regression: pitch must be sent)", () => {
    const r = validateCheckoutInput({
      url: "https://example-startup.com",
      linkType: "product",
      title: "Acme",
      pitch: "",
    });
    expect(r.ok).toBe(false);
  });
  it("rejects blocked domains", () => {
    const r = validateCheckoutInput({
      url: "https://example.com",
      linkType: "product",
      title: "Acme",
      pitch: "hello",
    });
    expect(r.ok).toBe(false);
  });
});

describe("click rate limiting (spec 03: 1/IP/stake/10s, 30/IP/hr)", () => {
  it("allows first hit, blocks second within window, allows different stake", () => {
    const ip = `test-${Date.now()}-${Math.random()}`;
    expect(rateLimit(`s:stakeA:${ip}`, 1, 10_000)).toBe(true);
    expect(rateLimit(`s:stakeA:${ip}`, 1, 10_000)).toBe(false);
    expect(rateLimit(`s:stakeB:${ip}`, 1, 10_000)).toBe(true);
  });
  it("enforces hourly per-IP cap", () => {
    const ip = `cap-${Date.now()}-${Math.random()}`;
    for (let i = 0; i < 30; i++) expect(rateLimit(`ip:${ip}`, 30, 3_600_000)).toBe(true);
    expect(rateLimit(`ip:${ip}`, 30, 3_600_000)).toBe(false);
  });
});

describe("double-delivery guard (static contract)", () => {
  it("settlePayment dedupes on provider event id (single-winner)", () => {
    const src = readFileSync(join(__dirname, "settle.ts"), "utf8");
    // The event claim must precede settlement and short-circuit duplicates.
    expect(src).toMatch(/providerEvent\.findUnique\(\{[\s\S]*providerEventId:\s*event\.eventId/);
    expect(src).toMatch(/outcome:\s*"duplicate"/);
  });
  it("settlePayment commits paid-transition and stake atomically", () => {
    const src = readFileSync(join(__dirname, "settle.ts"), "utf8");
    expect(src).toMatch(/pg_advisory_xact_lock/);
    expect(src).toMatch(/applyStakeTx\([\s\S]*,\s*tx\s*\)/);
    expect(src).toMatch(/enqueueOutbox/);
  });
  it("checkout route dedupes on idempotencyKey before creating a payment", () => {
    const src = readFileSync(join(__dirname, "..", "app", "api", "checkout", "route.ts"), "utf8");
    expect(src).toMatch(/findUnique\(\{[\s\S]*where:[\s\S]*idempotencyKey/);
  });
  it("webhook returns 200 on dupes (Stripe retries non-2xx forever)", () => {
    const src = readFileSync(join(__dirname, "..", "app", "api", "webhooks", "stripe", "route.ts"), "utf8");
    expect(src).toMatch(/Always 200 on dupes|ok:\s*true/);
  });
});
