import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/** Report / takedown intake (Phase 4). Rate-limited, always 200 to avoid oracle. */
export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "0.0.0.0";
  if (!rateLimit(`report:${ip}`, 10, 3_600_000)) {
    return NextResponse.json({ ok: true, note: "rate-limited" });
  }
  let body: { stakeId?: string; domain?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const reason = (body.reason ?? "").toString().slice(0, 280).trim() || "reported listing";
  const stakeId = typeof body.stakeId === "string" ? body.stakeId.slice(0, 64) : null;
  let domain = typeof body.domain === "string" ? body.domain.slice(0, 128) : null;
  if (stakeId && !domain) {
    const stake = await prisma.stake.findUnique({
      where: { id: stakeId },
      include: { startup: { select: { domain: true } } },
    });
    domain = stake?.startup.domain ?? null;
  }
  const ipHash = createHash("sha256")
    .update(`${ip}:${process.env.CLICK_SALT ?? "ptl-dev-salt"}`)
    .digest("hex");
  await prisma.report.create({ data: { stakeId, domain, reason, ipHash } });
  return NextResponse.json({ ok: true });
}
