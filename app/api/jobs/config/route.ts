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
 * Deliberately reports without throwing, and sits with the job endpoints so the
 * external pinger *can* exercise it on every tick (add it to the pinger's URL
 * list — until something calls this, the gaps are still invisible).
 * Authenticated like its neighbours (jobAuth), so the report itself is not
 * public.
 */
export async function GET(req: NextRequest) {
  const denied = jobAuth(req, req.nextUrl.searchParams.get("secret"));
  if (denied) return denied;

  const { ok, findings } = getProdConfigReport();
  return NextResponse.json({ ok, env: getAppEnv(), findings });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
