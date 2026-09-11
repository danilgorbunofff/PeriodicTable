import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DIRECT_STATES } from "@/lib/moderation";

export const dynamic = "force-dynamic";

export async function GET() {
  const elements = await prisma.element.findMany({
    orderBy: { id: "asc" },
    include: {
      // Top directly-visible LIVE stake owns the tile face. Hidden listings
      // never do, and neither does a fully reversed stake (amount 0): keeping
      // the face after a chargeback would hand over the very inventory the
      // reversal was supposed to give up. Aggregates still count every stake.
      stakes: {
        where: { startup: { moderationState: { in: DIRECT_STATES } }, amountUsd: { gt: 0 } },
        orderBy: { rank: "asc" },
        take: 1,
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
      // Deliberately hidden-inclusive (see the stakes filter above): the money
      // stays in the totals even when the listing is concealed. These are
      // aggregates only — `count` must never reach the UI, because a badge
      // driven by it would reveal that a concealed stake exists. The tile face
      // is `leader` alone.
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
