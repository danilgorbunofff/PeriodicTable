import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminAuth } from "@/lib/jobs";
import { apiJson } from "@/lib/route";

export const dynamic = "force-dynamic";

/** Operator report queue (takedown runbook: triage <24h). Bounded, newest first. */
export async function GET(req: NextRequest) {
  const denied = adminAuth(req);
  if (denied) return denied;
  const status = req.nextUrl.searchParams.get("status");
  const rows = await prisma.report.findMany({
    where: status ? { status: status as "OPEN" | "TRIAGED" | "ACTIONED" | "DISMISSED" } : undefined,
    orderBy: { createdAt: "desc" },
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
  return apiJson(rows);
}
