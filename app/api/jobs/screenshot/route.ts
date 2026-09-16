import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { jobGate } from "@/lib/jobs";
import { drainPreviews, previewCounts } from "@/lib/outbox";
import { JOB_WORK_BUDGET_MS, jobLimit } from "@/lib/jobBudget";
import { stampHeartbeat } from "@/lib/jobHeartbeat";
import { apiJson, apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({
  GET: getScreenshotStatus,
  POST: runScreenshot,
});

/**
 * Preview worker (Phase 6, P1-14/P1-15): persists Startup.previewImgUrl from
 * PREVIEW_GENERATE outbox rows (enqueued automatically on every paid stake).
 *
 * - Authenticated on every production invocation (P1-15) — no body-shape
 *   bypasses.
 * - Bounded: at most 10 targets per invocation, a 24 s work budget of the 30 s
 *   `maxDuration` (lib/jobBudget.ts), 10 s per-target probe (inside
 *   persistPreview; a cold Microlink render of an uncached site takes ~4 s, a
 *   cached one ~0.1 s, so a batch drains over a few batches and lease-release
 *   handles anything the budget cut off).
 * - Claims PREVIEW_GENERATE rows only (R13-7). The claim predicate already
 *   filtered types, and the review watched this worker claim an unrelated row,
 *   re-read it, skip it and still count it in `checked` — which made "checked"
 *   untrue and left the row's lease held by a worker that had decided not to
 *   touch it. R20-7 moved the claim itself into lib/outbox.ts (`drainPreviews`),
 *   because the composite daily run drains the same queue with a smaller clock;
 *   this route is still the fast path the tick calls every ten minutes.
 * - Retry state lives on the outbox row (attempts/nextAttemptAt/lastError).
 * - `backfill: true` enqueues rows for preview-less startups (bounded 50),
 *   then processes the due batch. Because this is an explicit operator action,
 *   it RE-ARMS the row (attempts/backoff cleared): `claimDueOutbox` skips rows
 *   at OUTBOX_MAX_ATTEMPTS, so without the reset a burned-out row could never
 *   recover after the underlying fault was fixed.
 *
 * Retention/privacy policy: previews are public homepage screenshots of
 * public listings, stored as remote image URLs (no bytes retained). Hiding a
 * listing clears its preview (see the moderate endpoint); the row's payload
 * keeps only the startup id + source URL.
 */
async function runScreenshot(req: NextRequest) {
  let body: { secret?: string; limit?: number; backfill?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const denied = await jobGate(req, "jobs/screenshot", body.secret ?? null);
  if (denied) return denied;

  if (body.backfill) {
    const missing = await prisma.startup.findMany({
      where: { previewImgUrl: null, moderationState: "VISIBLE" },
      select: { id: true, url: true },
      take: 50,
    });
    for (const s of missing) {
      await prisma.outboxEvent.upsert({
        where: { dedupeKey: `preview-${s.id}` },
        create: {
          type: "PREVIEW_GENERATE",
          dedupeKey: `preview-${s.id}`,
          payload: { startupId: s.id, url: s.url },
        },
        update: {
          attempts: 0,
          nextAttemptAt: new Date(),
          lastError: null,
          completedAt: null,
        },
      });
    }
  }

  const limit = jobLimit(req, body, 5, 10);
  const out = await drainPreviews({ limit, budgetMs: JOB_WORK_BUDGET_MS });
  await stampHeartbeat(
    "/api/jobs/screenshot",
    out.errors ? "batch failed" : null,
  );

  const counts = previewCounts(out);
  if (out.errors > 0) {
    return apiJson(
      {
        ok: false,
        error: "preview batch failed",
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
async function getScreenshotStatus(req: NextRequest) {
  return runScreenshot(req);
}
