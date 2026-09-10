import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiJson } from "@/lib/route";
import { ELEMENTS } from "@/lib/elements";

export const dynamic = "force-dynamic";

const ELEMENT_NAMES = new Map(ELEMENTS.map((e) => [e.symbol, e.name] as const));

/**
 * Live activity feed (Phase 4, P2-06 display + validation matrix): stable
 * activity ids, the PAYMENT DELTA as the headline figure (never implying a
 * larger transaction), the resulting total alongside, and truthful kinds.
 */
export async function GET(req: NextRequest) {
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "6", 10) || 6, 20);

  // ActivityLog keeps a denormalised domain string, so visibility is resolved
  // against Startup here. Hidden listings must not appear: this feed publishes
  // domain, city, and amount, which would undo the concealment that hiding is
  // for. UNLISTED stays in — it is already shown on tiles and element detail,
  // so omitting it would conceal nothing. Filtering in the query (not after
  // the take) keeps the requested page size exact.
  const hiddenDomains = (
    await prisma.startup.findMany({ where: { moderationState: "HIDDEN" }, select: { domain: true } })
  ).map((s) => s.domain);

  const logs = await prisma.activityLog.findMany({
    where: hiddenDomains.length ? { domain: { notIn: hiddenDomains } } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      domain: true,
      elementSymbol: true,
      amountUsd: true,
      deltaUsd: true,
      resultTotalUsd: true,
      kind: true,
      city: true,
      createdAt: true,
    },
  });

  // Resolve the live stake behind each event so rows can deep-link straight
  // to the paying user's site via the attributed /go/:stakeId redirect.
  const pairs = [...new Set(logs.map((l) => `${l.domain}|${l.elementSymbol}`))].map((k) => {
    const [domain, symbol] = k.split("|");
    return { startup: { domain }, element: { symbol } };
  });
  const stakeRows = pairs.length
    ? await prisma.stake.findMany({
        where: { OR: pairs },
        select: { id: true, element: { select: { symbol: true } }, startup: { select: { domain: true } } },
      })
    : [];
  const stakeBy = new Map(stakeRows.map((s) => [`${s.startup.domain}|${s.element.symbol}`, s.id] as const));

  return apiJson(
    logs.map((l) => ({
      id: l.id,
      domain: l.domain,
      elementSymbol: l.elementSymbol,
      elementName: ELEMENT_NAMES.get(l.elementSymbol) ?? l.elementSymbol,
      delta: l.deltaUsd ?? l.amountUsd,
      total: l.resultTotalUsd ?? l.amountUsd,
      kind: l.kind,
      city: l.city,
      createdAt: l.createdAt,
      stakeId: stakeBy.get(`${l.domain}|${l.elementSymbol}`) ?? null,
    }))
  );
}
