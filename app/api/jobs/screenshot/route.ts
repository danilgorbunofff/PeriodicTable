import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jobAuth } from "@/lib/jobs";
import { claimDueOutbox, processOutboxRowById } from "@/lib/outbox";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Preview worker (Phase 6, P1-14/P1-15): persists Startup.previewImgUrl from
 * PREVIEW_GENERATE outbox rows (enqueued automatically on every paid stake).
 *
 * - Authenticated on every production invocation (P1-15) — no body-shape
 *   bypasses.
 * - Bounded: at most 10 targets per invocation, 20s global deadline,
 *   8s per-target probe (inside persistPreview).
 * - Retry state lives on the outbox row (attempts/nextAttemptAt/lastError).
 * - `backfill: true` enqueues rows for preview-less startups (bounded 50),
 *   then processes the due batch.
 *
 * Retention/privacy policy: previews are public homepage screenshots of
 * public listings, stored as remote image URLs (no bytes retained). Hiding a
 * listing clears its preview (see the moderate endpoint); the row's payload
 * keeps only the startup id + source URL.
 */
export async function POST(req: NextRequest) {
  let body: { secret?: string; limit?: number; backfill?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const denied = jobAuth(req, body.secret ?? null);
  if (denied) return denied;

  if (body.backfill) {
    const missing = await prisma.startup.findMany({
      where: { previewImgUrl: null, moderationState: "VISIBLE" },
      select: { id: true, url: true },
      take: 50,
    });
    for (const s of missing) {
      await prisma.outboxEvent.upsert({
        where: { dedupeKey: `preview-${s.id}` },
        create: { type: "PREVIEW_GENERATE", dedupeKey: `preview-${s.id}`, payload: { startupId: s.id, url: s.url } },
        update: {},
      });
    }
  }

  const deadline = Date.now() + 20_000;
  const limit = Math.min(Math.max(body.limit ?? 5, 1), 10);
  const claimed = await claimDueOutbox(limit);
  let updated = 0;
  let failed = 0;
  for (const { id } of claimed) {
    if (Date.now() >= deadline) break;
    // Preview rows only — other types belong to the outbox worker.
    const row = await prisma.outboxEvent.findUnique({ where: { id } });
    if (!row || row.type !== "PREVIEW_GENERATE") continue;
    const out = await processOutboxRowById(id);
    if (out === "completed") updated++;
    else if (out === "failed") failed++;
  }
  return NextResponse.json({ ok: true, checked: claimed.length, updated, failed });
}

/** Vercel Cron invokes the path with GET (see vercel.json); same auth, default bounds. */
export async function GET(req: NextRequest) {
  return POST(req);
}
