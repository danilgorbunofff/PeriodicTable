import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminGate } from "@/lib/jobs";
import { apiJson, apiError, apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ POST: retryOutbox });

/**
 * Operator retry for a terminally-failed outbox delivery (Phase 6 item 3):
 * resets attempts/backoff so the next worker pass redelivers. Refuses rows
 * that are already complete or never failed.
 *
 * R10-1: a *completed* row with `attempts === 0` is not necessarily a delivered
 * mail. Every failed attempt increments `attempts` (processOutboxRowById), and
 * the mail senders used to report failure without throwing, so a provider
 * refusal was stamped complete having never been retried. Such a row — completed,
 * zero attempts — is exactly the "the send failed and nobody noticed" case the
 * operator is here to fix, so it is retryable, *provided the log agrees*: the
 * revival requires an `EmailLog` row with `status = "error"` for the same dedupe
 * key. Without that check the operator could not tell the bug's row from an
 * ordinary successful delivery (which is also completed with zero attempts) and
 * the "fix" would be a way to send receipts twice. A completed row that *did*
 * burn attempts through the retry ladder is refused as before: it was already
 * redelivered up to OUTBOX_MAX_ATTEMPTS times.
 */
async function retryOutbox(req: NextRequest) {
  const denied = await adminGate(req, "admin/outbox/retry");
  if (denied) return denied;
  let body: { dedupeKey?: string };
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body.", { status: 400 });
  }
  if (!body.dedupeKey) return apiError("dedupeKey is required.", { status: 400 });
  const row = await prisma.outboxEvent.findUnique({ where: { dedupeKey: body.dedupeKey } });
  if (!row) return apiError("Outbox event not found.", { status: 404, code: "NOT_FOUND" });
  if (row.completedAt && row.attempts > 0) {
    return apiError("Already delivered.", { status: 409, code: "ALREADY_DONE" });
  }
  if (row.completedAt) {
    const failedLog = await prisma.emailLog.findFirst({
      where: { dedupeKey: row.dedupeKey, status: "error" },
      select: { id: true },
    });
    if (!failedLog) return apiError("Already delivered.", { status: 409, code: "ALREADY_DONE" });
  }
  const reset = await prisma.outboxEvent.update({
    where: { dedupeKey: body.dedupeKey },
    data: {
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      // A completed-but-never-retried row is put back in flight; leaving
      // completedAt set would make the worker skip it (processOutboxRowById).
      ...(row.completedAt ? { completedAt: null } : {}),
    },
  });
  return apiJson({ ok: true, dedupeKey: reset.dedupeKey, type: reset.type });
}
