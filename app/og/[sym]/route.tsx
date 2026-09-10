import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** OG image (Phase 4, spec 02). SVG to avoid native deps: navy bg, tile, #1 domain $price. */
export async function GET(_req: NextRequest, { params }: { params: { sym: string } }) {
  const symbol = decodeURIComponent(params.sym);
  const element = await prisma.element.findUnique({
    where: { symbol },
    include: {
      stakes: { where: { amountUsd: { gt: 0 } }, orderBy: { amountUsd: "desc" }, take: 1, include: { startup: { select: { domain: true } } } },
    },
  });
  if (!element) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const leader = element.stakes[0];
  const line = leader ? `#1 ${leader.startup.domain} $${leader.amountUsd}` : "Unclaimed · from $5";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#05070A"/><rect x="80" y="120" width="220" height="240" rx="24" fill="#fff"/><text x="190" y="220" font-family="Arial" font-size="72" font-weight="bold" text-anchor="middle" fill="#111">${element.symbol}</text><text x="190" y="260" font-family="Arial" font-size="28" text-anchor="middle" fill="#555">${element.name}</text><text x="360" y="220" font-family="Arial" font-size="56" font-weight="bold" fill="#fff">${line}</text><text x="360" y="280" font-family="Arial" font-size="32" fill="#FFC93C">periodictable.lol</text></svg>`;
  return new NextResponse(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400" } });
}
