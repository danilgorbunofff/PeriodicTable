import { prisma } from "@/lib/prisma";
import { apiJson } from "@/lib/route";
import { aggregateTableOrder } from "@/lib/boards";

export const dynamic = "force-dynamic";

/**
 * Table Order rail source (Phase 4, P1-10): total cumulative spend across
 * EVERY startup stake (not leaders only), crown counts, deterministic
 * order. Top 10 — matches the rail's TOP 10 · MOST SPENT header.
 */
export async function GET() {
  const stakes = await prisma.stake.findMany({
    where: { startup: { moderationState: "VISIBLE" } },
    select: {
      id: true,
      amountUsd: true,
      isLeader: true,
      createdAt: true,
      startup: { select: { domain: true, logoUrl: true } },
      element: { select: { symbol: true } },
    },
  });
  const rows = aggregateTableOrder(
    stakes.map((s) => ({
      domain: s.startup.domain,
      logoUrl: s.startup.logoUrl,
      amountUsd: s.amountUsd,
      isLeader: s.isLeader,
      elementSymbol: s.element.symbol,
      elementName: s.element.symbol,
      id: s.id,
      createdAt: s.createdAt,
    }))
  ).slice(0, 10);
  return apiJson(rows);
}
