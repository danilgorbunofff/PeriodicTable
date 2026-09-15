import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { takeLeadPrice, joinMin, reclaimFor } from "@/lib/pricing";
import { apiJson, apiError, READ_CACHE } from "@/lib/route";
import { findElementBySymbol } from "@/lib/elements";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { sym: string } }) {
  const raw = decodeURIComponent(params.sym);
  // Canonical casing (R04-4): `/api/elements/au` and `/api/elements/AU` must
  // price the element `/api/elements/Au` prices. The canonical form comes from
  // the element inventory — never from uppercasing, which mangles `Hbar`/`Ps`.
  const symbol = findElementBySymbol(raw)?.symbol ?? raw;

  // Concealed listings are the one thing the board below cannot show. Counting
  // them alongside the read lets the payload say whether `stakes` is the whole
  // board (R04-2) without a second round-trip.
  const [element, hiddenStakes] = await Promise.all([
    prisma.element.findUnique({
      where: { symbol },
      include: {
        stakes: {
          // Hidden bidders are excluded from display; aggregates still count all.
          where: { startup: { moderationState: { not: "HIDDEN" } } },
          orderBy: [{ amountUsd: "desc" }, { createdAt: "asc" }, { id: "asc" }],
          include: {
            startup: { select: { domain: true, title: true, pitch: true, logoUrl: true, previewImgUrl: true, url: true } },
          },
        },
      },
    }),
    prisma.stake.count({ where: { element: { symbol }, startup: { moderationState: "HIDDEN" } } }),
  ]);

  if (!element) return apiError("Element not found", { status: 404, code: "NOT_FOUND" });

  // Leader is the top LIVE bid, not simply row 0: a fully reversed stake sits
  // last with amountUsd 0, and reading it as the leader would advertise a $1
  // takeover (takeLeadPrice(0)) on an element whose real floor is $5.
  const leaderIdx = element.stakes.findIndex((s) => s.amountUsd > 0);
  const leaderTotal = leaderIdx === -1 ? undefined : element.stakes[leaderIdx].amountUsd;

  const stakes = element.stakes.map((s, i) => ({
    stakeId: s.id,
    domain: s.startup.domain,
    title: s.startup.title,
    pitch: s.startup.pitch,
    logo: s.startup.logoUrl,
    preview: s.startup.previewImgUrl ?? null,
    siteUrl: s.startup.url,
    amount: s.amountUsd,
    clicks: s.clicksDelivered,
    rank: i + 1,
    isLeader: i === leaderIdx,
  }));

  const meParam = req.nextUrl.searchParams.get("me");
  let reclaim: number | undefined;
  if (meParam) {
    // `?me=` is caller-asserted and this response is publicly cached, so the
    // answer stays confined to rows the board already shows: pricing a
    // concealed domain from here would make a moderation state readable by
    // asking for it. `prices.boardComplete` tells the client how much of the
    // board it is looking at instead.
    const mine = element.stakes.find((s) => s.startup.domain === meParam);
    reclaim = reclaimFor(leaderTotal, mine?.amountUsd);
  }

  return apiJson(
    {
      symbol: element.symbol,
      name: element.name,
      atomicMass: element.atomicMass,
      family: element.family,
      tier: element.tier,
      pool: element.totalPoolUsd,
      count: element.stakeCount,
      stakes,
      prices: {
        takeLead: takeLeadPrice(leaderTotal),
        joinMin: joinMin(),
        // False when a concealed listing could be the caller's own (R04-2):
        // a client may only promise a take-quote hold, or restate a fresh
        // amount, on a board it can see whole.
        boardComplete: hiddenStakes === 0,
        ...(reclaim !== undefined ? { reclaim } : {}),
      },
    },
    { headers: READ_CACHE }
  );
}
