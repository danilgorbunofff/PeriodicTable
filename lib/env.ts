/**
 * Central server environment parser (Phase 0 remediation).
 *
 * Distinguishes development / test / preview / production and makes
 * production misconfiguration fail explicitly instead of failing open.
 *
 * Rules:
 * - Development-only fallbacks (localhost URLs, dev salts, simulator paths)
 *   are permitted outside production only.
 * - In production every value listed in REQUIRED_PROD_ENV must be present
 *   and valid; call requireProdEnv() at server startup / request entry.
 * - During `next build` (NEXT_PHASE === "phase-production-build") validation
 *   is deferred to runtime so static prerendering without prod secrets still
 *   works; the runtime still throws (see requireProdEnv).
 */

export type AppEnv = "development" | "test" | "preview" | "production";

export function getAppEnv(): AppEnv {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return "test";
  const vercel = process.env.VERCEL_ENV;
  if (vercel === "production" || vercel === "preview" || vercel === "development") {
    return vercel;
  }
  if (process.env.NODE_ENV === "production") return "production";
  return "development";
}

export function isProduction(): boolean {
  return getAppEnv() === "production";
}

export function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

export const REQUIRED_PROD_ENV = [
  "DATABASE_URL",
  "WHOP_API_KEY",
  "WHOP_WEBHOOK_SECRET",
  "NEXT_PUBLIC_APP_URL",
  "TURNSTILE_SECRET",
  "CLICK_SALT",
  "CRON_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
] as const;

const DEV_SALT_VALUES = new Set(["", "ptl-dev-salt", "change-me-in-prod", "change-me"]);

function isHttpsAppUrl(v: string | undefined): boolean {
  if (!v) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Returns human-readable descriptions of missing/invalid prod config. */
export function getMissingProdEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (!env.DATABASE_URL) missing.push("DATABASE_URL is required in production");
  if (!env.WHOP_API_KEY) missing.push("WHOP_API_KEY is required in production");
  if (!env.WHOP_WEBHOOK_SECRET) missing.push("WHOP_WEBHOOK_SECRET is required in production");
  if (!isHttpsAppUrl(env.NEXT_PUBLIC_APP_URL)) {
    missing.push("NEXT_PUBLIC_APP_URL must be an https URL in production (no localhost)");
  }
  if (!env.TURNSTILE_SECRET) missing.push("TURNSTILE_SECRET is required in production (bot checks must not bypass)");
  if (!env.CLICK_SALT || DEV_SALT_VALUES.has(env.CLICK_SALT)) {
    missing.push("CLICK_SALT must be set to a private random value in production");
  }
  if (!env.CRON_SECRET) missing.push("CRON_SECRET is required in production (job endpoints must authenticate)");
  if (!env.RESEND_API_KEY) missing.push("RESEND_API_KEY is required in production (receipts/outbid must deliver)");
  if (!env.EMAIL_FROM) missing.push("EMAIL_FROM is required in production");
  return missing;
}

/**
 * Throws in production when required config is absent/invalid.
 * Safe to call per-request and at server startup. Skipped during
 * `next build` static prerendering (NEXT_PHASE) — runtime calls still throw.
 */
export function requireProdEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProduction()) return;
  if (isBuildPhase()) return;
  const missing = getMissingProdEnv(env);
  if (missing.length > 0) {
    throw new Error(`Missing production configuration:\n- ${missing.join("\n- ")}`);
  }
}
