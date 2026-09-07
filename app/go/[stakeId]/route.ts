import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const BOTS = /bot|crawl|spider|slurp|headless|preview|curl|wget|python-requests/i;

export async function GET(req: NextRequest, { params }: { params: { stakeId: string } }) {
  const { stakeId } = params;

  const stake = await prisma.stake.findUnique({
    where: { id: stakeId },
    include: { startup: true },
  });
  // Deleted stake or dead URL still 404s; counting happens only for live stakes.
  if (!stake || !stake.startup?.url) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "0.0.0.0";
  const ua = req.headers.get("user-agent") ?? "";

  const isBot = BOTS.test(ua);
  const perStakeOk = rateLimit(`s:${stakeId}:${ip}`, 1, 10_000);
  const perIpOk = rateLimit(`ip:${ip}`, 30, 3_600_000);

  if (!isBot && perStakeOk && perIpOk) {
    const ipHash = createHash("sha256")
      .update(`${ip}:${process.env.CLICK_SALT ?? "ptl-dev-salt"}`)
      .digest("hex");
    try {
      await prisma.$transaction([
        prisma.clickEvent.create({
          data: { stakeId: stake.id, ipHash, userAgent: ua.slice(0, 256) },
        }),
        prisma.stake.update({
          where: { id: stake.id },
          data: { clicksDelivered: { increment: 1 } },
        }),
      ]);
    } catch {
      // Counting must never block the redirect.
    }
  }

  return NextResponse.redirect(stake.startup.url, {
    status: 302,
    headers: { "Cache-Control": "no-store" },
  });
}
