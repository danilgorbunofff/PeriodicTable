import { NextRequest, NextResponse } from "next/server";
import { jobAuth } from "@/lib/jobs";
import { getAppEnv, getProdConfigReport } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Production config report (Phase 0 surface, non-fatal).
 *
 * `required` findings are exactly what requireProdEnv() refuses to serve
 * without, but requireProdEnv() is not called at startup — so a missing
 * TURNSTILE_SECRET or Whop key would otherwise be invisible: the site serves,
 * bot checks pass, and nothing says so. The advisory severities (operator
 * lockout, per-instance rate limits) never fail anything, so this is the only
 * place they surface.
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

  const { ok, findings } = getProdConfigReport();
  return NextResponse.json({ ok, env: getAppEnv(), findings }, { status: ok ? 200 : 503 });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
