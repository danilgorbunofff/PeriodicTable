import { NextRequest, NextResponse } from "next/server";
import { jobGate } from "@/lib/jobs";
import {
  heartbeatReport,
  stampHeartbeat,
  type HeartbeatRouteStatus,
} from "@/lib/jobHeartbeat";
import {
  configFindingsOk,
  credentialFinding,
  getAppEnv,
  getProdConfigReport,
  isProduction,
  type CredentialHealth,
} from "@/lib/env";
import { getProviderMode, probeStripeKey, stripeKeyMode } from "@/lib/stripe";
import { mailDriver, suppressedCount } from "@/lib/email";
import { dueOutboxCount, failedMailHealth } from "@/lib/outbox";
import { prisma } from "@/lib/prisma";
import { apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({
  GET: getConfig,
  POST: updateConfig,
});

/**
 * Production config report (Phase 0 surface, non-fatal).
 *
 * `required` findings are exactly what requireProdEnv() refuses to serve
 * without — the same list, from the same definitions (getProdConfigReport()
 * derives them from REQUIRED_PROD_ENV). The startup check added for R07-3
 * (reportProdEnvAtStartup(), called from lib/prisma.ts) logs the same gaps; this
 * endpoint stays the only place they surface *with detail*, and the only one an
 * external monitor can see.
 *
 * Non-fatal means it always *answers* — never that it always answers 200. A
 * `required` finding is returned as **503**, because the status code is the
 * only channel the external pinger can read: the free cron-job.org tier fails a
 * job on non-2xx and cannot inspect the body. While this endpoint answered 200
 * unconditionally, a missing required variable was invisible to the very
 * monitor the paragraph below asks to call it, so the pinger stayed green
 * forever. The two codes now mean different things — 401 is a bad secret, 503
 * is "authenticated, and the deployment is misconfigured" — and a 200 means the
 * secret is right *and* nothing required is missing.
 *
 * R07-4: presence is not validity. A configured key that Stripe itself rejects
 * passes every check in this codebase (the variable is set, non-empty, and
 * correctly prefixed) while every single checkout answers 502, so in production
 * the report also asks Stripe — `GET /v1/balance`, the cheapest authenticated
 * call there is. A rejected key is the one `required` finding derived from a live
 * check, because the deployment is unservable in the way that matters most; an
 * unreachable Stripe is `degraded` instead, so a network blip cannot raise an
 * alert. The probe is skipped outside production: it is a network call whose
 * answer decides a production alert, and no test or local read should depend on
 * Stripe's uptime. `stripeKey` reports which of those it was, never the key.
 *
 * Sits with the job endpoints so the external pinger *can* exercise it on every
 * tick (add it to the pinger's URL list — until something calls this, the gaps
 * are still invisible). Authenticated and metered like its neighbours (jobGate), so the
 * report itself is not public. Auth is checked before health, so an
 * unauthenticated caller gets 401 rather than a 503 that would leak which
 * variables are missing.
 */
async function getConfig(req: NextRequest) {
  // No query secret (R14-8): see jobs/reconcile.
  const denied = await jobGate(req, "jobs/config");
  if (denied) return denied;

  const { findings } = getProdConfigReport();
  const probeInProduction = isProduction();
  const keyMode = stripeKeyMode();
  let stripeKey: CredentialHealth["status"] | "not-checked" = "not-checked";
  if (probeInProduction) {
    const health = await probeStripeKey();
    stripeKey = health.status;
    const finding = credentialFinding("STRIPE_SECRET_KEY", health);
    if (finding) findings.push(finding);
  }
  // R18-4: the probe above cannot see this. A test key is a *valid* key, so
  // `stripeKey` answers "valid" while the deployment is selling sessions no real
  // card can pay — and a test-mode delivery that reaches the webhook endpoint
  // settles a payment that never happened, minting a stake on the board out of
  // nothing. `required`, like a rejected key, for the same reason: the status
  // code is the only channel the external pinger reads, and this state must not
  // be green. Gated on production so a laptop and the suite can hold test keys —
  // which is what they are for. `unknown` is not reported here (it may be a
  // restricted key of either mode); the mode itself is always in the payload.
  if (probeInProduction && keyMode === "test") {
    findings.push({
      key: "STRIPE_SECRET_KEY",
      severity: "required",
      detail:
        "STRIPE_SECRET_KEY is a test-mode key on a production deployment: no buyer's card can be charged, while a test-mode delivery would settle a real stake. Replace it with the live key (ops/secrets.md)",
    });
  }
  // R10-1: money bug adjacent — mail that failed and was never delivered is
  // invisible to every existing surface. The outbox row is retried by the
  // worker, but a failure that exhausts its attempts (or a send that reported
  // failure without failing its row) just stops, and the buyer never learns
  // what they bought. This is a health *number* plus the dedupe key of the
  // oldest unresolved failure, which is the one an operator retries via
  // /api/admin/outbox/retry. Deliberately not a `required` finding: a failed
  // mail does not make the deployment unservable, and the endpoint must keep
  // meaning "config" for the pinger. Read-only and best-effort — a database
  // that cannot answer reports null rather than turning this into a 500.
  let mail: {
    driver: "resend" | "logged";
    suppressed: number;
    failedCount: number;
    oldestUnretriedKey: string | null;
  } | null = null;
  try {
    const health = await failedMailHealth();
    mail = {
      // R17-13: the two facts ops/email.md's first step reads and the queue
      // cannot give — which driver a send will use at all (`logged` means
      // RESEND_API_KEY is unset, so nothing leaves the building however
      // healthy the queue looks), and how many addresses we are refusing to
      // mail. Reads only; the remedy is in the runbook.
      driver: mailDriver(),
      suppressed: await suppressedCount(),
      failedCount: health.failed,
      oldestUnretriedKey: health.oldestKey,
    };
  } catch {
    mail = null;
  }
  // R13-3: whether the workers that keep every other number here current are
  // still running. Read *before* this route stamps itself, so a report that says
  // "config last ran three days ago" is the report telling you nobody has been
  // reading reports. Both the findings and the ages ride along: the finding says
  // something is wrong, the ages say which route and since when, and neither is
  // `required` — an unattended job is operator work, not an unservable
  // deployment. Best-effort like `mail`: a database that cannot answer this
  // leaves it null rather than turning the report into a 500.
  let heartbeats: HeartbeatRouteStatus[] | null = null;
  try {
    const report = await heartbeatReport();
    findings.push(...report.findings);
    heartbeats = report.routes;
  } catch {
    heartbeats = null;
  }
  await stampHeartbeat(
    "/api/jobs/config",
    configFindingsOk(findings) ? null : "report not ok",
  );

  // R15-11/R15-13: the numbers that make spend and backlog attributable, in the
  // one place an operator already polls (see R13-3 above — this route is the
  // external pinger's only in-app surface). Before this, nothing in the product
  // measured itself: doc 15 could only count invocations and ISR writes from the
  // platform's dashboards, and the row volume the review enumerated per
  // settlement (11 rows across 8 tables, nothing that trims them) was invisible
  // from inside. What is reportable *here* is what the database knows:
  // settlements actually applied, the outbox depth the worker is behind on, and
  // the size of the analytics trail nothing prunes (`STAKE_ANALYTICS` rows are
  // written per settlement and never read — their handler is a deliberate no-op,
  // lib/outbox.ts). Two numbers deliberately absent, because the product cannot
  // see them and must not pretend to: platform invocations and ISR writes are
  // the host's to count (Vercel's logs and ISR-write metric; the per-request
  // `{"scope":"api"}` line from withContract is the origin's own half).
  //
  // Cost of asking: the counts are index-backed (`Payment(status)`, the
  // `(type, completedAt)` outbox index, and the partial claim index behind
  // `dueOutboxCount`), this route is authenticated, and it runs on the job
  // tick — not on a visitor path. Best-effort like `mail` and `heartbeats`: a
  // database that cannot answer leaves it null rather than turning the report
  // into a 500.
  let cost: {
    settlements: { day: number; week: number };
    outboxDue: number;
    analyticsRows: number;
  } | null = null;
  try {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    const [day, week, outboxDue, analyticsRows] = await Promise.all([
      prisma.payment.count({ where: { status: "PAID", appliedAt: { gte: hoursAgo(24) } } }),
      prisma.payment.count({ where: { status: "PAID", appliedAt: { gte: hoursAgo(24 * 7) } } }),
      dueOutboxCount(),
      prisma.outboxEvent.count({ where: { type: "STAKE_ANALYTICS", completedAt: { not: null } } }),
    ]);
    cost = { settlements: { day, week }, outboxDue, analyticsRows };
  } catch {
    cost = null;
  }

  const ok = configFindingsOk(findings);
  return NextResponse.json(
    {
      ok,
      env: getAppEnv(),
      findings,
      stripeKey,
      // R18-4: which mode each half of the money path is in. `providerMode` is
      // the value that decides whether a payment row belongs to Stripe or to the
      // simulator (Payment.provider); `stripeKeyMode` is the environment the key
      // belongs to. Read together with `stripeKey` they separate the three
      // failures that all looked like "payments are down": no key, a rejected
      // key, and a key of the wrong environment.
      providerMode: getProviderMode(),
      stripeKeyMode: keyMode,
      mail,
      heartbeats,
      cost,
    },
    { status: ok ? 200 : 503 },
  );
}

async function updateConfig(req: NextRequest) {
  return getConfig(req);
}
