import { NextRequest, NextResponse } from "next/server";
import { jobAuth } from "@/lib/jobs";
import {
  configFindingsOk,
  credentialFinding,
  getAppEnv,
  getProdConfigReport,
  isProduction,
  type CredentialHealth,
} from "@/lib/env";
import { probeStripeKey } from "@/lib/stripe";
import { failedMailHealth } from "@/lib/outbox";

export const dynamic = "force-dynamic";

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
 * are still invisible). Authenticated like its neighbours (jobAuth), so the
 * report itself is not public. Auth is checked before health, so an
 * unauthenticated caller gets 401 rather than a 503 that would leak which
 * variables are missing.
 */
export async function GET(req: NextRequest) {
  const denied = jobAuth(req, req.nextUrl.searchParams.get("secret"));
  if (denied) return denied;

  const { findings } = getProdConfigReport();
  const probeInProduction = isProduction();
  let stripeKey: CredentialHealth["status"] | "not-checked" = "not-checked";
  if (probeInProduction) {
    const health = await probeStripeKey();
    stripeKey = health.status;
    const finding = credentialFinding("STRIPE_SECRET_KEY", health);
    if (finding) findings.push(finding);
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
  let mail: { failedCount: number; oldestUnretriedKey: string | null } | null = null;
  try {
    const health = await failedMailHealth();
    mail = { failedCount: health.failed, oldestUnretriedKey: health.oldestKey };
  } catch {
    mail = null;
  }
  const ok = configFindingsOk(findings);
  return NextResponse.json(
    { ok, env: getAppEnv(), findings, stripeKey, mail },
    { status: ok ? 200 : 503 }
  );
}

export async function POST(req: NextRequest) {
  return GET(req);
}
