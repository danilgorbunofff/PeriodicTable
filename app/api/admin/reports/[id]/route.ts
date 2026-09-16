import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminGate } from "@/lib/jobs";
import { apiJson, apiError, apiRoute } from "@/lib/route";
import { isReportStatus, type ReportStatus } from "@/lib/api";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ PATCH: patchReport });

/** Triage a report: processing state + operator detail (never deletes stakes). */
async function patchReport(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await adminGate(req, "admin/reports/[id]");
  if (denied) return denied;
  let body: { status?: string; note?: string; reviewedBy?: string };
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body.", { status: 400 });
  }
  if (body.status && !isReportStatus(body.status)) {
    return apiError("Unknown report status.", { status: 400, code: "BAD_STATUS" });
  }
  const report = await prisma.report.findUnique({ where: { id: params.id } });
  if (!report) return apiError("Report not found.", { status: 404, code: "NOT_FOUND" });
  const updated = await prisma.report.update({
    where: { id: params.id },
    data: {
      ...(body.status ? { status: body.status as ReportStatus } : {}),
      ...(body.note !== undefined ? { note: String(body.note).slice(0, 500) } : {}),
      reviewedBy: typeof body.reviewedBy === "string" ? body.reviewedBy.slice(0, 120) : "operator",
      reviewedAt: new Date(),
    },
  });
  await audit({
    action: "REPORT_TRIAGED",
    startupId: report.startupId,
    actorType: "operator",
    actorRef: updated.reviewedBy,
    detail: `${updated.status}${updated.note ? ` — ${updated.note}` : ""}`.slice(0, 300),
  });
  return apiJson({ ok: true, id: updated.id, status: updated.status });
}
