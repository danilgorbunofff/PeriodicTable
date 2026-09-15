/* R08-5 against a live database (TST8/9988 fixtures, fully cleaned up).
   The pure eligibility rule and the job's contract are pinned without a DB in
   lib/phase8.test.ts; this file is the one place that proves the sweep moves a
   real row to CANCELED, refuses every row that could still settle, and leaves
   the reservation alone. */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { CHECKOUT_ABANDON_TTL_MS, sweepAbandonedCheckouts } from "./abandonedCheckouts";
import { POST as abandonPOST } from "../app/api/jobs/abandoned-checkouts/route";
import { PaymentStatus, ReservationStatus } from "@prisma/client";

const prisma = testPrisma();
const hasDb = hasTestDb;
const T88 = 9988;
const DOMAIN = "abandon8-t.dev";
const HOUR = 3_600_000;
let keyN = 0;

beforeAll(async () => {
  if (!hasDb) return;
  await prisma.element.upsert({
    where: { id: T88 },
    create: { id: T88, symbol: "TST8", name: "Test TST8", atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
    update: {},
  });
  await prisma.startup.upsert({
    where: { domain: DOMAIN },
    create: { domain: DOMAIN, title: "Abandon 8", pitch: "sweep fixture pitch", url: `https://${DOMAIN}`, logoUrl: "x" },
    update: {},
  });
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
  const scope = { startup: { domain: DOMAIN } };
  await prisma.auditLog.deleteMany({ where: scope });
  await prisma.claimReservation.deleteMany({ where: scope });
  await prisma.providerEvent.deleteMany({ where: { payment: scope } });
  await prisma.payment.deleteMany({ where: scope });
  await prisma.element.deleteMany({ where: { id: T88 } });
  await prisma.startup.deleteMany({ where: { domain: DOMAIN } });
  await prisma.$disconnect();
});

async function fixturePayment(opts: {
  hoursOld: number;
  status?: PaymentStatus;
  url?: string | null;
  ref?: string | null;
}): Promise<{ id: string }> {
  const startup = await prisma.startup.findUniqueOrThrow({ where: { domain: DOMAIN } });
  return prisma.payment.create({
    data: {
      elementId: T88,
      startupId: startup.id,
      amountUsd: 5,
      path: "JOIN",
      provider: "DEV",
      idempotencyKey: `abandon8-${Date.now()}-${keyN++}`,
      status: opts.status ?? PaymentStatus.PENDING,
      providerCheckoutUrl: opts.url ?? null,
      providerRef: opts.ref ?? null,
      email: "abandon8@example.com",
      createdAt: new Date(Date.now() - opts.hoursOld * HOUR),
    },
    select: { id: true },
  });
}

const read = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });

