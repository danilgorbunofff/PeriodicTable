import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const ELEMENT_NAMES: Record<string, string> = {};

export async function GET(req: NextRequest) {
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "6", 10) || 6, 20);
  const logs = await prisma.activityLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  // fill missing element names lazily
  const missing = [...new Set(logs.map((l) => l.elementSymbol).filter((s) => !ELEMENT_NAMES[s]))];
  if (missing.length) {
    const els = await prisma.element.findMany({
      where: { symbol: { in: missing } },
      select: { symbol: true, name: true },
    });
    for (const e of els) ELEMENT_NAMES[e.symbol] = e.name;
  }
  return NextResponse.json(
    logs.map((l) => ({
      domain: l.domain,
      elementSymbol: l.elementSymbol,
      elementName: ELEMENT_NAMES[l.elementSymbol] ?? l.elementSymbol,
      amount: l.amountUsd,
      kind: l.kind,
      city: l.city,
      createdAt: l.createdAt,
    }))
  );
}
