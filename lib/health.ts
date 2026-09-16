/**
 * Liveness probe (Phase 18, R18-6, R18-9, R18-12).
 *
 * The review's measurement: "stop Postgres in a dev environment and call
 * `/api/stats`; observe a generic failure with no distinguishing signal". The
 * product had no surface that reported database reachability at all — the only
 * designed uptime signal was the status code of an *authenticated* config route,
 * where a wrong token and a genuine `required` finding both look like "not 200"
 * to a free-tier pinger (§5.5).
 *
 * This module is the probe itself, kept free of the database client so its
 * behaviour — up, down, and *did not answer in time* — is testable without a
 * server. `/api/health` supplies the one statement it runs.
 *
 * Two rules come from what the probe is for:
 *
 *  · **Exactly one statement, and a deadline.** A health check that queues behind
 *    a busy pool is a health check that reports the site down because a report
 *    query was slow; `$queryRaw` on a fresh connection is not bounded by
 *    anything, so the deadline is ours. The count of statements is also why this
 *    is not implemented as "call an existing route and see": that would measure
 *    whatever that route happens to do next month.
 *  · **`timedOut` is its own answer.** A refusal and a timeout are different
 *    incidents — one is the database being gone, the other may be the network
 *    between us and it, or a pool with nothing left to hand out. The caller gets
 *    both facts and decides what to log; the probe never invents a reason.
 */
import { describeError } from "./log";

/** Short on purpose: a monitor is watching the wall clock too. */
export const HEALTH_TIMEOUT_MS = 2_000;

export type ProbeOutcome = {
  up: boolean;
  ms: number;
  timedOut: boolean;
  /** The failure, truncated by the caller if it is logged. Never sent to a
   *  caller of the route: a monitor needs the status, not our internals. */
  error?: string;
};

export type HealthProbe = () => Promise<unknown>;

/**
 * Run one probe under a deadline. Resolves on every path — the caller's status
 * code is the answer, not an exception.
 */
export async function probeDatabase(
  probe: HealthProbe,
  timeoutMs: number = HEALTH_TIMEOUT_MS
): Promise<ProbeOutcome> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), timeoutMs);
    });
    const outcome = await Promise.race([probe().then(() => "up" as const), deadline]);
    const ms = Date.now() - startedAt;
    if (outcome === "deadline") return { up: false, ms, timedOut: true };
    return { up: true, ms, timedOut: false };
  } catch (err) {
    return { up: false, ms: Date.now() - startedAt, timedOut: false, error: describeError(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
