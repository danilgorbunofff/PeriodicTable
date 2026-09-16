import { NextRequest, NextResponse } from "next/server";
import { describeError, logWarn } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/manage";
import { domainFromUrl } from "@/lib/validate";
import { rateLimitAsync } from "@/lib/rateStore";
import { clientIp } from "@/lib/ip";
import { hashIp } from "@/lib/clicks";
import { audit } from "@/lib/audit";
import { suppressionFor } from "@/lib/email";
import { enqueueOutbox, drainDueWithin } from "@/lib/outbox";
import { apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ POST: joinWaitlist });

/* R14-3: the ceiling on the mail this route can be talked into sending. A person
 * joins a waitlist once; five *distinct first-time* addresses from one source in
 * a day is already a shared network or a script. Keyed on the source address and
 * counted on the same store as the other limits, deliberately fail-closed: an
 * unusable store must not silently lift the cap on outbound mail.
 *
 * Module-private on purpose — a route file may only export handler names and
 * Next's own route options, so the ceiling lives where it is used. */
const WAITLIST_NEW_RECIPIENTS = 5;
const WAITLIST_RECIPIENT_WINDOW_MS = 24 * 3_600_000;
/** Salted, non-reversible reference to an address, used in the outbox dedupe
 *  key: the queue is read by the cron and by operators, and it does not need a
 *  second copy of every address a stranger typed. Same construction as the IP
 *  hashes (lib/clicks.ts), truncated so the key stays readable in a log line. */
const addressRef = (email: string) => hashIp(email).slice(0, 16);

/**
 * Waitlist intake (Phase 1 storage; Phase 2 wires the paused-checkout path
 * to it). Validated + normalized; one row per email (re-submits refresh
 * consent, never duplicate).
 *
 * Phase 14: the limiter fails closed (R14-2), and only a first-time address is
 * mailed at all (R14-3) — see confirmWaitlist().
 */
async function joinWaitlist(req: NextRequest) {
  const ip = clientIp(req.headers);
  if (
    !(await rateLimitAsync(`waitlist:${ip}`, 10, 3_600_000, {
      onStoreError: "closed",
    }))
  ) {
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
  // R10-6: the join is stored either way, but an address that asked us to stop
  // is not mailed. The UI copy promised "we'll only email you if you ask again";
  // the door back is the unsubscribe link in the message they already have,
  // which offers to start mail again.
  const suppressed = await suppressionFor(email);
  // Read before the upsert: whether this address was already on the list is what
  // decides whether the join may generate mail at all (R14-3), and the upsert
  // overwrites that state.
  const known = await prisma.waitlistEntry.findUnique({
    where: { email },
    select: { id: true },
  });
  const entry = await prisma.waitlistEntry.upsert({
    where: { email },
    create: { email, domain, source },
    update: { domain, source, consentAt: new Date(), ...(suppressed ? { unsubscribedAt: new Date() } : {}) },
  });
  await audit({ action: "WAITLIST_JOINED", detail: email, actorRef: hashIp(ip) });
  if (!suppressed && !known) await confirmWaitlist({ email, domain, source, ip });
  return NextResponse.json({ ok: true, id: entry.id });
}

/**
 * Confirmation mail for the paused-checkout path (R05-7), where the UI says
 * "we'll be in touch".
 *
 * R14-3 rewrote who may be mailed. This route handed the caller's string
 * straight to the provider, so `POST /api/waitlist` was an anonymous relay into
 * any inbox, sent from the domain that also carries receipts and outbid notices:
 * the review's probe produced 34 entries and a logged delivery per request. The
 * recipient is now bounded three ways, none of which the caller chooses:
 *
 * - `joinWaitlist` calls this only for a *first-time* address, so a re-submit
 *   refreshes consent and writes no mail. The promise that the confirmation
 *   survives a mail outage is kept by the outbox row, which is written before
 *   the inline drain and retried by the daily cron — not by re-mailing on a
 *   later join;
 * - at most WAITLIST_NEW_RECIPIENTS distinct new addresses per source per day
 *   (the "distinct recipients" metric the finding said the design lacked);
 * - a 24h bucket in the dedupe key, hashed, so two instances racing the same
 *   address enqueue one row and the queue does not accumulate the address list.
 *
 * Bounded like the report notice; the outbox row survives for the cron.
 */
async function confirmWaitlist(entry: { email: string; domain: string | null; source: string; ip: string }) {
  try {
    const under = await rateLimitAsync(
      `waitlist-new:${entry.ip}`,
      WAITLIST_NEW_RECIPIENTS,
      WAITLIST_RECIPIENT_WINDOW_MS,
      { onStoreError: "closed" }
    );
    if (!under) {
      logWarn("waitlist", "recipient-cap", {
        ip: hashIp(entry.ip),
        effect: "join-stored-no-mail",
      });
      return;
    }
    await enqueueOutbox(prisma, {
      type: "WAITLIST_EMAIL",
      payload: { to: entry.email, domain: entry.domain, source: entry.source },
      dedupeKey: `waitlist-mail:${addressRef(entry.email)}:${Math.floor(Date.now() / WAITLIST_RECIPIENT_WINDOW_MS)}`,
    });
    await drainDueWithin(3_000, 5, ["WAITLIST_EMAIL"]);
  } catch (err) {
    // The join is already stored; a failed confirmation must not fail intake.
    logWarn("waitlist", "confirm-failed", { error: describeError(err) });
  }
}
