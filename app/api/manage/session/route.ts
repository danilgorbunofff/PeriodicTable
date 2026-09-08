import { NextRequest, NextResponse } from "next/server";
import { getManageSession, MANAGE_COOKIE } from "@/lib/manage";

export const dynamic = "force-dynamic";

/** Who manages what in this browser (for profile-edit UI). */
export async function GET(req: NextRequest) {
  const session = await getManageSession(req.cookies.get(MANAGE_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "No management session." }, { status: 401 });
  return NextResponse.json({ ok: true, domain: session.domain });
}
