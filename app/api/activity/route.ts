import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiJson } from "@/lib/route";
import { ELEMENTS } from "@/lib/elements";

export const dynamic = "force-dynamic";

const ELEMENT_NAMES = new Map(ELEMENTS.map((e) => [e.symbol, e.name] as const));

/**
 * Live activity feed (Phase 4, P2-06 display + validation matrix): stable
 * activity ids, the PAYMENT DELTA as the headline figure (never implying a
 * larger transaction), the resulting total alongside, and truthful kinds.
 */
export async function GET(req: NextRequest) {
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "6", 10) || 6, 20);
  const logs = await prisma.activityLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      domain: true,
      elementSymbol: true,
      amountUsd: true,
      deltaUsd: true,
      resultTotalUsd: true,
      kind: true,
      city: true,
      createdAt: true,
    },
  });
  return apiJson(
    logs.map((l) => ({
      id: l.id,
      domain: l.domain,
      elementSymbol: l.elementSymbol,
      elementName: ELEMENT_NAMES.get(l.elementSymbol) ?? l.elementSymbol,
      delta: l.deltaUsd ?? l.amountUsd,
      total: l.resultTotalUsd ?? l.amountUsd,
      kind: l.kind,
      city: l.city,
      createdAt: l.createdAt,
    }))
  );
}
