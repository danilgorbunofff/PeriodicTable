import { prisma } from "@/lib/prisma";
import { HEALTH_TIMEOUT_MS, probeDatabase } from "@/lib/health";
import { appEnv, deploymentId, logWarn } from "@/lib/log";
import { apiJson, apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: getHealth });

/**
 * Liveness (Phase 18, R18-6, R18-9, R18-12).
 *
 * Public, and that is the point. The uptime story the review found was "something
 * outside polls `/api/jobs/config`, whose status code is the entire signal"
 * (§3.4) — a route that answers 401 to a monitor holding a bad token and 503 to
 * one holding a good token on a deployment with a `required` finding. A pinger
 * that can only read status codes cannot tell those apart, and a route whose
 * liveness depends on a secret is one rotation away from being a false alarm.
 * This one takes no token, runs one `SELECT 1`, and answers:
 *
 *   · **200** `{ok: true, db: "up"}` — the process is serving and the database
 *     answered inside `HEALTH_TIMEOUT_MS`.
 *   · **503** `{ok: false, db: "down", timedOut}` — the database did not answer.
 *     A monitor alarms on anything that is not 200, so both are the alarm; the
 *     body is for the human who opens the URL afterwards and needs to know
 *     whether to look at Postgres or at the network.
 *   · **500** — reserved for this route itself throwing, which is a bug here and
 *     not a database incident (`withContract` wraps the handler).
 *
 * The distinction the config route *cannot* make is therefore stated in code
 * rather than in a runbook: an unauthenticated route whose only two meaningful
 * answers are "up" and "down". The bearer-token route keeps its own contract
 * (401 vs 503), documented verbatim in `ops/alerts.md` — the two are not
 * substitutes, and neither replaces a real monitor (`U18-3`).
 *
 * `no-store` is not decoration: a CDN-cached 200 would answer a monitor that
 * Postgres has been refusing for ten minutes.
 */
async function getHealth() {
  const db = await probeDatabase(() => prisma.$queryRaw`SELECT 1`);
  const body = {
    ok: db.up,
    db: db.up ? ("up" as const) : ("down" as const),
    ms: db.ms,
    timedOut: db.timedOut,
    deploy: deploymentId(),
    env: appEnv(),
  };

  if (!db.up) {
    // One line, out of the 23-site census's rule that a failure the process
    // survived is a warning (lib/log.ts): this route answering 503 *is* its
    // designed outcome, and the monitor's alarm is the escalation.
    logWarn("health", "db-probe-failed", {
      ms: db.ms,
      timedOut: db.timedOut,
      timeoutMs: HEALTH_TIMEOUT_MS,
      error: db.error,
    });
  }

  return apiJson(body, {
    status: db.up ? 200 : 503,
    headers: { "cache-control": "no-store, max-age=0" },
  });
}
