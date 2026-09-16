import { NextRequest, NextResponse } from "next/server";
import { jobGate } from "@/lib/jobs";
import { claimDueOutbox, processOutboxRowById } from "@/lib/outbox";
import { apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: getOutboxStatus, POST: runOutbox });

/**
 * Outbox worker (Phase 6): receipt/outbid email, preview generation, and
 * analytics drain from durable rows. Authenticated (P1-15), bounded batch
 * (default 5, max 25), global invocation deadline (~20s of the 30s budget).
 * Every delivery carries its dedupe key with exponential backoff; terminal
 * failures persist lastError for the operator retry endpoint.
 */
async function runOutbox(req: NextRequest) {
  let body: { secret?: string; limit?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const denied = await jobGate(req, "jobs/outbox", body.secret ?? null);
  if (denied) return denied;

  const deadline = Date.now() + 20_000;
  const limit = Math.min(Math.max(body.limit ?? 5, 1), 25);
  const claimed = await claimDueOutbox(limit);
  let completed = 0;
  let failed = 0;
  for (const { id } of claimed) {
    if (Date.now() >= deadline) break;
    const out = await processOutboxRowById(id);
    if (out === "completed") completed++;
    else if (out === "failed") failed++;
  }
  return NextResponse.json({ ok: true, claimed: claimed.length, completed, failed });
}

/** Vercel Cron invokes the path with GET (see vercel.json); same auth, default bounds. */
async function getOutboxStatus(req: NextRequest) {
  return runOutbox(req);
}
