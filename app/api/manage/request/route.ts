import { NextRequest, NextResponse } from "next/server";
import { requestManageToken } from "@/lib/manage";
import { rateLimitAsync } from "@/lib/rateStore";
import { clientIp } from "@/lib/ip";
import { apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ POST: requestManageLink });

/**
 * Request a management magic link for a startup domain. Always 200 with the
 * same shape (no oracle for domain enumeration). Rate-limited per IP.
 *
 * NOT SHIPPED IN v1: listing edits have no UI and production emails nothing,
 * so the note below must not promise delivery (see lib/manage.ts). The raw token
 * leaves this route only in a development process that set DEV_MANAGE_TOKENS=1
 * (R14-7), under the name `__devToken`.
 */
async function requestManageLink(req: NextRequest) {
  const ip = clientIp(req.headers);
  if (!(await rateLimitAsync(`manage:${ip}`, 10, 3_600_000))) {
    return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  }
  let body: { domain?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.domain || typeof body.domain !== "string") {
    return NextResponse.json({ error: "domain is required." }, { status: 400 });
  }
  if (!body.email || typeof body.email !== "string") {
    return NextResponse.json({ error: "email is required." }, { status: 400 });
  }
  const result = await requestManageToken({ domain: body.domain, email: body.email });
  return NextResponse.json({
    ok: true,
    note: "Listing management is not enabled — your listing is set at checkout and is final.",
    ...(result.__devToken ? { __devToken: result.__devToken } : {}),
  });
}
