/* Phase 2 take-lead reservations (P0-05), extended by R09-1/R09-2.
   Pure: the conflict rule — who a live quote blocks, who it never blocks, and
   the boundary the caller has to distinguish from a plain tie refusal.
   Integration (local test DB): the three helpers the checkout, detail and
   settle paths share, including the lazily released expired row. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  RESERVATION_TTL_MS,
  consumeReservation,
  getActiveReservation,
  isReservationLive,
  releaseExpiredReservations,
  reservationConflict,
  type ActiveReservation,
} from "./reservations";

const NOW = Date.now();
const at = (offsetMs: number) => new Date(NOW + offsetMs);
const reservation = (over: Partial<ActiveReservation> = {}): ActiveReservation => ({
  id: "res-1",
  startupId: "owner-startup",
  paymentId: "payment-1",
  reservedTotal: 26,
  expiresAt: at(60_000),
  ...over,
});

describe("isReservationLive", () => {
  it("treats a missing row as free and a future expiry as held", () => {
    expect(isReservationLive(null)).toBe(false);
    expect(isReservationLive({ expiresAt: at(60_000) })).toBe(true);
  });
  it("expires exactly at the expiry instant, not after it", () => {
    expect(isReservationLive({ expiresAt: at(0) }, NOW)).toBe(false);
    expect(isReservationLive({ expiresAt: at(-1) }, NOW)).toBe(false);
    expect(isReservationLive({ expiresAt: at(1) }, NOW)).toBe(true);
  });
});

describe("reservationConflict", () => {
  it("never blocks when nothing is held or the hold has lapsed", () => {
    expect(reservationConflict({ reservation: null, myStartupId: null, myPriorTotal: 0, addUsd: 5000 })).toEqual({
      conflict: false,
    });
    expect(
      reservationConflict({
        reservation: reservation({ reservedTotal: 6, expiresAt: at(-1) }),
        myStartupId: null,
        myPriorTotal: 0,
        addUsd: 5000,
        now: NOW,
      })
    ).toEqual({ conflict: false });
  });
  it("blocks another startup exactly at the reserved total, and above it", () => {
    const held = reservationConflict({
      reservation: reservation(),
      myStartupId: "other-startup",
      myPriorTotal: 0,
      addUsd: 26,
      now: NOW,
    });
    expect(held).toEqual({ conflict: true, reservedTotal: 26, expiresAt: at(60_000) });
    expect(
      reservationConflict({
        reservation: reservation(),
        myStartupId: "other-startup",
        myPriorTotal: 0,
        addUsd: 27,
        now: NOW,
      })
    ).toMatchObject({ conflict: true });
  });
  it("lets a losing amount through: only the reserved total is out of reach", () => {
    expect(
      reservationConflict({
        reservation: reservation(),
        myStartupId: "other-startup",
        myPriorTotal: 0,
        addUsd: 25,
        now: NOW,
      })
    ).toEqual({ conflict: false });
    // An exact tie with a row already on the board is the tie rule's business,
    // not the hold's (R09-1): this function only speaks for the quote.
    expect(
      reservationConflict({
        reservation: reservation(),
        myStartupId: "other-startup",
        myPriorTotal: 12,
        addUsd: 1,
        now: NOW,
      })
    ).toEqual({ conflict: false });
  });
  it("counts what the bidder already holds toward the resulting total", () => {
    expect(
      reservationConflict({
        reservation: reservation(),
        myStartupId: "other-startup",
        myPriorTotal: 20,
        addUsd: 6,
        now: NOW,
      })
    ).toMatchObject({ conflict: true });
    expect(
      reservationConflict({
        reservation: reservation(),
        myStartupId: "other-startup",
        myPriorTotal: 20,
        addUsd: 5,
        now: NOW,
      })
    ).toEqual({ conflict: false });
  });
  it("blocks a brand-new startup at the reserved total", () => {
    expect(
      reservationConflict({
        reservation: reservation({ reservedTotal: 6 }),
        myStartupId: null,
        myPriorTotal: 0,
        addUsd: 6,
        now: NOW,
      })
    ).toMatchObject({ conflict: true });
    expect(
      reservationConflict({
        reservation: reservation({ reservedTotal: 6 }),
        myStartupId: null,
        myPriorTotal: 0,
        addUsd: 5,
        now: NOW,
      })
    ).toEqual({ conflict: false });
  });
  it("never blocks the startup that owns the quote", () => {
    expect(
      reservationConflict({
        reservation: reservation(),
        myStartupId: "owner-startup",
        myPriorTotal: 25,
        addUsd: 5000,
        now: NOW,
      })
    ).toEqual({ conflict: false });
  });
  it("reports the quote's own numbers so the payload can echo them", () => {
    const expiry = at(90_000);
    const conflict = reservationConflict({
      reservation: reservation({ reservedTotal: 74, expiresAt: expiry }),
      myStartupId: null,
      myPriorTotal: 0,
      addUsd: 74,
      now: NOW,
    });
    expect(conflict).toEqual({ conflict: true, reservedTotal: 74, expiresAt: expiry });
  });
});

describe("RESERVATION_TTL_MS", () => {
  it("is a sane positive window (15 minutes unless the rehearsal overrides it)", () => {
    expect(Number.isInteger(RESERVATION_TTL_MS)).toBe(true);
    expect(RESERVATION_TTL_MS).toBeGreaterThanOrEqual(1000);
  });
});

/* Phase 2 reservation helpers, on the local test DB. Element ids below 10000
   are reserved for fixtures (9999 down); 9987 is this file's. */
