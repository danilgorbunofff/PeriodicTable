/* Phase 2 payment/webhook tests.
   Pure section (no DB): strict paid classification, money validation,
   reservation conflict rule, event-id stability.
   Integration section (needs local test DB): atomic settle, duplicate-event
   dedupe, statusless-event rejection path, reservation consume/expire. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  whopPayloadIsPaid,
  whopPayloadIsFailed,
  whopEventId,
  whopEventType,
  whopMoney,
  validateWhopMoney,
  getProviderMode,
} from "./whop";
import { reservationConflict, isReservationLive, RESERVATION_TTL_MS } from "./reservations";

describe("strict paid classification (P0-03)", () => {
  it("accepts explicit paid signals only", () => {
    expect(whopPayloadIsPaid({ data: { status: "succeeded" } })).toBe(true);
    expect(whopPayloadIsPaid({ data: { payment: { status: "completed" } } })).toBe(true);
    expect(whopPayloadIsPaid({ data: { checkout_session: { status: "paid" } } })).toBe(true);
    expect(whopPayloadIsPaid({ type: "checkout.session.completed" })).toBe(true);
  });
  it("rejects everything else, especially statusless payloads", () => {
    expect(whopPayloadIsPaid({})).toBe(false);
    expect(whopPayloadIsPaid(null)).toBe(false);
    expect(whopPayloadIsPaid({ data: {} })).toBe(false);
    expect(whopPayloadIsPaid({ event: "payment.updated", data: {} })).toBe(false);
    expect(whopPayloadIsPaid({ data: { status: "pending" } })).toBe(false);
    expect(whopPayloadIsPaid({ data: { status: "failed" } })).toBe(false);
    expect(whopPayloadIsPaid({ data: { status: "refunded" } })).toBe(false);
  });
  it("detects explicit failure signals only", () => {
    expect(whopPayloadIsFailed({ data: { status: "failed" } })).toBe(true);
    expect(whopPayloadIsFailed({ type: "payment.failed" })).toBe(true);
    expect(whopPayloadIsFailed({ data: { status: "expired" } })).toBe(true);
    expect(whopPayloadIsFailed({})).toBe(false);
    expect(whopPayloadIsFailed({ data: {} })).toBe(false);
    expect(whopPayloadIsFailed({ event: "payment.updated", data: {} })).toBe(false);
    expect(whopPayloadIsFailed({ data: { status: "pending" } })).toBe(false);
  });
});

describe("provider event identity", () => {
  it("prefers the provider id, falls back to a stable body hash", () => {
    expect(whopEventId({ id: "evt_1" }, "{}")).toBe("whop:evt_1");
    expect(whopEventId({ data: { id: "evt_2" } }, "{}")).toBe("whop:evt_2");
    const a = whopEventId({}, '{"a":1}');
    expect(a).toBe(whopEventId({}, '{"a":1}'));
    expect(a).not.toBe(whopEventId({}, '{"a":2}'));
  });
  it("reads event types from known shapes", () => {
    expect(whopEventType({ type: "payment.succeeded" })).toBe("payment.succeeded");
    expect(whopEventType({ event: "payment.failed" })).toBe("payment.failed");
    expect(whopEventType({})).toBe("unknown");
  });
});

describe("money validation", () => {
  it("accepts dollars or cents, ignores absent, rejects mismatch", () => {
    expect(validateWhopMoney(21, { amountUsd: 21, currency: "usd", providerRef: null })).toBeNull();
    expect(validateWhopMoney(21, { amountUsd: 2100, currency: "usd", providerRef: null })).toBeNull();
    expect(validateWhopMoney(21, { amountUsd: null, currency: null, providerRef: null })).toBeNull();
    expect(validateWhopMoney(21, { amountUsd: 22, currency: "usd", providerRef: null })).toMatch(/amount-mismatch/);
    expect(validateWhopMoney(21, { amountUsd: 21, currency: "eur", providerRef: null })).toMatch(/currency-mismatch/);
  });
  it("extracts money from known payload shapes", () => {
    expect(whopMoney({ data: { amount: 2100, currency: "USD", id: "cs_1" } })).toEqual({
      amountUsd: 2100,
      currency: "usd",
      providerRef: "cs_1",
    });
    expect(whopMoney({})).toEqual({ amountUsd: null, currency: null, providerRef: null });
  });
  it("provider mode is dev without full Whop config", () => {
    // CI/dev never sets Whop keys; production gating is covered by env tests.
    if (!process.env.WHOP_API_KEY || !process.env.WHOP_WEBHOOK_SECRET) {
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

import { hasTestDb, testPrisma } from "./testDb"; // must stay after pure imports? No — first is fine too; guard only.
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
  await prisma.outboxEvent.deleteMany({ where: { OR: [{ dedupeKey: { contains: "settle-t" } }, { dedupeKey: { contains: "settle2-t" } }] } });
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
});
