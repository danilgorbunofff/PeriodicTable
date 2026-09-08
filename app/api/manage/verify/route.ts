import { NextRequest, NextResponse } from "next/server";
import { consumeManageToken, manageCookieHeader } from "@/lib/manage";
import { rateLimitAsync } from "@/lib/rateStore";
import { clientIp } from "@/lib/ip";

export const dynamic = "force-dynamic";

/** Consume a one-time magic-link token → verified session cookie. */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  if (!(await rateLimitAsync(`manage-verify:${ip}`, 20, 3_600_000))) {
    return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  }
  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.token || typeof body.token !== "string") {
    return NextResponse.json({ error: "token is required." }, { status: 400 });
  }
  const result = await consumeManageToken(body.token);
  if (!result.ok) {
    return NextResponse.json({ error: "This link is invalid, used, or expired." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, domain: result.domain });
  res.headers.set("Set-Cookie", manageCookieHeader(result.sessionToken));
  return res;
}
