import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type Row = { domain: string; logoUrl: string; elementSym: string; elementName: string; total: number; totalSpent?: number };

export async function GET(req: NextRequest) {
  const tab = req.nextUrl.searchParams.get("tab") ?? "crowns";

  if (tab === "crowns") {
    // most elements led, tie-break by total staked
    const leaders = await prisma.stake.findMany({
      where: { isLeader: true },
      include: { startup: true, element: { select: { symbol: true, name: true } } },
    });
    const byDomain = new Map<string, Row>();
    for (const s of leaders) {
      const row = byDomain.get(s.startup.domain) ?? {
        domain: s.startup.domain,
        logoUrl: s.startup.logoUrl,
        elementSym: s.element.symbol,
        elementName: s.element.name,
        total: 0,
        totalSpent: 0,
      };
      row.total += 1;
      row.totalSpent = (row.totalSpent ?? 0) + s.amountUsd;
      byDomain.set(s.startup.domain, row);
    }
    const rows = [...byDomain.values()].sort((a, b) => b.total - a.total || (b.totalSpent ?? 0) - (a.totalSpent ?? 0));
    return NextResponse.json(rows);
  }

  if (tab === "by-element") {
    // biggest single-element pools
    const elements = await prisma.element.findMany({
      where: { totalPoolUsd: { gt: 0 } },
      orderBy: { totalPoolUsd: "desc" },
      take: 20,
      include: {
        stakes: { where: { isLeader: true }, include: { startup: { select: { domain: true, logoUrl: true } } } },
      },
    });
    const rows: Row[] = elements
      .map((e) => {
        const leader = e.stakes[0];
        if (!leader) return null;
        return {
          domain: leader.startup.domain,
          logoUrl: leader.startup.logoUrl,
          elementSym: e.symbol,
          elementName: e.name,
          total: e.totalPoolUsd,
        };
      })
      .filter((r): r is Row => r !== null);
    return NextResponse.json(rows);
  }

  // early: earliest claimedAt (earliest believers)
  const startups = await prisma.startup.findMany({
    orderBy: { claimedAt: "asc" },
    take: 20,
    include: {
      stakes: { include: { element: { select: { symbol: true, name: true } } } },
    },
  });
  const rows: Row[] = startups.map((s) => {
    const top = s.stakes.reduce<null | (typeof s.stakes)[number]>((best, cur) =>
      !best || cur.amountUsd > best.amountUsd ? cur : best, null);
    return {
      domain: s.domain,
      logoUrl: s.logoUrl,
      elementSym: top?.element.symbol ?? "",
      elementName: top?.element.name ?? "",
      total: s.stakes.reduce((sum, st) => sum + st.amountUsd, 0),
    };
  });
  return NextResponse.json(rows);
}
