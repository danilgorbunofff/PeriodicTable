import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

let cache: { at: number; data: { elementsLive: number; totalBids: number; onSale: number } } | null = null;
const TTL = 30_000;

export async function GET() {
  if (cache && Date.now() - cache.at < TTL) {
    return NextResponse.json(cache.data);
  }
  const [elementsLive, stakes] = await Promise.all([
    prisma.element.count(),
    prisma.stake.findMany({ select: { startupId: true }, distinct: ["startupId"] }),
  ]);
  const totalBids = await prisma.stake.count();
  const onSale = stakes.length;
  const data = { elementsLive, totalBids, onSale };
  cache = { at: Date.now(), data };
  return NextResponse.json(data);
}
