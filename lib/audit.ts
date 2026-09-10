/** Append-only audit trail (Phase 1). Every profile, management, waitlist,
 * and checkout mutation writes one row; notification/worker delivery never
 * blocks on it (best-effort within the request, failures are swallowed after
 * a console error so audit can never break money paths).
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
    console.error("auditLog write failed (non-blocking):", e);
  }
}
