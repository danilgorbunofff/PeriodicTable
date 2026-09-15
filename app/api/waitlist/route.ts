import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/manage";
import { domainFromUrl } from "@/lib/validate";
import { rateLimitAsync } from "@/lib/rateStore";
import { clientIp } from "@/lib/ip";
import { hashIp } from "@/lib/clicks";
import { audit } from "@/lib/audit";
import { enqueueOutbox, drainDueWithin } from "@/lib/outbox";

export const dynamic = "force-dynamic";

/**
 * Waitlist intake (Phase 1 storage; Phase 2 wires the paused-checkout path
 * to it). Validated + normalized; one row per email (re-submits refresh
 * consent, never duplicate).
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  if (!(await rateLimitAsync(`waitlist:${ip}`, 10, 3_600_000))) {
    return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  }
  let body: { email?: string; domain?: string; source?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : null;
  if (!email) return NextResponse.json({ error: "A valid email is required.", field: "email" }, { status: 400 });
  let domain: string | null = null;
  if (typeof body.domain === "string" && body.domain.trim()) {
    const raw = body.domain.trim();
    domain = raw.includes("://") || raw.includes(".") ? (domainFromUrl(`https://${raw.replace(/^https?:\/\//, "")}`) ?? raw.toLowerCase()) : raw.toLowerCase();
  }
  const source =
    typeof body.source === "string" && body.source.length > 0 && body.source.length <= 64
      ? body.source
      : "checkout-paused";
  const entry = await prisma.waitlistEntry.upsert({
    where: { email },
    create: { email, domain, source },
    update: { domain, source, consentAt: new Date() },
  });
  await audit({ action: "WAITLIST_JOINED", detail: email, actorRef: hashIp(ip) });
  await confirmWaitlist({ email, domain, source });
  return NextResponse.json({ ok: true, id: entry.id });
}

/**
 * Confirmation mail for the paused-checkout path (R05-7), where the UI says
 * "we'll be in touch". Deduped per address per hour so a re-submit cannot
 * become a mail loop; a genuinely later re-join still gets its own message.
 * Bounded like the report notice; the outbox row survives for the cron.
 */
async function confirmWaitlist(entry: { email: string; domain: string | null; source: string }) {
  try {
    await enqueueOutbox(prisma, {
      type: "WAITLIST_EMAIL",
      payload: { to: entry.email, domain: entry.domain, source: entry.source },
      dedupeKey: `waitlist-mail:${entry.email}:${Math.floor(Date.now() / 3_600_000)}`,
    });
    await drainDueWithin(3_000, 5, ["WAITLIST_EMAIL"]);
  } catch (err) {
    // The join is already stored; a failed confirmation must not fail intake.
    console.warn("waitlist confirm failed", err);
  }
}
