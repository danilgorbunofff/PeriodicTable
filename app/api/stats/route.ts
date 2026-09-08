import { prisma } from "@/lib/prisma";
import { apiJson } from "@/lib/route";
import type { StatsResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

let cache: { at: number; data: StatsResponse } | null = null;
const TTL = 30_000;

/**
 * Homepage stats with exact quantities and units (Phase 4, P1-09):
 * total tiles, claimed tiles, unclaimed tiles, total stake rows, and total
 * staked USD (summed — not a row count wearing a dollar sign).
 */
export async function GET() {
  if (cache && Date.now() - cache.at < TTL) {
    return apiJson(cache.data);
  }
  const [elementsTotal, claimedElements, pool] = await Promise.all([
    prisma.element.count(),
    prisma.element.count({ where: { stakeCount: { gt: 0 } } }),
    prisma.stake.aggregate({ _count: { _all: true }, _sum: { amountUsd: true } }),
  ]);
  const data: StatsResponse = {
    elementsTotal,
    claimedElements,
    unclaimedElements: elementsTotal - claimedElements,
    stakeCount: pool._count._all,
    totalStakedUsd: pool._sum.amountUsd ?? 0,
  };
  cache = { at: Date.now(), data };
  return apiJson(data);
}
