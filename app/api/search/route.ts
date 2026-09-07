import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "0.0.0.0";
  if (!rateLimit(`search:${ip}`, 60, 60_000)) {
    return NextResponse.json({ error: "Too many searches. Slow down." }, { status: 429 });
  }
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json([]);

  const [startups, elements] = await Promise.all([
    prisma.startup.findMany({
      where: {
        OR: [{ domain: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }],
      },
      take: 6,
      select: { domain: true, title: true },
    }),
    prisma.element.findMany({
      where: {
        OR: [
          { symbol: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
        ],
      },
      take: 6,
      select: { symbol: true, name: true },
    }),
  ]);

  const results = [
    ...startups.map((s) => ({ type: "startup" as const, domain: s.domain, name: s.title })),
    ...elements.map((e) => ({ type: "element" as const, symbol: e.symbol, name: e.name })),
  ].slice(0, 8);

  return NextResponse.json(results);
}
