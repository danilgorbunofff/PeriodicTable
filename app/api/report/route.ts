import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { rateLimitAsync } from "@/lib/rateStore";
import { clientIp } from "@/lib/ip";
import { enqueueOutbox, drainDueWithin } from "@/lib/outbox";
import { apiRoute, apiError } from "@/lib/route";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ POST: postReport });

/**
 * Report / takedown intake (Phase 4).
 *
 * Throttled per IP. Over budget it answers 429 with the shared {error, code}
 * envelope (R11-5) — it used to answer 200 `{ok:true, note:"rate-limited"}`,
 * which is a success to every `res.ok` check on the client and to any uptime
 * probe counting 2xx, so a throttled report looked like a filed one.
 */
async function postReport(req: NextRequest) {
  const ip = clientIp(req.headers);
  if (!(await rateLimitAsync(`report:${ip}`, 10, 3_600_000))) {
    return apiError("Too many requests. Try again later.", { status: 429, code: "RATE_LIMITED" });
  }
  let body: { stakeId?: string; domain?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const reason = (body.reason ?? "").toString().slice(0, 280).trim() || "reported listing";
  const stakeId = typeof body.stakeId === "string" ? body.stakeId.slice(0, 64) : null;
  let domain = typeof body.domain === "string" ? body.domain.slice(0, 128) : null;
  let startupId: string | null = null;
  if (stakeId && !domain) {
    const stake = await prisma.stake.findUnique({
      where: { id: stakeId },
      include: { startup: { select: { id: true, domain: true } } },
    });
    domain = stake?.startup.domain ?? null;
    startupId = stake?.startup.id ?? null;
  } else if (domain) {
    startupId = (await prisma.startup.findUnique({ where: { domain }, select: { id: true } }))?.id ?? null;
  }
  const ipHash = createHash("sha256")
    .update(`${ip}:${process.env.CLICK_SALT ?? "ptl-dev-salt"}`)
    .digest("hex");
  const created = await prisma.report.create({
    data: { stakeId, startupId, domain, reason, ipHash },
    select: { id: true, createdAt: true },
  });
  await notifyOperator({ id: created.id, domain, stakeId, reason, createdAt: created.createdAt });
  return NextResponse.json({ ok: true });
}

/**
 * Operator notice for a new report (R05-7): the mail is what turns the
 * "actioned within 72 hours" promise into something that actually arrives.
 * Bounded to a few seconds so the always-200 intake response is never held
 * open by a slow webhook; anything left behind is drained by the daily
 * /api/jobs/outbox cron, and the Report row stays the durable record.
 */
async function notifyOperator(report: {
  id: string;
  domain: string | null;
  stakeId: string | null;
  reason: string;
  createdAt: Date;
}) {
  try {
    await enqueueOutbox(prisma, {
      type: "REPORT_EMAIL",
      payload: {
        to: process.env.REPORT_NOTIFY_EMAIL ?? "abuse@periodictable.lol",
        id: report.id,
        domain: report.domain,
        stakeId: report.stakeId,
        reason: report.reason,
        createdAt: report.createdAt.toISOString(),
      },
      dedupeKey: `report-mail:${report.id}`,
    });
    await drainDueWithin(3_000, 5, ["REPORT_EMAIL"]);
  } catch (err) {
    // The report is already stored; a failed notice must not fail intake.
    console.warn("report notify failed", err);
  }
}
