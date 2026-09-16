import { NextRequest, NextResponse } from "next/server";
import { jobGate } from "@/lib/jobs";
import { ABANDON_MAX_BATCH, sweepAbandonedCheckouts } from "@/lib/abandonedCheckouts";
import { apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: getAbandonedStatus, POST: runAbandonedCheckouts });

/**
 * Abandoned checkout sweep (R08-5): cancels PENDING payments that never reached
 * a provider, so `CANCELED` is a reachable state and the PENDING set means what
 * it says.
 *
 * Authenticated like its job neighbours and bounded per call (default 50). It
 * rides the existing ten-minute tick in .github/workflows/outbox-tick.yml
 * rather than getting a cron entry: the Hobby plan allows two jobs and both are
 * daily mail retries with no other wake-up, while this sweep is safe at any
 * frequency — it is idempotent, touches only rows older than 24h, and cancels
 * nothing that carries a provider session.
 */
async function runAbandonedCheckouts(req: NextRequest) {
  let body: { secret?: string; limit?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const denied = await jobGate(req, "jobs/abandoned-checkouts", body.secret ?? null);
  if (denied) return denied;

  const { canceled, cutoff, candidates } = await sweepAbandonedCheckouts({ limit: body.limit ?? ABANDON_MAX_BATCH });
  return NextResponse.json({ ok: true, canceled: canceled.length, candidates, cutoff, ids: canceled.slice(0, 10) });
}

/** Same auth, same sweep — GET so a pinger or cron can reach it without a body. */
async function getAbandonedStatus(req: NextRequest) {
  return runAbandonedCheckouts(req);
}
