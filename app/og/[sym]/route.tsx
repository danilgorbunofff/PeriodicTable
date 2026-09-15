import { NextRequest, NextResponse } from "next/server";
import { ELEMENTS, findElementBySymbol } from "@/lib/elements";
import { prisma } from "@/lib/prisma";
import { ogCard, renderOgCardSvg, type OgCardLeader } from "@/lib/ogCard";
import { renderCardPng } from "@/lib/ogCardImage";

export const dynamic = "force-dynamic";

const CACHE = { "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400" };

/**
 * OG card (Phase 4 spec 02; PNG since R01-2): navy bg, tile, `#1 domain $price`.
 * next/og renders PNG because the unfurlers that matter reject SVG; the SVG card
 * stays as the fallback when the renderer fails, and a card drawn without a
 * database read says so instead of asserting an unread leader (R02-4's rule).
 */
export async function GET(_req: NextRequest, { params }: { params: { sym: string } }) {
  // Canonical casing (R04-4): the card is shared by URL, so `/og/au` must draw
  // the same element as `/og/Au`.
  const raw = decodeURIComponent(params.sym);
  const symbol = findElementBySymbol(raw)?.symbol ?? raw;
  const face = await loadFace(symbol);
  if (!face) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const card = ogCard({ symbol, name: face.name, leader: face.leader, unavailable: face.unavailable });
  const png = await renderCardPng(card);
  if (png) return new NextResponse(png, { headers: { ...CACHE, "Content-Type": "image/png" } });
  return new NextResponse(renderOgCardSvg(card), { headers: { ...CACHE, "Content-Type": "image/svg+xml" } });
}

/** The live half of the card, or null when the symbol is not an element. A
 *  failed read falls back to the static element table with `unavailable` set. */
async function loadFace(
  symbol: string
): Promise<{ name: string; leader: OgCardLeader | null; unavailable: boolean } | null> {
  try {
    const element = await withColdStartRetry(() => readElement(symbol));
    if (!element) return null;
    const leader = element.stakes[0];
    return {
      name: element.name,
      leader: leader ? { domain: leader.startup.domain, amountUsd: leader.amountUsd } : null,
      unavailable: false,
    };
  } catch {
    const el = ELEMENTS.find((e) => e.symbol === symbol);
    return el ? { name: el.name, leader: null, unavailable: true } : null;
  }
}

function readElement(symbol: string) {
  return prisma.element.findUnique({
    where: { symbol },
    include: {
      stakes: {
        where: { amountUsd: { gt: 0 } },
        orderBy: { amountUsd: "desc" },
        take: 1,
        include: { startup: { select: { domain: true } } },
      },
    },
  });
}

/**
 * Unfurls are one-shot: the crawler stores whatever this returns, and the
 * fallback card is what it keeps. Neon suspends idle computes, so the first
 * query of the day can fail on connect alone — retry only that class (P1001
 * unreachable, P1002 connect timeout, P1017 connection closed, P2024 pool
 * timeout) and let anything else fall through to the fallback card.
 */
const COLD_START_CODES = new Set(["P1001", "P1002", "P1017", "P2024"]);

async function withColdStartRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (attempt >= attempts || !code || !COLD_START_CODES.has(code)) throw e;
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
}
