/**
 * Abandoned checkout sweep (R08-5).
 *
 * `PaymentStatus.CANCELED` existed in the schema and was never reachable: a
 * checkout the buyer closed left the row PENDING forever. Nothing was wrong
 * with the money (no provider session was ever created, so nothing can ever
 * settle it) but the row was indistinguishable from a checkout that might still
 * complete — it inflated the PENDING count the operator report reads, and any
 * future "settle everything pending" sweep would have found a row it could not
 * resolve.
 *
 * The eligibility rule is deliberately narrow and provider-agnostic:
 *   PENDING + no providerCheckoutUrl + no providerRef + older than the horizon.
 * A row that carries a session URL is NOT sweepable however old it is — a buyer
 * can still be at that page, and the delivery for a session created 25 hours
 * ago has to find a PENDING payment, not a cancelled one. Those rows are the
 * operator report's `stale` list instead.
 *
 * Age, not a timer: a row younger than the horizon may be a live checkout whose
 * create response is still in flight, and cancelling it out from under a buyer
 * mid-payment is the one mistake this sweep must not make.
 */
import { PaymentStatus } from "@prisma/client";
import { logInfo } from "./log";
import { prisma } from "./prisma";
import { audit } from "./audit";

/** 24 hours: Stripe's own checkout session expires after 24h, so a row with no
 *  session at all is long past any chance of one being created for it. */
export const CHECKOUT_ABANDON_TTL_MS = 24 * 60 * 60_000;

export const ABANDON_MAX_BATCH = 50;

/** Pure eligibility predicate (exported for tests). */
export function isAbandonable(
  payment: {
    status: PaymentStatus;
    providerCheckoutUrl: string | null;
    providerRef: string | null;
    createdAt: Date;
  },
  now: Date = new Date()
): boolean {
  if (payment.status !== PaymentStatus.PENDING) return false;
  if (payment.providerCheckoutUrl || payment.providerRef) return false;
  return payment.createdAt.getTime() < now.getTime() - CHECKOUT_ABANDON_TTL_MS;
}

export function abandonCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - CHECKOUT_ABANDON_TTL_MS);
}

/**
 * Cancel every eligible row, oldest first, bounded by `limit`.
 *
 * Each row is cancelled conditionally (`updateMany` with the status in the
 * WHERE) and audited only when it actually changed, so a concurrent settle
 * winning the race leaves the payment PAID and the sweep reports nothing for
 * it. No transaction spans rows: they are independent checkouts, and no ledger
 * invariant connects them.
 */
export async function sweepAbandonedCheckouts(
  options: { limit?: number; now?: Date } = {}
): Promise<{ canceled: string[]; cutoff: Date; candidates: number }> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? ABANDON_MAX_BATCH, 1), ABANDON_MAX_BATCH);
  const cutoff = abandonCutoff(now);

  // The predicate is applied here, not in the query, so the rule lives in one
  // place; the query only narrows to rows that could possibly qualify.
  const rows = await prisma.payment.findMany({
    where: {
      status: PaymentStatus.PENDING,
      providerCheckoutUrl: null,
      providerRef: null,
      createdAt: { lt: cutoff },
    },
    select: { id: true, status: true, providerCheckoutUrl: true, providerRef: true, createdAt: true, elementId: true, startupId: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const canceled: string[] = [];
  for (const row of rows) {
    if (!isAbandonable(row, now)) continue;
    // `failedAt` is the only "closed without money" timestamp this table has
    // (there is no canceledAt), and it is what settle's FAILED branch writes:
    // a report that reads it must not read a null as "still open".
    // Any reservation the row held is left to expire on its own TTL — an
    // expired hold is already a no-op for quoting and settling, and deleting
    // rows here would edit history the audit trail refers to.
    const updated = await prisma.payment.updateMany({
      where: { id: row.id, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.CANCELED, failedAt: now },
    });
    if (updated.count !== 1) continue;
    canceled.push(row.id);
    await audit({
      action: "CHECKOUT_ABANDONED",
      startupId: row.startupId,
      elementId: row.elementId,
      paymentId: row.id,
      detail: `no provider session after ${CHECKOUT_ABANDON_TTL_MS / 3_600_000}h`,
    });
  }

  if (canceled.length > 0) {
    logInfo("jobs", "abandoned-checkouts", { canceled: canceled.length, cutoff });
  }
  return { canceled, cutoff, candidates: rows.length };
}
