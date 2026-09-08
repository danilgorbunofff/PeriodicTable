import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { takeLeadPrice, joinMin, reclaimFor } from "@/lib/pricing";
import { apiJson, apiError } from "@/lib/route";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { sym: string } }) {
  const symbol = decodeURIComponent(params.sym);

  const element = await prisma.element.findUnique({
    where: { symbol },
    include: {
      stakes: {
        // Hidden bidders are excluded from display; aggregates still count all.
        where: { startup: { moderationState: { not: "HIDDEN" } } },
        orderBy: [{ amountUsd: "desc" }, { createdAt: "asc" }, { id: "asc" }],
        include: {
          startup: { select: { domain: true, title: true, pitch: true, logoUrl: true, previewImgUrl: true, url: true } },
        },
      },
    },
  });

  if (!element) return apiError("Element not found", { status: 404, code: "NOT_FOUND" });

  const leaderTotal = element.stakes[0]?.amountUsd;

  const stakes = element.stakes.map((s, i) => ({
    stakeId: s.id,
    domain: s.startup.domain,
    title: s.startup.title,
    pitch: s.startup.pitch,
    logo: s.startup.logoUrl,
    preview: s.startup.previewImgUrl ?? null,
    siteUrl: s.startup.url,
    amount: s.amountUsd,
    clicks: s.clicksDelivered,
    rank: i + 1,
    isLeader: i === 0,
  }));

  const meParam = req.nextUrl.searchParams.get("me");
  let reclaim: number | undefined;
  if (meParam) {
    const mine = element.stakes.find((s) => s.startup.domain === meParam);
    reclaim = reclaimFor(leaderTotal, mine?.amountUsd);
  }

  return apiJson(
    {
      symbol: element.symbol,
      name: element.name,
      atomicMass: element.atomicMass,
      family: element.family,
      tier: element.tier,
      pool: element.totalPoolUsd,
      count: element.stakeCount,
      stakes,
      prices: {
        takeLead: takeLeadPrice(leaderTotal),
        joinMin: joinMin(),
        ...(reclaim !== undefined ? { reclaim } : {}),
      },
    },
    { headers: { "Cache-Control": "s-maxage=10, stale-while-revalidate=30" } }
  );
}
