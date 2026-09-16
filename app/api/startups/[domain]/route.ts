import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getManageSession, MANAGE_COOKIE } from "@/lib/manage";
import { validateProfileInput } from "@/lib/validate";
import { rateLimitAsync } from "@/lib/rateStore";
import { clientIp } from "@/lib/ip";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Verified-owner profile update (Phase 1). Requires a management session
 * cookie for the SAME domain. Updatable: title, pitch, url, linkType, logoUrl.
 * Domain and history never change here.
 *
 * R10-2: `email` is no longer writable. The notification address is set at
 * checkout and is final in v1 — and, more to the point, writing it was the
 * "way back" that the unsubscribe flow was documented to depend on, which made
 * a preference about mail depend on a magic link production does not send (see
 * R10-5). Un-muting is the unsubscribe page's own action now, so nothing has to
 * write this field: a request that supplies it is refused rather than silently
 * ignored, because a dropped field reads to the caller as a saved one.
 */
export async function PATCH(req: NextRequest, { params }: { params: { domain: string } }) {
  const ip = clientIp(req.headers);
  if (!(await rateLimitAsync(`profile:${ip}`, 30, 3_600_000))) {
    return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  }
  const domain = decodeURIComponent(params.domain).trim().toLowerCase();
  const session = await getManageSession(req.cookies.get(MANAGE_COOKIE)?.value);
  if (!session || session.domain !== domain) {
    return NextResponse.json({ error: "A verified management session for this domain is required." }, { status: 401 });
  }
  let body: {
    url?: string;
    linkType?: string;
    title?: string;
    pitch?: string;
    email?: string | null;
    logoUrl?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.email !== undefined) {
    return NextResponse.json(
      { error: "The notification email is set at checkout and cannot be changed here.", field: "email" },
      { status: 400 }
    );
  }
  const input = validateProfileInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error, field: input.field }, { status: 400 });

  const changed: string[] = ["title", "pitch", "url", "linkType"];
  const data: {
    title: string;
    pitch: string;
    url: string;
    linkType: string;
    logoUrl?: string;
  } = { title: input.title, pitch: input.pitch, url: input.url, linkType: input.linkType };
  if (body.logoUrl != null && body.logoUrl !== "") {
    data.logoUrl = body.logoUrl.trim();
    changed.push("logoUrl");
  }
  const startup = await prisma.startup.update({ where: { domain }, data });
  await audit({
    action: "PROFILE_UPDATED",
    startupId: startup.id,
    actorType: "owner",
    detail: changed.join(","),
  });
  return NextResponse.json({ ok: true, domain: startup.domain });
}
