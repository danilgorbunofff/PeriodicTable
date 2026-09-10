/**
 * Startup ownership helpers (Phase 1 remediation).
 *
 * Rule: the server derives canonical identity from the validated URL/handle
 * and NEVER trusts a caller-provided domain. A checkout for a NEW startup
 * creates its initial public profile; a checkout for an EXISTING startup only
 * adds stake. In v1 the profile is FINAL once created — it comes from the
 * checkout form and is never mutated afterwards. (Listing edits would arrive
 * via the dormant lib/manage.ts magic-link backend; not shipped.)
 */
import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { audit } from "./audit";

export type CheckoutProfile = {
  domain: string;
  title: string;
  pitch: string;
  url: string;
  linkType: "product" | "social";
  email: string | null;
};

/** Find-or-create WITHOUT mutating an existing profile. Returns { startup, created }.
 * Accepts an outer transaction client so callers (checkout) stay atomic. */
export async function findOrCreateCheckoutStartup(
  p: CheckoutProfile,
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<{
  startup: { id: string; domain: string; title: string };
  created: boolean;
}> {
  const existing = await db.startup.findUnique({ where: { domain: p.domain } });
  if (existing) return { startup: existing, created: false };
  const startup = await db.startup.create({
    data: {
      domain: p.domain,
      title: p.title.slice(0, 32),
      pitch: p.pitch.slice(0, 140),
      url: p.url,
      linkType: p.linkType,
      logoUrl: `https://www.google.com/s2/favicons?domain=${p.domain}&sz=64`,
      ...(p.email ? { email: p.email } : {}),
    },
  });
  await audit({ action: "STARTUP_CREATED", startupId: startup.id, detail: p.domain }, db);
  return { startup, created: true };
}

/** sha256 fingerprint of the canonical checkout request (Phase 2 binds idempotent retries to it).
 * Note: path is EXCLUDED — it is server-derived quote state, not client intent.
 * A retry after a price move must still match the original payment. */
export function fingerprintCheckout(req: {
  elementSym: string;
  domain: string;
  amountUsd: number;
  email: string | null;
}): string {
  const canonical = [req.elementSym, req.domain, req.amountUsd, req.email ?? ""].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}
