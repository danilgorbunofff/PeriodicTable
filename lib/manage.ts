/**
 * Email magic-link management (Phase 1 remediation) — BACKEND ONLY: NOT
 * SHIPPED IN v1, and unreachable from the UI.
 *
 * v1 model: a listing is set at checkout and is final. The manage pages were
 * designed but never built, and production never emails the link, so this
 * module is dormant. Keep it dormant until the pages + delivery exist — do
 * not surface it to users (see README "Ownership" and doc/ARCHITECTURE.md §3).
 *
 * Flow (when it is eventually shipped): POST /api/manage/request (domain+email)
 * → opaque token emailed → POST /api/manage/verify {token} → httpOnly session
 * cookie → PATCH /api/startups/[domain] (session required).
 *
 * Security properties:
 * - Only sha256 hashes are stored; raw tokens exist in email/cookie only.
 * - Tokens are single-use (consumedAt), short-lived (15 min), purpose-bound.
 * - Sessions are short-lived (60 min), revocable by expiry, cookie httpOnly.
 * - Request endpoint never reveals whether a domain exists (no oracle).
 * - A link is only minted for the address the listing itself carries
 *   (`Startup.email`), so asking is not enough to manage someone else's listing
 *   (R10-2).
 * - Raw tokens are returned by requestManageToken ONLY under the development
 *   app env. `!isProduction()` was the previous test, and it was wrong: a
 *   preview deployment reports preview, not production, and per
 *   doc/PROD-READINESS-CHECKLIST.md l.16 the preview class may point at the
 *   production database — so the "dev convenience" handed out working tokens
 *   for real listings.
 * - R14-7: that development check is now one of two gates. `getAppEnv()` is a
 *   classification, and a classification can be wrong (an env var set on the
 *   wrong project, a future precedence change); DEV_MANAGE_TOKENS=1 is a
 *   deliberate act by the person running the process. Both must hold, and a
 *   deployment the Vercel project never sets that variable on cannot hand a
 *   capability to a caller however the env is classified. The field is named
 *   `__devToken` so a response dump cannot read like a shipped feature.
 */
import { createHash, randomBytes } from "crypto";
import { prisma } from "./prisma";
import { getAppEnv, isProduction } from "./env";
import { audit } from "./audit";

export const MANAGE_TOKEN_TTL_MS = 15 * 60_000;
export const MANAGE_SESSION_TTL_MS = 60 * 60_000;
export const MANAGE_COOKIE = "ptl_manage";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  return email;
}

/**
 * R14-7. Two independent gates, both required: the app env is `development`
 * (which already excludes a preview deployment and any production build) *and*
 * the operator asked for the token. Neither gate alone is a decision anyone
 * should have to get right twice — see the module docblock.
 */
export function devManageTokenEnabled(): boolean {
  return getAppEnv() === "development" && process.env.DEV_MANAGE_TOKENS === "1";
}

export async function requestManageToken(params: {
  domain: string;
  email: string;
}): Promise<{ sent: true; __devToken?: string }> {
  const domain = params.domain.trim().toLowerCase();
  const email = normalizeEmail(params.email);
  if (!email) return { sent: true }; // no oracle: same shape for bad input
  const startup = await prisma.startup.findUnique({ where: { domain } });
  // R10-2: the caller must already control the address the listing carries. The
  // mint used to accept whatever address was supplied and never compare it with
  // `Startup.email`, so on any non-production deployment — including a preview
  // deployment pointed at the production database — a stranger could take over
  // any listing with one unauthenticated request. The comparison is the check
  // the module's own "verified owner" language assumed and never made.
  if (startup && startup.email && normalizeEmail(startup.email) === email) {
    const raw = randomBytes(32).toString("hex");
    await prisma.manageToken.create({
      data: {
        startupId: startup.id,
        email,
        tokenHash: hashToken(raw),
        purpose: "profile-manage",
        expiresAt: new Date(Date.now() + MANAGE_TOKEN_TTL_MS),
      },
    });
    // The actor is the address that controls the listing's own address, not an
    // anonymous "system" request: the audit trail must not read like a stranger
    // was here when the owner asked (R10-2).
    await audit({ action: "MANAGE_LINK_REQUESTED", startupId: startup.id, actorType: "owner", actorRef: email, detail: email });
    // v1: listing edits are not shipped (no UI, no delivery) — see README
    // "Ownership". Production deliberately drops the link instead of
    // half-delivering it; the token simply expires unused. Development still
    // returns the raw token so the token/session logic stays testable — and only
    // development, and only when DEV_MANAGE_TOKENS=1 (R14-7).
    if (devManageTokenEnabled()) return { sent: true, __devToken: raw };
    // TODO(v2): ship the management pages, then enqueue the link via OutboxEvent.
    console.warn(`manage link requested for ${domain}, but listing management is not shipped (v1); link not sent`);
    return { sent: true };
  }
  return { sent: true };
}

export async function consumeManageToken(raw: string): Promise<{
  ok: true;
  sessionToken: string;
  startupId: string;
  domain: string;
} | { ok: false }> {
  const token = await prisma.manageToken.findUnique({ where: { tokenHash: hashToken(raw) } });
  if (!token || token.consumedAt || token.expiresAt.getTime() < Date.now()) {
    return { ok: false };
  }
  if (token.purpose !== "profile-manage") return { ok: false };
  await prisma.manageToken.update({ where: { id: token.id }, data: { consumedAt: new Date() } });
  const sessionRaw = randomBytes(32).toString("hex");
  await prisma.manageSession.create({
    data: {
      startupId: token.startupId,
      tokenHash: hashToken(sessionRaw),
      expiresAt: new Date(Date.now() + MANAGE_SESSION_TTL_MS),
    },
  });
  const startup = await prisma.startup.findUniqueOrThrow({ where: { id: token.startupId } });
  await audit({ action: "MANAGE_LINK_CONSUMED", startupId: startup.id, actorType: "owner" });
  return { ok: true, sessionToken: sessionRaw, startupId: startup.id, domain: startup.domain };
}

export async function getManageSession(raw: string | null | undefined): Promise<{
  startupId: string;
  domain: string;
} | null> {
  if (!raw) return null;
  const session = await prisma.manageSession.findUnique({ where: { tokenHash: hashToken(raw) } });
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  const startup = await prisma.startup.findUnique({ where: { id: session.startupId } });
  if (!startup) return null;
  return { startupId: startup.id, domain: startup.domain };
}

export function manageCookieHeader(sessionToken: string): string {
  const parts = [
    `${MANAGE_COOKIE}=${sessionToken}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(MANAGE_SESSION_TTL_MS / 1000)}`,
  ];
  if (isProduction()) parts.push("Secure");
  return parts.join("; ");
}
