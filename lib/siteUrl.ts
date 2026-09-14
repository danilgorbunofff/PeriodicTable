/**
 * The product's own origin, decided in one place (R01-6, R01-7).
 *
 * Production answers on `www` — the apex 308s to it — while
 * NEXT_PUBLIC_APP_URL may carry either host depending on environment, so both
 * normalise to one canonical origin here instead of leaking whichever string
 * happened to be set into sitemap.xml, robots.txt and <link rel="canonical">.
 */
import { isBuildPhase, isProduction } from "./env";

const CANONICAL_HOST = "www.periodictable.lol";
const APEX_HOST = "periodictable.lol";
const FALLBACK_ORIGIN = `https://${CANONICAL_HOST}`;

/** http(s) origin of NEXT_PUBLIC_APP_URL, or null when it is unset/invalid. */
function originFrom(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  return `${url.protocol}//${host === APEX_HOST ? CANONICAL_HOST : host}${url.port ? `:${url.port}` : ""}`;
}

/** Origin for emitted URLs. An unset or malformed value falls back to the host
 *  production actually serves; use siteOriginStrict() where a guess must not
 *  pass silently. */
export function siteOrigin(env: Record<string, string | undefined> = process.env): string {
  return originFrom(env.NEXT_PUBLIC_APP_URL) ?? FALLBACK_ORIGIN;
}

/** siteOrigin(), except production refuses to guess (R01-7): a missing or
 *  malformed NEXT_PUBLIC_APP_URL throws instead of publishing a host the
 *  deployment may not serve. Deferred during `next build`, so prerendering
 *  without production secrets still works (lib/env.ts:isBuildPhase). */
export function siteOriginStrict(
  env: Record<string, string | undefined> = process.env,
  { requireConfigured = isProduction() && !isBuildPhase() }: { requireConfigured?: boolean } = {}
): string {
  if (requireConfigured && originFrom(env.NEXT_PUBLIC_APP_URL) === null) {
    throw new Error(
      "NEXT_PUBLIC_APP_URL is required in production (R01-7): sitemap.xml must not advertise a guessed host."
    );
  }
  return siteOrigin(env);
}
