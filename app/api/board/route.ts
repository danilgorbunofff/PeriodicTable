import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiJson, apiError, apiRoute } from "@/lib/route";
import { aggregateEarlyAdopters, rankByElement, rankCrowns, rankEarlyAdopters } from "@/lib/boards";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: listBoard });

/**
 * Leaderboards with three DISTINCT metrics (Phase 4, P1-10):
 * - by-element: biggest single-territory (leader) stake
 * - crowns: #1 seat count, then cumulative spend
 * - early: first-claim medals from immutable FirstClaim records
 */
async function listBoard(req: NextRequest) {
  const tab = req.nextUrl.searchParams.get("tab") ?? "crowns";

  if (tab === "crowns") {
    // R15-4: no `take` here on purpose, and the reason is not laziness. This is
    // an aggregate over *all* leader stakes — one row per element, because a
    // seat has exactly one holder — and the result is ranked after
    // aggregation. A `take` would truncate the input to the top-N by amount and
    // silently undercount crowns for every domain below that cut, so the list
    // would be wrong rather than merely short. The row count is bounded by the
    // inventory (one leader per element, `Element.currentLeaderId`), which is
    // the one dimension the product plans to grow; the fix for that is the
    // index the `isLeader` predicate lacked (`0011_leader_index`, mirroring the
    // partial-index precedent in `0001_phase1_ownership`), not a ceiling that
    // changes the answer.
    const leaders = await prisma.stake.findMany({
      where: { isLeader: true, startup: { moderationState: "VISIBLE" } },
      select: {
        amountUsd: true,
        startup: { select: { domain: true, logoUrl: true } },
      },
    });
    const byDomain = new Map<string, { logoUrl: string; crowns: number; totalSpent: number }>();
    for (const s of leaders) {
      const row = byDomain.get(s.startup.domain) ?? { logoUrl: s.startup.logoUrl, crowns: 0, totalSpent: 0 };
      row.crowns += 1;
      row.totalSpent += s.amountUsd;
      row.logoUrl = s.startup.logoUrl;
      byDomain.set(s.startup.domain, row);
    }
    return apiJson(
      rankCrowns([...byDomain.entries()].map(([domain, r]) => ({ domain, ...r })))
    );
  }

  if (tab === "by-element") {
    const leaders = await prisma.stake.findMany({
      where: { isLeader: true, startup: { moderationState: "VISIBLE" } },
      orderBy: [{ amountUsd: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 20,
      select: {
        id: true,
        amountUsd: true,
        createdAt: true,
        startup: { select: { domain: true, logoUrl: true } },
        element: { select: { symbol: true, name: true } },
      },
    });
    return apiJson(
      rankByElement(
        leaders.map((l) => ({
          domain: l.startup.domain,
          logoUrl: l.startup.logoUrl,
          amountUsd: l.amountUsd,
          elementSymbol: l.element.symbol,
          elementName: l.element.name,
          createdAt: l.createdAt,
          id: l.id,
        }))
      )
    );
  }

  if (tab === "early") {
    // R15-4: same as `crowns` — the medals are per domain across all elements
    // and are ranked after aggregation, so a `take` would drop medals from the
    // bottom of the amount ordering. Bounded by the inventory: `FirstClaim`
    // keys on `elementId`, so one row per element at most.
    const claims = await prisma.firstClaim.findMany({
      where: { startup: { moderationState: "VISIBLE" } },
      // Stability only — aggregateEarlyAdopters is order-independent by design.
      orderBy: [{ claimedAt: "asc" }, { elementId: "asc" }],
      select: {
        claimedAt: true,
        startup: { select: { domain: true, logoUrl: true } },
        element: { select: { symbol: true, name: true } },
      },
    });
    return apiJson(
      rankEarlyAdopters(
        aggregateEarlyAdopters(
          claims.map((c) => ({
            domain: c.startup.domain,
            logoUrl: c.startup.logoUrl,
            elementSymbol: c.element.symbol,
            elementName: c.element.name,
            claimedAt: c.claimedAt,
          }))
        )
      )
    );
  }

  return apiError("Unknown board tab.", { status: 400, code: "BAD_TAB" });
}
