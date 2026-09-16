import { NextRequest, NextResponse } from "next/server";
import { getManageSession, MANAGE_COOKIE } from "@/lib/manage";
import { apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: getWhoManages });

/** Who manages what in this browser (for profile-edit UI). */
async function getWhoManages(req: NextRequest) {
  const session = await getManageSession(req.cookies.get(MANAGE_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "No management session." }, { status: 401 });
  return NextResponse.json({ ok: true, domain: session.domain });
}
