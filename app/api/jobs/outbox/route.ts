import { NextRequest } from "next/server";
import { jobGate } from "@/lib/jobs";
import { drainInBatches, outboxHealth } from "@/lib/outbox";
import { JOB_WORK_BUDGET_MS, jobLimit } from "@/lib/jobBudget";
import { stampHeartbeat } from "@/lib/jobHeartbeat";
import { apiJson, apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({
  GET: getOutboxStatus,
  POST: runOutbox,
});

/**
 * Outbox worker (Phase 6): receipt/outbid email, preview generation, and
 * analytics drain from durable rows. Authenticated (P1-15), bounded batch
 * (default 5, max 25), whole work budget reserved up front (24 s of the 30 s
 * `maxDuration`; lib/jobBudget.ts).
 *
 * Every delivery carries its dedupe key with exponential backoff; terminal
 * failures persist lastError for the operator retry endpoint.
 *
 * Phase 13 changed three things the review measured (R13-5/R13-6/R13-7):
 * - the loop claims *batches* until the budget or the queue runs out, instead of
 *   one batch per invocation, so a backlog drains at the cadence of its schedule
 *   rather than at the cadence of the scheduler (the tick's nominal ten minutes
 *   was 3 h 12 m median in practice, 6 h 40 m worst);
 * - the claim runs inside the drain's try, so a batch that could not be claimed
 *   is `errors: 1` and an HTTP 500 — not a `{completed: 0, failed: 0}` that reads
 *   like an empty queue;
 * - `remaining` says how many rows a *next* call would find, which is what lets
 *   the tick decide to call again instead of guessing from a short batch.
 *
 * Phase 18 adds the queue itself (R18-8). Everything above describes what this
 * invocation *did*, and `claimed: 0` cannot be told apart from a healthy empty
 * queue when the backlog is simply not due yet: a row at attempt 2 is invisible
 * for up to five minutes, so the same body that means "nothing to do" also means
 * "40 receipts are waiting on their backoff" — and the second reading is the one
 * an operator needed at launch. `queue` is the durable answer, read after the
 * drain: `pending` is every undelivered row whatever its backoff says (the
 * number that only goes down by delivering something, and the one an alarm
 * should compare between consecutive ticks), `due` is what a next call would
 * claim right now, `exhausted` and `failed` are the two states no worker will
 * ever clear, and `oldestPendingMinutes` is how long the oldest row has waited.
 *
 * It is nested rather than flattened because `failed` means two different things
 * here — rows this invocation failed, versus mail that failed and was never
 * superseded — and a single flat key would silently report one as the other.
 */
async function runOutbox(req: NextRequest) {
  let body: { secret?: string; limit?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const denied = await jobGate(req, "jobs/outbox", body.secret ?? null);
  if (denied) return denied;

  const limit = jobLimit(req, body, 5, 25);
  const out = await drainInBatches({ limit, budgetMs: JOB_WORK_BUDGET_MS });
  await stampHeartbeat("/api/jobs/outbox", out.errors ? "batch failed" : null);
  const queue = await outboxHealth();

  const counts = {
    claimed: out.claimed,
    completed: out.completed,
    failed: out.failed,
    skipped: out.skipped,
    deferred: out.deferred,
    batches: out.batches,
    remaining: out.remaining,
    queue: {
      driver: queue.driver,
      pending: queue.pending,
      due: queue.due,
      exhausted: queue.exhausted,
      failed: queue.failed,
      pendingByType: queue.pendingByType,
      oldestPendingMinutes: queue.oldestPendingMinutes,
      lastDeliveredAt: queue.lastDeliveredAt,
    },
  };
  // The numbers stay in the body on the failure path: they are the report. The
  // status is the signal, so a CLI running `curl -fsS` fails on a batch that
  // could not be claimed (R13-6).
  if (out.errors > 0) {
    return apiJson(
      {
        ok: false,
        error: "outbox batch failed",
        code: "INTERNAL",
        errors: out.errors,
        ...counts,
      },
      { status: 500 },
    );
  }
  return apiJson({ ok: true, errors: 0, ...counts });
}

/** Vercel Cron invokes the path with GET (see vercel.json): same auth, and the
 *  batch comes from `?limit=` because a GET carries no body. */
async function getOutboxStatus(req: NextRequest) {
  return runOutbox(req);
}
