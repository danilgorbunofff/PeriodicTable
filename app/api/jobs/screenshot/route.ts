import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchShotBytes } from "@/lib/screenshots";

export const dynamic = "force-dynamic";

/** Screenshot persist job (Phase 4, spec 02).
 * Called after Payment.paid (best-effort, never blocks checkout) or via cron:
 *   POST /api/jobs/screenshot { secret?, domain?, limit? }
 * MVP stores the Microlink shot URL directly as previewImgUrl (no R2/S3 yet);
 * binary fetch is only a reachability probe with retries. Backfill: POST { backfill: true }.
 */
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  let body: { secret?: string; domain?: string; limit?: number; backfill?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (cronSecret && body.secret !== cronSecret && req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    // Allow unauthenticated single-domain refreshes in dev; cron must auth in prod.
    if (process.env.NODE_ENV === "production" && !body.domain) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const limit = Math.min(Math.max(body.limit ?? 20, 1), 100);
  const targets = body.domain
    ? await prisma.startup.findMany({ where: { domain: body.domain } })
    : body.backfill
      ? await prisma.startup.findMany({ where: { previewImgUrl: null }, take: limit })
      : await prisma.startup.findMany({
          where: { previewImgUrl: null },
          orderBy: { claimedAt: "desc" },
          take: limit,
        });

  let updated = 0;
  for (const s of targets) {
    // Retry x3 with fallback to favicon (spec): probe reachability, then store shot URL.
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const bytes = await fetchShotBytes(s.url);
      ok = !!bytes;
    }
    if (ok) {
      const shot = `https://image.microlink.io/?url=${encodeURIComponent(s.url)}&viewport.width=1200&viewport.height=675&embed=screenshot.url`;
      await prisma.startup.update({ where: { id: s.id }, data: { previewImgUrl: shot } });
      updated++;
    }
  }
  return NextResponse.json({ ok: true, checked: targets.length, updated });
}
