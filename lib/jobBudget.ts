/**
 * The maintenance request's wall-clock arithmetic (Phase 13, R13-4).
 *
 * `maxDuration = 30` is the platform's hard kill: the function is terminated,
 * the response never leaves, and the scheduler sees a bare failure with no body
 * to read. Underneath that ceiling each *row* had its own 10 s limit
 * (lib/email.ts's `AbortSignal.timeout(10_000)`, lib/screenshots.ts's
 * `probeShot(url, 10_000)`), so two slow rows in one request could spend 20 s of
 * the 30 before the loop next looked at the clock — and the claim itself, which
 * runs before the first row, was not inside the arithmetic at all.
 *
 * The numbers are named once here rather than in each route, and
 * lib/jobsAndCron.test.ts asserts them against the `maxDuration` the route files
 * actually declare, so the arithmetic cannot drift away from the deployment.
 */
import type { NextRequest } from "next/server";
export const PLATFORM_CEILING_MS = 30_000; // `export const maxDuration = 30` in app/api/jobs/*
export const RESPONSE_SLACK_MS = 6_000; // response, framework overhead, request id
export const ROW_CEILING_MS = 10_000; // one row's own abort signal — see the note below
export const JOB_WORK_BUDGET_MS = PLATFORM_CEILING_MS - RESPONSE_SLACK_MS;
/**
 * May another row be started? Only while that row's whole declared ceiling still
 * fits inside the request. Rows claimed and left unstarted are not lost: their
 * lease keeps them out of every other worker's reach until it expires, and the
 * next tick re-claims them (lib/outbox.ts `drainInBatches`).
 *
 * The ceiling is the *declared* one, which is exact for mail (the fetch aborts at
 * 10 s) and a floor for previews: a PREVIEW_GENERATE row probes Microlink under
 * this signal and then stores the image, and the store has no timeout of its
 * own. One row's worth of that difference is what RESPONSE_SLACK_MS absorbs, and
 * a request killed anyway loses the batch, never the row.
 */
export function canStartRow(
  deadline: number,
  now: number = Date.now(),
): boolean {
  return deadline - now >= ROW_CEILING_MS;
}

/**
 * The batch size for this call: the body first, then the query string, then the
 * default.
 *
 * The default depends on the verb, and that is the R13-5 half a scheduler cannot
 * fix from outside. Vercel's crons invoke these paths with GET (vercel.json) and
 * a GET carries no body, so both daily backstops ran at the *default* batch of 5
 * while the route accepted 25 (outbox) or 10 (previews) — an operator reading
 * vercel.json would conclude the daily cron drained a real backlog, and it
 * drained a fifth of it. A bodyless GET is now read as what it is: a scheduler
 * asking for the work to be moved, stating no batch, so it gets the largest batch
 * the route allows. A bodyless POST keeps the small default, because a POST is a
 * person or the tick (which states `{"limit":25}`). `?limit=` overrides both for
 * anyone who wants to say.
 *
 * Out-of-range and unparsable values fall back to the default instead of
 * propagating NaN into the claim. An absent `?limit=` is not zero rows either:
 * `Number(null)` and `Number("")` are both 0, which would pin every unqualified
 * call to a batch of one.
 */
export function jobLimit(
  req: NextRequest,
  body: { limit?: number },
  def: number,
  max: number,
): number {
  const stated = req.nextUrl.searchParams.get("limit");
  const qs = stated && stated.trim() !== "" ? Number(stated) : null;
  const fallback = req.method === "GET" ? max : def;
  const raw = typeof body.limit === "number" ? body.limit : (qs ?? fallback);
  const n = Number.isFinite(raw) ? raw : fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}
