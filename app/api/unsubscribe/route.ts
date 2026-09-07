import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** One-click unsubscribe by token (from email footers). Clears startup.email. */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  const startup = await prisma.startup.findFirst({ where: { unsubToken: token } });
  if (!startup) {
    // Idempotent: unknown token still shows the friendly page.
    return NextResponse.redirect(new URL("/?unsub=unknown", req.nextUrl.origin));
  }
  await prisma.startup.update({ where: { id: startup.id }, data: { email: null } });
  return NextResponse.redirect(new URL("/?unsub=done", req.nextUrl.origin));
}
