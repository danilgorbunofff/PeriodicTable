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
 * - Raw tokens are returned by requestManageToken ONLY outside production
 *   (dev convenience); production never delivers them.
 */
import { createHash, randomBytes } from "crypto";
import { prisma } from "./prisma";
import { isProduction } from "./env";
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

export async function requestManageToken(params: {
  domain: string;
  email: string;
}): Promise<{ sent: true; debugToken?: string }> {
  const domain = params.domain.trim().toLowerCase();
  const email = normalizeEmail(params.email);
  if (!email) return { sent: true }; // no oracle: same shape for bad input
  const startup = await prisma.startup.findUnique({ where: { domain } });
  if (startup) {
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
    await audit({ action: "MANAGE_LINK_REQUESTED", startupId: startup.id, detail: email });
    // v1: listing edits are not shipped (no UI, no delivery) — see README
    // "Ownership". Production deliberately drops the link instead of
    // half-delivering it; the token simply expires unused. Dev still returns
    // the raw token so the token/session logic stays testable.
    if (!isProduction()) return { sent: true, debugToken: raw };
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
