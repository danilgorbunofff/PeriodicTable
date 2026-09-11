/** Append-only audit trail (Phase 1). Every profile, management, waitlist,
 * and checkout mutation writes one row. Failures are best-effort: outside a
 * transaction they are swallowed after a console error, so a bare audit write
 * can never break a caller.
 *
 * Inside a transaction they MUST propagate. Postgres aborts the whole
 * transaction on any failed statement, so a swallowed error there does not
 * "continue anyway" — it just moves the failure to the *next* statement, which
 * raises 25P02 ("current transaction is aborted, commands ignored until end of
 * transaction block"). 25P02 is neither retryable nor diagnosable: a retryable
 * serialization conflict becomes a hard 500, and the real cause is hidden in a
 * "non-blocking" log line. Throwing lets the transaction be retried intact.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export type AuditAction =
  | "STARTUP_CREATED"
  | "CHECKOUT_STARTED"
  | "MANAGE_LINK_REQUESTED"
  | "MANAGE_LINK_CONSUMED"
  | "PROFILE_UPDATED"
  | "WAITLIST_JOINED"
  | "REPORT_TRIAGED"
  | "PROFILE_MODERATED"
  | "PAYMENT_REVERSED";

export async function audit(
  entry: {
    action: AuditAction;
    startupId?: string | null;
    actorType?: "system" | "owner" | "operator";
    actorRef?: string | null;
    elementId?: number | null;
    paymentId?: string | null;
    detail?: string | null;
  },
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action: entry.action,
        startupId: entry.startupId ?? null,
        actorType: entry.actorType ?? "system",
        actorRef: entry.actorRef ?? null,
        elementId: entry.elementId ?? null,
        paymentId: entry.paymentId ?? null,
        detail: entry.detail ?? null,
      },
    });
  } catch (e) {
    if (db !== prisma) throw e;
    console.error("auditLog write failed (non-blocking):", e);
  }
}