describe.skipIf(!hasDb)("abandoned checkout sweep (R08-5)", () => {
  it("cancels a PENDING row that never reached a provider, and audits it", async () => {
    const payment = await fixturePayment({ hoursOld: 30 });

    const { canceled, candidates, cutoff } = await sweepAbandonedCheckouts();

    expect(canceled).toContain(payment.id);
    expect(candidates).toBeGreaterThan(0);
    // The cutoff the caller reports is the horizon it applied, not "now".
    expect(Date.now() - cutoff.getTime()).toBeGreaterThan(CHECKOUT_ABANDON_TTL_MS);
    const row = await read(payment.id);
    expect(row.status).toBe(PaymentStatus.CANCELED);
    expect(row.failedAt).not.toBeNull();
    // Nothing about the money moved: this row never had a provider session.
    expect(row.stakeId).toBeNull();
    expect(row.paidAt).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { paymentId: payment.id, action: "CHECKOUT_ABANDONED" } });
    expect(audit).not.toBeNull();
    expect(audit?.detail ?? "").toContain("24h");
  });

  it("leaves a checkout that carries a provider session, however old", async () => {
    // A buyer can still be at that page: the 25-hour-old session URL is still
    // resumable, and a delivery for it has to find a PENDING payment.
    const payment = await fixturePayment({ hoursOld: 40, url: "https://checkout.stripe.example/cs_abandon8_1" });

    const { canceled } = await sweepAbandonedCheckouts();

    expect(canceled).not.toContain(payment.id);
    expect((await read(payment.id)).status).toBe(PaymentStatus.PENDING);
  });

  it("leaves a row that already has a provider reference", async () => {
    const payment = await fixturePayment({ hoursOld: 40, ref: `cs_abandon8_ref_${Date.now()}` });

    const { canceled } = await sweepAbandonedCheckouts();

    expect(canceled).not.toContain(payment.id);
    expect((await read(payment.id)).status).toBe(PaymentStatus.PENDING);
  });

  it("ignores a row inside the horizon and any row that is not PENDING", async () => {
    const young = await fixturePayment({ hoursOld: 1 });
    const paid = await fixturePayment({ hoursOld: 30, status: PaymentStatus.PAID });
    const canceledAlready = await fixturePayment({ hoursOld: 30, status: PaymentStatus.CANCELED });

    const { canceled } = await sweepAbandonedCheckouts();

    expect(canceled).not.toContain(young.id);
    expect(canceled).not.toContain(paid.id);
    expect(canceled).not.toContain(canceledAlready.id);
    expect((await read(paid.id)).status).toBe(PaymentStatus.PAID);
    expect((await read(canceledAlready.id)).status).toBe(PaymentStatus.CANCELED);
  });

  it("is bounded and takes the oldest first, and a replay cancels nothing", async () => {
    const oldest = await fixturePayment({ hoursOld: 30 });
    const middle = await fixturePayment({ hoursOld: 28 });
    const newest = await fixturePayment({ hoursOld: 26 });

    const first = await sweepAbandonedCheckouts({ limit: 1 });
    expect(first.canceled).toEqual([oldest.id]);
    expect((await read(middle.id)).status).toBe(PaymentStatus.PENDING);

    const second = await sweepAbandonedCheckouts({ limit: 5 });
    expect(second.canceled).toEqual(expect.arrayContaining([middle.id, newest.id]));

    // Every candidate is already terminal, so a third pass has nothing to do.
    expect((await sweepAbandonedCheckouts({ limit: 50 })).canceled).toEqual([]);
  });

  it("leaves an expired reservation for its own TTL instead of editing it", async () => {
    const payment = await fixturePayment({ hoursOld: 30 });
    const startup = await prisma.startup.findUniqueOrThrow({ where: { domain: DOMAIN } });
    const expiresAt = new Date(Date.now() - 5 * HOUR);
    await prisma.claimReservation.create({
      data: {
        elementId: T88,
        startupId: startup.id,
        paymentId: payment.id,
        quotedLeaderTotal: 0,
        quotedLeaderStartupId: null,
        reservedTotal: 5,
        status: ReservationStatus.ACTIVE,
        expiresAt,
      },
    });

    const { canceled } = await sweepAbandonedCheckouts();

    expect(canceled).toContain(payment.id);
    const reservation = await prisma.claimReservation.findUniqueOrThrow({ where: { paymentId: payment.id } });
    expect(reservation.status).toBe(ReservationStatus.ACTIVE);
    expect(reservation.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it("sweeps through the job route", async () => {
    const payment = await fixturePayment({ hoursOld: 30 });

    const res = await abandonPOST(
      new NextRequest("http://localhost/api/jobs/abandoned-checkouts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 10 }),
      })
    );
    const json = (await res.json()) as { ok: boolean; canceled: number; ids: string[]; cutoff: string };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.canceled).toBeGreaterThanOrEqual(1);
    expect(json.ids).toContain(payment.id);
    expect(Date.parse(json.cutoff)).toBeLessThan(Date.now() - CHECKOUT_ABANDON_TTL_MS / 2);
    expect((await read(payment.id)).status).toBe(PaymentStatus.CANCELED);
  });
});
