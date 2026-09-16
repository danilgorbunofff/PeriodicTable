import { prisma } from "@/lib/prisma";
import { apiJson, READ_CACHE, apiRoute } from "@/lib/route";
import { FACE_STAKE_WHERE } from "@/lib/moderation";
import { cellOf } from "@/lib/gridGeometry";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: listElements });

async function listElements() {
  const elements = await prisma.element.findMany({
    orderBy: { id: "asc" },
    include: {
      // Top directly-visible LIVE stake owns the tile face. Hidden listings
      // never do, and neither does a fully reversed stake (amount 0): keeping
      // the face after a chargeback would hand over the very inventory the
      // reversal was supposed to give up. Aggregates still count every stake.
      stakes: {
        where: FACE_STAKE_WHERE,
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
      // Coordinates come from the dataset the board renders, not from the
      // seeded column mirror (R03-1): a seed older than the last reposition
      // would otherwise advertise a tile position the pictures contradict.
      gridRow: cellOf(e.symbol)?.gridRow ?? e.gridRow,
      gridCol: cellOf(e.symbol)?.gridCol ?? e.gridCol,
      family: e.family,
      tier: e.tier,
      // Deliberately hidden-inclusive (see the stakes filter above): the money
      // stays in the totals even when the listing is concealed. These are
      // aggregates only — `count` must never reach the UI, because a badge
      // driven by it would reveal that a concealed stake exists. The tile face
      // is `leader` alone, and the headline claim count in `/api/stats` uses
      // the same face predicate, so the two can no longer disagree (R03-2).
      pool: e.totalPoolUsd,
      count: e.stakeCount,
      leader: leader
        ? { domain: leader.startup.domain, logoUrl: leader.startup.logoUrl, amount: leader.amountUsd }
        : null,
    };
  });

  return apiJson(tiles, { headers: READ_CACHE });
}
