import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const elements = await prisma.element.findMany({
    orderBy: { id: "asc" },
    include: {
      stakes: {
        where: { isLeader: true },
        include: { startup: { select: { domain: true, logoUrl: true } } },
      },
    },
  });

  const tiles = elements.map((e) => {
    const leader = e.stakes[0];
    return {
      symbol: e.symbol,
      name: e.name,
      gridRow: e.gridRow,
      gridCol: e.gridCol,
      family: e.family,
      tier: e.tier,
      pool: e.totalPoolUsd,
      count: e.stakeCount,
      leader: leader
        ? { domain: leader.startup.domain, logoUrl: leader.startup.logoUrl, amount: leader.amountUsd }
        : null,
    };
  });

  return NextResponse.json(tiles, {
    headers: { "Cache-Control": "s-maxage=10, stale-while-revalidate=30" },
  });
}
