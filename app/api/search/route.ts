import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimitAsync } from "@/lib/rateStore";
import { clientIp } from "@/lib/ip";
import { apiJson, apiError } from "@/lib/route";
import type { SearchHit } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Unified search (Phase 4, P1-06). Startup rows carry every field the client
 * renders — including the destination: the startup's leading element
 * (biggest stake, earliest first), its full owned-element list (capped),
 * plus its profile URL. Element rows are plain tiles. At most 8 rows,
 * startups first.
 */
export async function GET(req: NextRequest) {
  const ip = clientIp(req.headers);
  if (!(await rateLimitAsync(`search:${ip}`, 60, 60_000))) {
    return apiError("Too many searches. Slow down.", { status: 429, code: "RATE_LIMITED" });
  }
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return apiJson([]);

  const [startups, elements] = await Promise.all([
    prisma.startup.findMany({
      where: {
        moderationState: "VISIBLE",
        OR: [{ domain: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }],
      },
      take: 6,
      select: {
        domain: true,
        title: true,
        logoUrl: true,
        // A fully reversed stake is no longer a bid: it must not surface a
        // startup as bidding somewhere (amount $0 reads as a live bid on the
        // row). elementCount is filtered the same way so the row's own numbers
        // agree with the list it renders beside.
        _count: { select: { stakes: { where: { amountUsd: { gt: 0 } } } } },
        stakes: {
          where: { amountUsd: { gt: 0 } },
          orderBy: [{ amountUsd: "desc" }, { createdAt: "asc" }, { id: "asc" }],
          take: 5,
          include: { element: { select: { symbol: true, name: true } } },
        },
      },
    }),
    prisma.element.findMany({
      where: {
        OR: [{ symbol: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }],
      },
      take: 6,
      select: { symbol: true, name: true },
    }),
  ]);

  const startupHits: SearchHit[] = startups.flatMap((s) => {
    const lead = s.stakes[0];
    if (!lead) return [];
    const elements = s.stakes.map((stake) => ({
      symbol: stake.element.symbol,
      elementName: stake.element.name,
      amount: stake.amountUsd,
    }));
    return [
      {
        type: "startup" as const,
        domain: s.domain,
        title: s.title,
        logoUrl: s.logoUrl,
        symbol: lead.element.symbol,
        elementName: lead.element.name,
        amount: lead.amountUsd,
        profileUrl: `/s/${encodeURIComponent(s.domain)}`,
        elements,
        elementCount: s._count.stakes,
      },
    ];
  });
  const elementSymbols = new Set(startupHits.map((h) => h.type === "startup" && h.symbol));
  const elementHits: SearchHit[] = elements
    .filter((e) => !elementSymbols.has(e.symbol))
    .map((e) => ({ type: "element" as const, symbol: e.symbol, elementName: e.name }));

  return apiJson([...startupHits, ...elementHits].slice(0, 8));
}
