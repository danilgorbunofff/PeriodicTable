import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { takeLeadPrice, joinMin, reclaimFor } from "@/lib/pricing";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ sym: string }> }) {
  const { sym } = await params;
  const symbol = decodeURIComponent(sym);

  const element = await prisma.element.findUnique({
    where: { symbol },
    include: {
      stakes: {
        orderBy: { amountUsd: "desc" },
        include: { startup: { select: { domain: true, title: true, pitch: true, logoUrl: true } } },
      },
    },
  });

  if (!element) return NextResponse.json({ error: "Element not found" }, { status: 404 });

  const leaderTotal = element.stakes[0]?.amountUsd;

  const stakes = element.stakes.map((s, i) => ({
    stakeId: s.id,
    domain: s.startup.domain,
    title: s.startup.title,
    pitch: s.startup.pitch,
    logo: s.startup.logoUrl,
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

  return NextResponse.json(
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
