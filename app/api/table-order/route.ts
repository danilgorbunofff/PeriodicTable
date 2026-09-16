import { prisma } from "@/lib/prisma";
import { apiJson, apiRoute } from "@/lib/route";
import { aggregateTableOrder } from "@/lib/boards";
import { demoListingDomains, isDemoListing } from "@/lib/demoData";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: listTableOrder });

/**
 * Table Order rail source (Phase 4, P1-10): total cumulative spend across
 * EVERY startup stake (not leaders only), crown counts, deterministic
 * order. Top 10 — matches the rail's TOP 10 · MOST SPENT header.
 */
async function listTableOrder() {
  // R16-9: "TOP 10 · MOST SPENT" is a claim about money. The seeder's rows are
  // in it with amounts nobody paid, so they are marked here too.
  const demoDomains = await demoListingDomains();
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
      id: s.id,
      createdAt: s.createdAt,
    }))
  )
    .slice(0, 10)
    .map((r) =>
      isDemoListing(r.domain, demoDomains) ? { ...r, demo: true } : r,
    );
  return apiJson(rows);
}
