import { NextRequest, NextResponse } from "next/server";
import { adminGate } from "@/lib/jobs";
import { apiError, apiRoute } from "@/lib/route";
import { OPS_WINDOW_MAX_DAYS, opsReport, opsWindowDays } from "@/lib/opsMetrics";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: getOpsReport });

/**
 * The operator dashboard, as one authenticated JSON read (doc 18 §3.8).
 *
 * Doc 18 defined the launch-day dashboard in terms of seven questions and found
 * that four of them — "did anything get paid", "is the queue deep, stale or
 * failing", "did the mail actually leave", "what has the operator done" — had
 * no reader in the product at all; the queries in §3.8 were meant to be typed
 * by hand. This route is those queries, plus the two conversions R18-14 asks
 * for and the alarm list §3.10 needs, and `lib/opsMetrics.ts` is where each
 * number's definition lives.
 *
 * Authentication and metering are `adminGate`'s (R11-3): the same bearer as the
 * other operator routes, so a leak of this body is a leak of `ADMIN_TOKEN`.
 * That is also why it never returns an email address — `mail.recentFailures`
 * carries the template, the provider status and the reason, and the person
 * stays in the register (R18-3).
 *
 * The status code is deliberately uninformative: **200 whenever the report
 * could be read**, whatever the alarms say. A deep queue or a failed receipt is
 * not a reason to tell a monitor the deployment is down — that conflation is
 * exactly what §3.10 and R18-12 describe, and it is how a monitor gets muted
 * before the outage that matters. Alarms travel in the body and, for a poller
 * that reads only headers, in `X-Ops-Alarms`. `?ok=1` asks the question an
 * alert rule actually wants ("is anything wrong?") and answers 503 when the
 * list is non-empty — opt-in, so the default poll stays a stable 200.
 */
async function getOpsReport(req: NextRequest) {
  const denied = await adminGate(req, "admin/ops");
  if (denied) return denied;

  // Validated here rather than left to the report: an unparseable window is a
  // caller error and must not be silently rounded into a different question.
  const rawDays = req.nextUrl.searchParams.get("days");
  if (rawDays !== null) {
    const parsed = Number(rawDays);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > OPS_WINDOW_MAX_DAYS) {
      return apiError(
        `days must be a whole number between 1 and ${OPS_WINDOW_MAX_DAYS}.`,
        { status: 400, code: "BAD_WINDOW" },
      );
    }
  }

  const report = await opsReport({
    days: opsWindowDays(rawDays === null ? undefined : Number(rawDays)),
  });

  const res = NextResponse.json(report, {
    status:
      req.nextUrl.searchParams.get("ok") === "1" && report.alarms.length > 0
        ? 503
        : 200,
  });
  res.headers.set(
    "X-Ops-Alarms",
    report.alarms.map((a) => a.code).join(",") || "-",
  );
  res.headers.set("X-Ops-Outbox-Pending", String(report.outbox.pending));
  res.headers.set("X-Ops-Paid-Net-Usd", String(report.money.paidNetUsd));
  // The four numbers a poller or a shell prompt wants without parsing a body.
  // A count of zero here means the sink recorded nothing — it is not a liveness
  // signal, and nothing in this route changes its status for it.
  res.headers.set("X-Ops-Errors", String(report.errors.count));
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
