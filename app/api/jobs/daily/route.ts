import { NextRequest } from "next/server";
import { jobGate } from "@/lib/jobs";
import { DAILY_PREVIEW_BUDGET_MS, jobLimit } from "@/lib/jobBudget";
import { drainPreviews, previewCounts } from "@/lib/outbox";
import { stampHeartbeat } from "@/lib/jobHeartbeat";
import { apiJson, apiRoute, requestId, type ApiHandler } from "@/lib/route";
import { describeError } from "@/lib/log";
import { GET as configGET } from "../config/route";
import { GET as reconcileGET } from "../reconcile/route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({
  GET: runDaily,
  POST: runDaily,
});

/**
 * The composite daily run (Phase 20, R20-7).
 *
 * The review's finding was a schedule with nothing behind it: `/api/jobs/config`
 * and `/api/jobs/reconcile` are how an operator learns that anything else has
 * stopped — and they were driven by the ten-minute GitHub tick alone, so a tick
 * that stopped took the alarm with it. Giving them a platform schedule of their
 * own was not possible on the plan this deployment runs on: Hobby allows two
 * cron jobs, daily frequency, and both were spent on workers whose only other
 * wake-up is that same tick. So one of the two slots runs this path, and this
 * path runs the preview worker and then both reports in one invocation.
 *
 * What that costs, named rather than assumed (lib/jobBudget.ts): the three jobs
 * share one 30 s ceiling, so the preview batch runs on
 * `DAILY_PREVIEW_BUDGET_MS` — the worker's own budget minus the reserve the two
 * reports need. Both reports are read-only, index-backed and measured; a batch
 * the budget cuts short is not lost, its rows stay leased and the next call
 * re-claims them (lib/outbox.ts).
 *
 * The two reports are invoked in-process rather than over HTTP, and through
 * their own route handlers rather than a second copy of their logic: same auth,
 * same gate, same response, same `x-request-id` (the one header this route
 * passes through unchanged, so all four log lines and the answer below can be
 * found from one id). Their bodies ride under `report` because both of them have
 * a top-level `ok` of their own — a flattened merge would report one leg's money
 * verdict as the whole run's.
 *
 * The status code is the run's verdict, not a page: a failing leg answers 500 so
 * the platform's cron log, an operator with curl, and any monitor the operator
 * adds (ops/alerts.md, D18-5) all read the same thing. Every leg stamps its own heartbeat as it
 * finishes, so a kill part-way through still leaves evidence of what ran.
 */
async function runDaily(req: NextRequest) {
  let body: { secret?: string; limit?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const denied = await jobGate(req, "jobs/daily", body.secret ?? null);
  if (denied) return denied;

  const limit = jobLimit(req, body, 5, 10);
  // One id for four invocations: the reports are the same request as far as an
  // operator tracing a run is concerned.
  const headers = new Headers(req.headers);
  const id = headers.get("x-request-id") ?? requestId();
  headers.set("x-request-id", id);

  // The worker first: its rows are time-sensitive, and the reports read the
  // queue afterwards, which is the interesting direction (what is left, not
  // what was there before the batch ran).
  const out = await drainPreviews({ limit, budgetMs: DAILY_PREVIEW_BUDGET_MS });
  await stampHeartbeat("/api/jobs/screenshot", out.errors ? "batch failed" : null);
  const preview = {
    ok: out.errors === 0,
    errors: out.errors,
    ...previewCounts(out),
  };

  const reconcile = await report(reconcileGET, req, "/api/jobs/reconcile", headers);
  const config = await report(configGET, req, "/api/jobs/config", headers);

  const failing = [!preview.ok, !reconcile.ok, !config.ok].filter(Boolean).length;
  await stampHeartbeat(
    "/api/jobs/daily",
    failing > 0 ? `${failing} leg(s) not ok` : null,
  );

  const jobs = {
    preview: { status: 200, ...preview },
    reconcile: {
      ok: reconcile.ok,
      status: reconcile.status,
      report: reconcile.body,
    },
    config: { ok: config.ok, status: config.status, report: config.body },
  };
  if (failing > 0) {
    return apiJson(
      { ok: false, error: "daily run not ok", code: "INTERNAL", failing, jobs },
      { status: 500 },
    );
  }
  return apiJson({ ok: true, failing: 0, jobs });
}

type Leg = { ok: boolean; status: number; body: unknown };

/** Run one of the two reports in-process, as a scheduler would have: the same
 *  request (headers and all), its own gate and metering, and a verdict that
 *  treats "answered 200 with `ok: false`" as failing — which is how both of them
 *  report a finding without pretending the request failed. */
async function report(
  handler: ApiHandler,
  parent: NextRequest,
  path: string,
  headers: Headers,
): Promise<Leg> {
  try {
    const req = new NextRequest(new URL(path, parent.nextUrl.origin), {
      method: "GET",
      headers,
    });
    const res = await handler(req);
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return {
      ok: res.ok && body?.ok !== false,
      status: res.status,
      body: body ?? { note: "the report's body could not be read" },
    };
  } catch (e) {
    // The handler wraps its own failures, so this is the boundary failing rather
    // than the report: say so without hiding the other leg's verdict.
    return {
      ok: false,
      status: 500,
      body: { error: describeError(e), code: "INTERNAL" },
    };
  }
}
