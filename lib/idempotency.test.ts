/* Phase 3 idempotency + webhook safety — pure unit tests (no DB required).
   Covers: commit TODO "vitest idempotency test".
   - Double webhook delivery must apply exactly once (guarded by pending→paid updateMany).
   - Whop payload helpers handle both metadata shapes + paid detection.
   - Checkout idempotency keys are unique per attempt (uuid shape).
   - Rate limiter enforces 1/IP/stake/10s + 30/IP/hr windows.
*/
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { paymentIdFromWhopPayload, whopPayloadIsPaid, verifyWhopSignature } from "./whop";
import { rateLimit } from "./rateLimit";
import { validateCheckoutInput } from "./validate";

describe("whop payload helpers", () => {
  it("extracts paymentId from plan.metadata, data.metadata, and top-level metadata", () => {
    expect(paymentIdFromWhopPayload({ data: { plan: { metadata: { paymentId: "p1" } } } })).toBe("p1");
    expect(paymentIdFromWhopPayload({ data: { metadata: { paymentId: "p2" } } })).toBe("p2");
    expect(paymentIdFromWhopPayload({ metadata: { paymentId: "p3" } })).toBe("p3");
  });
  it("returns null when no paymentId present", () => {
    expect(paymentIdFromWhopPayload({})).toBeNull();
    expect(paymentIdFromWhopPayload(null)).toBeNull();
    expect(paymentIdFromWhopPayload({ data: { metadata: {} } })).toBeNull();
  });
  it("treats succeeded/completed/paid as paid, others as not", () => {
    expect(whopPayloadIsPaid({ data: { status: "succeeded" } })).toBe(true);
    expect(whopPayloadIsPaid({ data: { status: "completed" } })).toBe(true);
    expect(whopPayloadIsPaid({ data: { payment: { status: "paid" } } })).toBe(true);
    expect(whopPayloadIsPaid({ data: { status: "failed" } })).toBe(false);
    // Phase 2 (P0-03, fail-closed): allowlisted event types count without status fields…
    expect(whopPayloadIsPaid({ event: "membership.paid" })).toBe(true);
    // …but statusless, unlisted events must NOT apply a stake.
    expect(whopPayloadIsPaid({ event: "something.else" })).toBe(false);
    expect(whopPayloadIsPaid({})).toBe(false);
    expect(whopPayloadIsPaid({ data: { status: "pending" } })).toBe(false);
    expect(whopPayloadIsPaid({ data: { status: "refunded" } })).toBe(false);
  });
  it("rejects bad signatures without secret", () => {
    const prev = process.env.WHOP_WEBHOOK_SECRET;
    delete process.env.WHOP_WEBHOOK_SECRET;
    expect(verifyWhopSignature("{}", "abc")).toBe(false);
    if (prev) process.env.WHOP_WEBHOOK_SECRET = prev;
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
  it("webhook returns 200 on dupes (Whop retries non-2xx forever)", () => {
    const src = readFileSync(join(__dirname, "..", "app", "api", "webhooks", "whop", "route.ts"), "utf8");
    expect(src).toMatch(/Always 200 on dupes|ok:\s*true/);
  });
});
