import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminGate } from "@/lib/jobs";
import { apiJson, apiError, apiRoute } from "@/lib/route";
import { isReportStatus } from "@/lib/api";
import { reportQueueAge, TRIAGE_PROMISE_HOURS } from "@/lib/moderation";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: listReports });

/**
 * Operator report queue (takedown runbook: triage <24h). Bounded, newest first.
 *
 * R16-12: the queue now measures itself. `/legal/contact` promises reports are
 * "actioned within 72 hours" and this route was the only place anyone could look
 * — with no number in it, the promise could not be kept on purpose. The metric
 * travels in **headers**, not in the body: the body is a bare array that curl
 * pipelines, dashboards and the triage runbook all read positionally, and
 * wrapping it in an envelope to carry a count would break every one of them for
 * a number the operator can read with `curl -i` (or `-D -`). `X-Report-Queue-
 * Overdue` is the one to alert on; it is 0 whenever the promise holds.
 */
async function listReports(req: NextRequest) {
  const denied = await adminGate(req, "admin/reports");
  if (denied) return denied;
  // Validated against the shared list (R11-6): an unknown ?status= used to be
  // cast straight into Prisma, so `?status=open` (or a typo) rendered an empty
  // queue — indistinguishable from "no reports", which is how a real report
  // gets missed. 400 says the filter was wrong; 200 [] keeps meaning none.
  // The values are the Prisma member spelling ("OPEN"), not the column's mapped
  // one ("open"): ReportStatus is @map-ed, and every filter has to speak the
  // member name. See the wire-conventions note in doc/ARCHITECTURE.md (R12-7).
  const status = req.nextUrl.searchParams.get("status");
  if (status !== null && !isReportStatus(status)) {
    return apiError("Unknown report status.", { status: 400, code: "BAD_STATUS" });
  }
  // `?before=<id>` is the page cursor (R11-6). The queue was capped at 50 with
  // no way to reach rows 51+, so the oldest reports — the ones that have waited
  // longest against the 72-hour promise — were the ones nobody could see. `id`
  // is the tiebreak in the ordering as well as the cursor, so the page boundary
  // stays put when two reports share a createdAt second.
  const before = req.nextUrl.searchParams.get("before");
  const age = await reportQueueAge();
  const rows = await prisma.report.findMany({
    where: status ? { status } : undefined,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(before ? { cursor: { id: before }, skip: 1 } : {}),
    take: 50,
    select: {
      id: true,
      stakeId: true,
      startupId: true,
      domain: true,
      reason: true,
      status: true,
      reviewedBy: true,
      reviewedAt: true,
      note: true,
      createdAt: true,
    },
  });
  const res = apiJson(rows);
  res.headers.set("X-Report-Queue-Open", String(age.open));
  res.headers.set("X-Report-Queue-Overdue", String(age.overdue));
  res.headers.set("X-Report-Queue-Promise-Hours", String(TRIAGE_PROMISE_HOURS));
  if (age.oldestHours !== null) {
    res.headers.set("X-Report-Queue-Oldest-Hours", String(age.oldestHours));
    res.headers.set("X-Report-Queue-Oldest-At", age.oldestAt!);
  }
  return res;
}
