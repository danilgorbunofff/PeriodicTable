import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminGate } from "@/lib/jobs";
import { apiJson, apiError, apiRoute } from "@/lib/route";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({
  POST: retryOutbox,
});

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
 *
 * R13-1: two different histories answer 409 with the same code — the provider
 * accepted the mail, or `deliver()` returned `logged` because the process had no
 * RESEND_API_KEY and nothing reached the buyer. The refusal therefore names what
 * the register saw for the key (`delivery`), because the queue alone cannot: both
 * rows are completed with zero attempts.
 *
 * R14-9: the reset is audited (`OUTBOX_RETRY`), with the operator's name when the
 * body carries one. A retry is the one privileged action here whose effect is
 * that mail goes out, so a leaked ADMIN_TOKEN used to resend receipts must not be
 * the one operator action with no row in the trail.
 */
async function retryOutbox(req: NextRequest) {
  const denied = await adminGate(req, "admin/outbox/retry");
  if (denied) return denied;
  let body: { dedupeKey?: string; operator?: string };
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body.", { status: 400 });
  }
  if (!body.dedupeKey)
    return apiError("dedupeKey is required.", { status: 400 });

  const operator = typeof body.operator === "string" ? body.operator.slice(0, 120) : "operator";
  const row = await prisma.outboxEvent.findUnique({
    where: { dedupeKey: body.dedupeKey },
  });
  if (!row)
    return apiError("Outbox event not found.", {
      status: 404,
      code: "NOT_FOUND",
    });
  if (row.completedAt && row.attempts > 0) {
    return apiError("Already delivered.", {
      status: 409,
      code: "ALREADY_DONE",
    });
  }
  if (row.completedAt) {
    const failedLog = await prisma.emailLog.findFirst({
      where: { dedupeKey: row.dedupeKey, status: "error" },
      select: { id: true },
    });
    if (!failedLog) {
      // Only the log can separate the cases that reach this refusal, so the
      // newest row for the key is reported verbatim: `logged` was rehearsed,
      // `sent` was accepted by the provider, `suppressed:<reason>` was withheld
      // on purpose, and `none` means the register has no row for this key at all
      // — which is its own surprise. `createdAt` alone ties within a
      // millisecond, so `id` breaks it: the answer must not depend on row order.
      const newest = await prisma.emailLog.findFirst({
        where: { dedupeKey: row.dedupeKey },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { status: true },
      });
      return apiJson(
        {
          error: "Already delivered.",
          code: "ALREADY_DONE",
          delivery: newest?.status ?? "none",
        },
        { status: 409 },
      );
    }
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
  // R14-9: written after the reset, so the row records a retry that happened.
  // The key leads the detail because it is what an operator greps for.
  await audit({
    action: "OUTBOX_RETRY",
    actorType: "operator",
    actorRef: operator,
    detail: `${reset.dedupeKey} ${reset.type}${row.completedAt ? " (completed row revived)" : ""}`.slice(0, 300),
  });
  return apiJson({ ok: true, dedupeKey: reset.dedupeKey, type: reset.type });
}