import { hasTestDb, testPrisma } from "./testDb";

const prisma = testPrisma();
const hasDb = hasTestDb;
const T7 = 9987;
const DOMAIN = "resv-t.dev";
const paymentIds: string[] = [];
let keyN = 0;
const key = () => `p2-resv-${Date.now()}-${keyN++}`;

beforeAll(async () => {
  if (!hasDb) return;
  await prisma.claimReservation.deleteMany({ where: { elementId: T7 } });
  await prisma.element.upsert({
    where: { id: T7 },
    create: {
      id: T7,
      symbol: "TST7",
      name: "Test Seven",
      atomicMass: "0",
      gridRow: 0,
      gridCol: 0,
      family: "EXOTIC_THEORETICAL",
      tier: "EXOTIC",
    },
    update: {},
  });
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
  await prisma.claimReservation.deleteMany({ where: { elementId: T7 } });
  await prisma.providerEvent.deleteMany({ where: { payment: { startup: { domain: DOMAIN } } } });
  await prisma.payment.deleteMany({ where: { startup: { domain: DOMAIN } } });
  await prisma.stake.deleteMany({ where: { elementId: T7 } });
  await prisma.firstClaim.deleteMany({ where: { elementId: T7 } });
  await prisma.element.deleteMany({ where: { id: T7 } });
  await prisma.startup.deleteMany({ where: { domain: DOMAIN } });
  await prisma.$disconnect();
});

async function hold(expiresInMs: number) {
  const startup = await prisma.startup.upsert({
    where: { domain: DOMAIN },
    create: { domain: DOMAIN, title: DOMAIN, pitch: "reservation fixture pitch", url: `https://${DOMAIN}`, logoUrl: "x" },
    update: {},
  });
  // Only one row may be ACTIVE per element (partial unique index), so a test
  // that wants a live hold re-dates whatever the previous test left behind.
  const existing = await prisma.claimReservation.findFirst({ where: { elementId: T7, status: "ACTIVE" } });
  if (existing) {
    const row = await prisma.claimReservation.update({
      where: { id: existing.id },
      data: { expiresAt: new Date(Date.now() + expiresInMs) },
    });
    return { startup, paymentId: row.paymentId, row };
  }
  const payment = await prisma.payment.create({
    data: {
      elementId: T7,
      startupId: startup.id,
      amountUsd: 6,
      path: "TAKE",
      provider: "DEV",
      idempotencyKey: key(),
      status: "PENDING",
    },
  });
  paymentIds.push(payment.id);
  const row = await prisma.claimReservation.create({
    data: {
      elementId: T7,
      startupId: startup.id,
      paymentId: payment.id,
      quotedLeaderTotal: 5,
      quotedLeaderStartupId: null,
      reservedTotal: 6,
      expiresAt: new Date(Date.now() + expiresInMs),
    },
  });
  return { startup, paymentId: payment.id, row };
}

describe.skipIf(!hasDb)("reservation helpers", () => {
  it("reads the live hold and ignores the lapsed one (R09-1)", async () => {
    const { row } = await hold(10 * 60_000);
    const live = await getActiveReservation(prisma, T7);
    expect(live?.id).toBe(row.id);
    expect(live?.reservedTotal).toBe(6);

    await prisma.claimReservation.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect(await getActiveReservation(prisma, T7)).toBeNull();
  });

  it("releases only what has actually lapsed", async () => {
    const { row } = await hold(10 * 60_000);
    await releaseExpiredReservations(prisma, new Date());
    const untouched = await prisma.claimReservation.findUniqueOrThrow({ where: { id: row.id } });
    expect(untouched.status).toBe("ACTIVE");

    await prisma.claimReservation.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    await releaseExpiredReservations(prisma, new Date());
    const released = await prisma.claimReservation.findUniqueOrThrow({ where: { id: row.id } });
    expect(released.status).toBe("EXPIRED");
    expect(await getActiveReservation(prisma, T7)).toBeNull();
  });

  it("consumes a hold on settle and frees the element for the next quote", async () => {
    const { row } = await hold(10 * 60_000);
    await consumeReservation(prisma, row.id);
    const consumed = await prisma.claimReservation.findUniqueOrThrow({ where: { id: row.id } });
    expect(consumed.status).toBe("CONSUMED");
    expect(consumed.consumedAt).not.toBeNull();
    expect(await getActiveReservation(prisma, T7)).toBeNull();

    // The partial unique index only reserves the element while a row is
    // ACTIVE, so the next takeover quote can be minted right away (P0-05).
    const next = await hold(10 * 60_000);
    expect((await getActiveReservation(prisma, T7))?.id).toBe(next.row.id);
  });
});
