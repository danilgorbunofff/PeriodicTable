/**
 * Take-lead reservations (Phase 2, P0-05 + reservation semantics).
 *
 * A contested takeover quote is guaranteed through a short-lived ACTIVE
 * reservation: exactly one may own an element quote at a time (partial unique
 * index from migration 0001). Empty-tile first claims need no reservation —
 * concurrent $5 joins must both succeed (validation matrix: concurrency).
 *
 * Expiry is lazy: readers treat expired ACTIVE rows as released, and writers
 * mark them EXPIRED opportunistically. No sweeper required (Phase 6 may add one).
 */
import { Prisma, ReservationStatus } from "@prisma/client";

export const RESERVATION_TTL_MS = (() => {
  // Overridable for release rehearsal (scripts/rehearse-release.sh sets a
  // 2s TTL to exercise expiry); production default is 15 minutes.
  const raw = Number(process.env.RESERVATION_TTL_MS ?? "");
  return Number.isInteger(raw) && raw >= 1000 ? raw : 15 * 60_000;
})();

export type ActiveReservation = {
  id: string;
  startupId: string;
  paymentId: string;
  reservedTotal: number;
  expiresAt: Date;
};

export function isReservationLive(r: { expiresAt: Date } | null, now = Date.now()): boolean {
  return !!r && r.expiresAt.getTime() > now;
}

/**
 * Pure conflict rule (unit-tested). An ACTIVE reservation owned by another
 * startup blocks any stake whose RESULTING total reaches the reserved winning
 * total; the owner topping up never conflicts; anything below sails through.
 */
export function reservationConflict(params: {
  reservation: ActiveReservation | null;
  myStartupId: string | null; // null = brand-new startup
  myPriorTotal: number; // 0 for newcomers
  addUsd: number;
  now?: number;
}): { conflict: true; reservedTotal: number; expiresAt: Date } | { conflict: false } {
  const { reservation, myStartupId, myPriorTotal, addUsd, now } = params;
  if (!reservation || !isReservationLive(reservation, now)) return { conflict: false };
  if (myStartupId && reservation.startupId === myStartupId) return { conflict: false };
  if (myPriorTotal + addUsd >= reservation.reservedTotal) {
    return { conflict: true, reservedTotal: reservation.reservedTotal, expiresAt: reservation.expiresAt };
  }
  return { conflict: false };
}

/** Load the live ACTIVE reservation for an element (null when free/expired). */
export async function getActiveReservation(
  db: Prisma.TransactionClient,
  elementId: number,
  now = new Date()
): Promise<ActiveReservation | null> {
  const r = await db.claimReservation.findFirst({
    where: { elementId, status: ReservationStatus.ACTIVE },
    orderBy: { createdAt: "desc" },
  });
  if (!r || r.expiresAt.getTime() <= now.getTime()) return null;
  return { id: r.id, startupId: r.startupId, paymentId: r.paymentId, reservedTotal: r.reservedTotal, expiresAt: r.expiresAt };
}

/** Mark stale ACTIVE rows EXPIRED. Returns the count flipped. */
export async function releaseExpiredReservations(
  db: Prisma.TransactionClient,
  now = new Date()
): Promise<number> {
  const res = await db.claimReservation.updateMany({
    where: { status: ReservationStatus.ACTIVE, expiresAt: { lt: now } },
    data: { status: ReservationStatus.EXPIRED },
  });
  return res.count;
}

/** Consume a reservation after successful settlement (same tx as the stake). */
export async function consumeReservation(
  tx: Prisma.TransactionClient,
  reservationId: string
): Promise<void> {
  await tx.claimReservation.update({
    where: { id: reservationId },
    data: { status: ReservationStatus.CONSUMED, consumedAt: new Date() },
  });
}
