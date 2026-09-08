import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { shouldCountClick, hashIp } from "@/lib/clicks";
import { clientIp } from "@/lib/ip";

export const dynamic = "force-dynamic";

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
  // Hidden listings never send traffic to the destination (takedown brake).
  if (stake.startup.moderationState === "HIDDEN") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const ip = clientIp(req.headers);
  const ua = req.headers.get("user-agent") ?? "";

  if (await shouldCountClick(stakeId, ip, ua)) {
    const ipHash = hashIp(ip);
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
