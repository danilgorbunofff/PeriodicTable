/**
 * Job liveness (Phase 13, R13-3).
 *
 * The review could only measure the tick's cadence by reading GitHub's own run
 * list: nothing in the app could say whether delivery had happened at all,
 * because an empty queue and a dead scheduler produce the same healthy-looking
 * zero. `/api/jobs/config` answered "ok" for six weeks of a partially stalled
 * schedule and would keep answering it forever.
 *
 * So each maintenance route stamps its own row on the way out, and the config
 * report reads the ages. The finding is deliberately *not* about slowness: it
 * fires when a route has not reported at all past its bound, which is the
 * failure the review could not see (a stopped scheduler), not the one the tick
 * already turns red (a route that answers non-2xx). Nothing here fails a
 * request — a heartbeat that cannot be written logs and returns.
 *
 * The bounds are derived, not guessed. Five of the six routes have a daily
 * platform backstop (vercel.json): outbox through its own entry, screenshot,
 * reconcile and config through `/api/jobs/daily` — the composite run R20-7 added
 * because Hobby allows two cron entries and both slots were needed by workers —
 * and `/api/jobs/daily` itself, whose row is the only direct evidence that the
 * platform fired the entry at all. The five workers still ride the ten-minute
 * GitHub tick. GitHub's schedule is best-effort and the measured behaviour is
 * much worse than nominal — 34 runs in 110 hours, so 5 % of the nominal 661, with
 * gaps of 1 h 44 m, 3 h 12 m and 6 h 40 m — while a Vercel cron is a platform
 * promise with its own slack. A route backed by the daily run is therefore
 * allowed that run plus two hours (26 h), and the one route only the tick drives
 * is allowed twice the worst gap ever observed (14 h). Both are wide enough that
 * only a stopped schedule trips them; see U13-1 for what that costs.
 */
import type { ProdConfigFinding } from "./env";
import { describeError, logWarn } from "./log";
import { prisma } from "./prisma";

/** The five workers the tick drives, plus the composite entry that is four of
 *  their daily backstop (R20-7). */
export const HEARTBEAT_ROUTES = [
  "/api/jobs/outbox",
  "/api/jobs/screenshot",
  "/api/jobs/abandoned-checkouts",
  "/api/jobs/reconcile",
  "/api/jobs/config",
  "/api/jobs/daily",
] as const;

export type HeartbeatRoute = (typeof HEARTBEAT_ROUTES)[number];

/** Worst gap measured between tick runs (34 runs / 110.12 h, R13-3 §5.6). */
export const TICK_WORST_OBSERVED_MS = 400 * 60_000; // 6 h 40 m
/** Slack on top of the daily Vercel backstop: one late deploy, not a stall. */
export const HEARTBEAT_SLACK_MS = 2 * 60 * 60_000;

export const HEARTBEAT_STALE_MS: Record<HeartbeatRoute, number> = {
  // "*/10" on GitHub, plus the 04:00 daily backstop in vercel.json.
  "/api/jobs/outbox": 24 * 60 * 60_000 + HEARTBEAT_SLACK_MS,
  // Own 04:30 entry before R20-7; now stamped by `/api/jobs/daily` at 04:30.
  "/api/jobs/screenshot": 24 * 60 * 60_000 + HEARTBEAT_SLACK_MS,
  // Tick only: /api/jobs/daily does not run the checkout sweep, and Hobby's two
  // cron slots are spent (R20-7, D20-7).
  "/api/jobs/abandoned-checkouts": 2 * TICK_WORST_OBSERVED_MS,
  // Read by the 04:30 composite, which is what makes these two a schedule of
  // their own rather than a passenger of the tick (R20-7).
  "/api/jobs/reconcile": 24 * 60 * 60_000 + HEARTBEAT_SLACK_MS,
  "/api/jobs/config": 24 * 60 * 60_000 + HEARTBEAT_SLACK_MS,
  // The 04:30 entry itself, and the bound the one open item of the register asks
  // about (U20-8): a row written here is the platform's own word that it fired.
  "/api/jobs/daily": 24 * 60 * 60_000 + HEARTBEAT_SLACK_MS,
};

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Record that this process just finished a run of `key`. Best-effort by
 * construction: the row is bookkeeping, and a job that did its work must not
 * report failure because the bookkeeping could not be written.
 */
export async function stampHeartbeat(
  key: HeartbeatRoute,
  error?: string | null,
): Promise<void> {
  try {
    await prisma.jobHeartbeat.upsert({
      where: { key },
      create: { key, lastRunAt: new Date(), runs: 1, lastError: error ?? null },
      update: {
        lastRunAt: new Date(),
        runs: { increment: 1 },
        lastError: error ?? null,
      },
    });
  } catch (e) {
    logWarn("jobs", "heartbeat-not-recorded", { key, error: describeError(e) });
  }
}

/**
 * One finding per route that has stopped reporting, plus the ages those findings
 * were drawn from so an operator can read the whole picture in one call.
 *
 * Severity is `operator`, never `required`: configFindingsOk() fails a deployment
 * on `required` alone, and an unattended job is a human's problem to fix (restart
 * the schedule) rather than something a deploy should refuse. The route's own
 * failures still turn the tick red, which is the arm that must page.
 *
 * `/api/jobs/config` is in the list deliberately and is read *before* the caller
 * re-stamps it: its age is the age of the pinger, so a report that says "config
 * last ran three days ago" is the report telling you nobody has been reading
 * reports. A route's own row is otherwise the least interesting one it can show,
 * which is why the stamp happens after this read rather than before.
 */
export type HeartbeatRouteStatus = {
  route: HeartbeatRoute;
  boundMs: number;
  /** null when the route has never reported. */
  ageMs: number | null;
  runs: number;
  lastRunAt: string | null;
  lastError: string | null;
};

export async function heartbeatReport(
  now = Date.now(),
): Promise<{ findings: ProdConfigFinding[]; routes: HeartbeatRouteStatus[] }> {
  const rows = await prisma.jobHeartbeat.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const findings: ProdConfigFinding[] = [];
  const routes: HeartbeatRouteStatus[] = [];
  for (const route of HEARTBEAT_ROUTES) {
    const bound = HEARTBEAT_STALE_MS[route];
    const row = byKey.get(route);
    if (!row) {
      routes.push({
        route,
        boundMs: bound,
        ageMs: null,
        runs: 0,
        lastRunAt: null,
        lastError: null,
      });
      findings.push({
        key: `heartbeat:${route}`,
        severity: "operator",
        detail: `no run recorded for ${route} — the schedule that drives it has never reached this instance`,
      });
      continue;
    }
    const age = now - row.lastRunAt.getTime();
    routes.push({
      route,
      boundMs: bound,
      ageMs: age,
      runs: row.runs,
      lastRunAt: row.lastRunAt.toISOString(),
      lastError: row.lastError,
    });
    if (age > bound) {
      findings.push({
        key: `heartbeat:${route}`,
        severity: "operator",
        detail: `no run recorded for ${route} since ${row.lastRunAt.toISOString()} (${hours(age)} ago, bound ${hours(
          bound,
        )}) — the worker that drives it has stopped`,
      });
    }
  }
  return { findings, routes };
}

/** The findings half, for callers that have no room to show the ages. */
export async function heartbeatFindings(
  now = Date.now(),
): Promise<ProdConfigFinding[]> {
  return (await heartbeatReport(now)).findings;
}
