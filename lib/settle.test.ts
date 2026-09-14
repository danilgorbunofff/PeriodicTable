/* Phase 2 payment/webhook tests.
   Pure section (no DB): strict paid classification, money validation,
   reservation conflict rule, event-id stability.
   Integration section (needs local test DB): atomic settle, duplicate-event
   dedupe, statusless-event rejection path, reservation consume/expire. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  stripePayloadIsPaid,
  stripePayloadIsFailed,
  stripeEventId,
  stripeEventType,
  stripeMoney,
  getProviderMode,
} from "./stripe";
import { validateProviderMoney, providerAmountAgrees, providerCurrencyAgrees } from "./money";
import { reservationConflict, isReservationLive, RESERVATION_TTL_MS } from "./reservations";

describe("strict paid classification (P0-03)", () => {
  it("accepts explicit paid signals only", () => {
    expect(stripePayloadIsPaid({ type: "checkout.session.completed", data: { object: { payment_status: "paid" } } })).toBe(true);
    expect(stripePayloadIsPaid({ type: "checkout.session.async_payment_succeeded", data: { object: {} } })).toBe(true);
  });
  it("rejects everything else, especially statusless payloads", () => {
    expect(stripePayloadIsPaid({})).toBe(false);
    expect(stripePayloadIsPaid(null)).toBe(false);
    expect(stripePayloadIsPaid({ data: {} })).toBe(false);
    expect(stripePayloadIsPaid({ event: "payment.updated", data: {} })).toBe(false);
    // Completing the session is not being paid: async methods finish the
    // session before the money clears.
    expect(stripePayloadIsPaid({ type: "checkout.session.completed", data: { object: { payment_status: "unpaid" } } })).toBe(false);
    // One purchase emits these next to the session event, and they name the
    // intent and the charge rather than the session we stored.
    expect(stripePayloadIsPaid({ type: "payment_intent.succeeded", data: { object: { status: "succeeded" } } })).toBe(false);
    expect(stripePayloadIsPaid({ type: "charge.succeeded", data: { object: { status: "succeeded" } } })).toBe(false);
    expect(stripePayloadIsPaid({ type: "charge.refunded", data: { object: { status: "succeeded" } } })).toBe(false);
  });
  it("detects explicit failure signals only", () => {
    expect(stripePayloadIsFailed({ type: "checkout.session.expired" })).toBe(true);
    expect(stripePayloadIsFailed({ type: "checkout.session.async_payment_failed" })).toBe(true);
    expect(stripePayloadIsFailed({})).toBe(false);
    expect(stripePayloadIsFailed({ data: {} })).toBe(false);
    expect(stripePayloadIsFailed({ event: "payment.updated", data: {} })).toBe(false);
    // A single declined attempt leaves the session open and payable; treating
    // it as failure kills the retry that then succeeds.
    expect(stripePayloadIsFailed({ type: "payment_intent.payment_failed" })).toBe(false);
    expect(stripePayloadIsFailed({ type: "checkout.session.completed" })).toBe(false);
  });
});

describe("provider event identity", () => {
  it("prefers the provider id, falls back to a stable body hash", () => {
    expect(stripeEventId({ id: "evt_1" }, "{}")).toBe("stripe:evt_1");
    // A nested id belongs to some other object; hashing the body beats filing
    // the delivery under an id the provider never sent as an event id.
    expect(stripeEventId({ data: { id: "evt_2" } }, '{"a":2}')).toMatch(/^stripe:sha:/);
    const a = stripeEventId({}, '{"a":1}');
    expect(a).toBe(stripeEventId({}, '{"a":1}'));
    expect(a).not.toBe(stripeEventId({}, '{"a":2}'));
  });
  it("reads event types from known shapes", () => {
    expect(stripeEventType({ type: "checkout.session.completed" })).toBe("checkout.session.completed");
    expect(stripeEventType({ event: "payment.failed" })).toBe("unknown");
    expect(stripeEventType({})).toBe("unknown");
  });
});

describe("money validation", () => {
  it("accepts dollars or cents, reports absent, rejects mismatch", () => {
    expect(validateProviderMoney(21, { amountUsd: 21, currency: "usd", providerRef: null })).toEqual({ status: "ok" });
    expect(validateProviderMoney(21, { amountUsd: 2100, currency: "usd", providerRef: null })).toEqual({ status: "ok" });
    // `absent` is its own state: an unverified amount must never read as verified.
    expect(validateProviderMoney(21, { amountUsd: null, currency: null, providerRef: null })).toEqual({ status: "absent" });
    const mismatch = validateProviderMoney(21, { amountUsd: 22, currency: "usd", providerRef: null });
    expect(mismatch).toEqual({ status: "rejected", reason: "amount-mismatch:22" });
    expect(validateProviderMoney(21, { amountUsd: 21, currency: "eur", providerRef: null })).toEqual({
      status: "rejected",
      reason: "currency-mismatch:eur",
    });
  });
  it("the shared acceptance predicates are the rule the report reads rows with", () => {
    // Both the webhook and /api/jobs/reconcile call these, so pinning them here
    // pins the only copy of "dollars or cents" that exists.
    expect(providerAmountAgrees(21, 21)).toBe(true);
    expect(providerAmountAgrees(21, 2100)).toBe(true);
    expect(providerAmountAgrees(21, 22)).toBe(false);
    expect(providerAmountAgrees(21, 2101)).toBe(false); // near-miss cents is not agreement
    expect(providerCurrencyAgrees(null)).toBe(true); // stated none: not a contradiction
    expect(providerCurrencyAgrees("USD")).toBe(true);
    expect(providerCurrencyAgrees("eur")).toBe(false);
  });
  it("normalises cents to dollars and claims a ref only from a session", () => {
    expect(stripeMoney({ data: { object: { object: "checkout.session", id: "cs_1", amount_total: 2100, currency: "USD" } } })).toEqual({
      amountUsd: 21,
      currency: "usd",
      providerRef: "cs_1",
    });
    expect(stripeMoney({})).toEqual({ amountUsd: null, currency: null, providerRef: null });
    // A charge id is a different object's identity; claiming it would strand
    // the row against the session event that follows.
    expect(
      stripeMoney({ data: { object: { object: "charge", id: "ch_1", amount: 2100, currency: "usd" } } }).providerRef
    ).toBe(null);
  });
  it("provider mode is dev without full Stripe config", () => {
    // CI/dev never sets Stripe keys; production gating is covered by env tests.
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
      expect(getProviderMode()).toBe("dev");
    }
  });
});

describe("reservation conflict rule", () => {
  const live = { id: "r1", startupId: "s-owner", paymentId: "p1", reservedTotal: 51, expiresAt: new Date(Date.now() + RESERVATION_TTL_MS) };
  it("free element never conflicts", () => {
    expect(reservationConflict({ reservation: null, myStartupId: null, myPriorTotal: 0, addUsd: 100 }).conflict).toBe(false);
  });
  it("owner top-ups never conflict", () => {
    expect(reservationConflict({ reservation: live, myStartupId: "s-owner", myPriorTotal: 50, addUsd: 100 }).conflict).toBe(false);
  });
  it("below-reserve joins sail through", () => {
    expect(reservationConflict({ reservation: live, myStartupId: null, myPriorTotal: 0, addUsd: 5 }).conflict).toBe(false);
    expect(reservationConflict({ reservation: live, myStartupId: "s-other", myPriorTotal: 40, addUsd: 10 }).conflict).toBe(false);
  });
  it("at-or-above reserve from another startup conflicts", () => {
    const at = reservationConflict({ reservation: live, myStartupId: null, myPriorTotal: 0, addUsd: 51 });
    expect(at.conflict).toBe(true);
    const over = reservationConflict({ reservation: live, myStartupId: "s-other", myPriorTotal: 48, addUsd: 5 });
    expect(over.conflict).toBe(true);
    if (over.conflict) expect(over.reservedTotal).toBe(51);
  });
  it("expired reservations release", () => {
    const stale = { ...live, expiresAt: new Date(Date.now() - 1000) };
    expect(isReservationLive(stale)).toBe(false);
    expect(reservationConflict({ reservation: stale, myStartupId: null, myPriorTotal: 0, addUsd: 100 }).conflict).toBe(false);
  });
});

// ---- integration (local test DB only; skipped elsewhere) ----

import { hasTestDb, purgeSettledOutbox, testPrisma } from "./testDb"; // must stay after pure imports? No — first is fine too; guard only.
import { settlePayment } from "./settle";
import { enqueueOutbox } from "./outbox";
import { PaymentStatus } from "@prisma/client";

const prisma = testPrisma();
const hasDb = hasTestDb;
const T4 = 9996;

beforeAll(async () => {
  if (!hasDb) return;
  await prisma.stake.deleteMany({ where: { elementId: T4 } });
  await prisma.element.upsert({
    where: { id: T4 },
    create: { id: T4, symbol: "TST4", name: "Test TST4", atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
    update: {},
  });
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
  const domains = ["settle-t.dev", "settle2-t.dev"];
  await prisma.providerEvent.deleteMany({ where: { payment: { startup: { domain: { in: domains } } } } });
  await purgeSettledOutbox(prisma, { startup: { domain: { in: domains } } });
  await prisma.activityLog.deleteMany({ where: { domain: { in: domains } } });
  await prisma.claimReservation.deleteMany({ where: { startup: { domain: { in: domains } } } });
  await prisma.payment.deleteMany({ where: { startup: { domain: { in: domains } } } });
  await prisma.auditLog.deleteMany({ where: { startup: { domain: { in: domains } } } });
  await prisma.firstClaim.deleteMany({ where: { elementId: T4 } });
  await prisma.stake.deleteMany({ where: { elementId: T4 } });
  await prisma.element.deleteMany({ where: { id: T4 } });
  await prisma.startup.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
});

async function fixtureStartup(domain: string) {
  return prisma.startup.upsert({
    where: { domain },
    create: { domain, title: domain, pitch: "settle fixture pitch", url: `https://${domain}`, logoUrl: "x" },
    update: {},
  });
}

describe.skipIf(!hasDb)("atomic settle (P0-02)", () => {
  it("paid settle applies stake + links payment + enqueues outbox in one commit", async () => {
    const s = await fixtureStartup("settle-t.dev");
    const payment = await prisma.payment.create({
      data: { elementId: T4, startupId: s.id, amountUsd: 5, path: "JOIN", provider: "DEV", idempotencyKey: `settle-t-1-${Date.now()}`, status: "PENDING", email: "settle-t@example.com" },
    });
    const out = await settlePayment(payment.id, { provider: "dev", eventId: `dev-settle-t-1-${Date.now()}`, eventType: "dev.test", paid: true });
    expect(out.outcome).toBe("applied");
    const fresh = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(fresh.status).toBe(PaymentStatus.PAID);
    expect(fresh.stakeId).not.toBeNull();
    expect(fresh.appliedAt).not.toBeNull();
    const stake = await prisma.stake.findUniqueOrThrow({ where: { elementId_startupId: { elementId: T4, startupId: s.id } } });
    expect(stake.amountUsd).toBe(5);
    expect(stake.isLeader).toBe(true);
    const outbox = await prisma.outboxEvent.findMany({ where: { dedupeKey: { startsWith: "receipt-" } } });
    expect(outbox.some((o) => o.dedupeKey === `receipt-${payment.id}`)).toBe(true);
  });
  it("same event twice applies once (duplicate guard)", async () => {
    const s = await fixtureStartup("settle2-t.dev");
    const payment = await prisma.payment.create({
      data: { elementId: T4, startupId: s.id, amountUsd: 5, path: "JOIN", provider: "DEV", idempotencyKey: `settle-t-2-${Date.now()}`, status: "PENDING" },
    });
    const event = { provider: "dev" as const, eventId: `dev-settle-t-2-${Date.now()}`, eventType: "dev.test", paid: true };
    expect((await settlePayment(payment.id, event)).outcome).toBe("applied");
    expect((await settlePayment(payment.id, event)).outcome).toBe("duplicate");
    const stakes = await prisma.stake.findMany({ where: { elementId: T4, startupId: s.id } });
    expect(stakes.length).toBe(1);
    expect(stakes[0].amountUsd).toBe(5);
  });
  it("failed events mark failed without staking", async () => {
    const s = await fixtureStartup("settle2-t.dev");
    const payment = await prisma.payment.create({
      data: { elementId: T4, startupId: s.id, amountUsd: 7, path: "JOIN", provider: "DEV", idempotencyKey: `settle-t-3-${Date.now()}`, status: "PENDING" },
    });
    const out = await settlePayment(payment.id, { provider: "dev", eventId: `dev-settle-t-3-${Date.now()}`, eventType: "dev.fail", paid: false });
    expect(out.outcome).toBe("failed");
    // The earlier $5 stake from the previous test is untouched (no $7 added).
    const stake = await prisma.stake.findUnique({ where: { elementId_startupId: { elementId: T4, startupId: s.id } } });
    expect(stake?.amountUsd).toBe(5);
  });
  it("expired reservations settle as ordinary stakes (no guaranteed crown)", async () => {
    const s = await fixtureStartup("settle-t.dev");
    const payment = await prisma.payment.create({
      data: { elementId: T4, startupId: s.id, amountUsd: 50, path: "TAKE", provider: "DEV", idempotencyKey: `settle-t-4-${Date.now()}`, status: "PENDING" },
    });
    await prisma.claimReservation.create({
      data: {
        elementId: T4,
        startupId: s.id,
        paymentId: payment.id,
        quotedLeaderTotal: 5,
        reservedTotal: 6,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const out = await settlePayment(payment.id, { provider: "dev", eventId: `dev-settle-t-4-${Date.now()}`, eventType: "dev.test", paid: true });
    expect(out.outcome).toBe("applied");
    const res = await prisma.claimReservation.findUniqueOrThrow({ where: { paymentId: payment.id } });
    expect(String(res.status)).toBe("EXPIRED");
    const stake = await prisma.stake.findUniqueOrThrow({ where: { elementId_startupId: { elementId: T4, startupId: s.id } } });
    expect(stake.amountUsd).toBe(55); // prior 5 + 50 applied as equity
  });
  it("outbox enqueue is idempotent per dedupe key", async () => {
    await prisma.$transaction(async (tx) => {
      await enqueueOutbox(tx, { type: "STAKE_ANALYTICS", dedupeKey: "settle-t-dedupe", payload: { a: 1 } });
      await enqueueOutbox(tx, { type: "STAKE_ANALYTICS", dedupeKey: "settle-t-dedupe", payload: { a: 1 } });
    });
    expect(await prisma.outboxEvent.count({ where: { dedupeKey: "settle-t-dedupe" } })).toBe(1);
    await prisma.outboxEvent.deleteMany({ where: { dedupeKey: "settle-t-dedupe" } });
  });
  it("a redelivery after a retryable failure still settles", async () => {
    const s = await fixtureStartup("settle-t.dev");
    const eventId = `dev-settle-t-retry-${Date.now()}`;
    const payment = await prisma.payment.create({
      data: { elementId: T4, startupId: s.id, amountUsd: 4, path: "RECLAIM", provider: "DEV", idempotencyKey: `settle-t-retry-${Date.now()}`, status: "PENDING" },
    });
    const before = await prisma.stake.findUniqueOrThrow({ where: { elementId_startupId: { elementId: T4, startupId: s.id } } });
    // Reconstructed post-failure state: the transaction rolled back (no stake,
    // payment still PENDING) and the catch recorded the reason before the
    // webhook answered non-2xx, which is what invites the provider's redelivery.
    await prisma.providerEvent.create({
      data: {
        provider: "DEV",
        providerEventId: eventId,
        eventType: "dev.test",
        paymentId: payment.id,
        outcome: "ERROR",
        detail: "Transaction API error: Transaction not found. Transaction ID is invalid…",
      },
    });
    const out = await settlePayment(payment.id, { provider: "dev", eventId, eventType: "dev.test", paid: true });
    expect(out.outcome).toBe("applied");
    const fresh = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(fresh.status).toBe(PaymentStatus.PAID);
    expect(fresh.stakeId).not.toBeNull();
    // The failed attempt's record is promoted, not duplicated: one row per delivery.
    expect((await prisma.providerEvent.findUniqueOrThrow({ where: { providerEventId: eventId } })).outcome).toBe("APPLIED");
    const stake = await prisma.stake.findUniqueOrThrow({ where: { elementId_startupId: { elementId: T4, startupId: s.id } } });
    expect(stake.amountUsd).toBe(before.amountUsd + 4);
  });
});
