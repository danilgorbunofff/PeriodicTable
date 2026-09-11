/**
 * Central server environment parser (Phase 0 remediation).
 *
 * Distinguishes development / test / preview / production and makes
 * production misconfiguration fail explicitly instead of failing open.
 *
 * Rules:
 * - Development-only fallbacks (localhost URLs, dev salts, simulator paths)
 *   are permitted outside production only.
 * - In production every value listed in REQUIRED_PROD_ENV must be present and
 *   valid; requireProdEnv() throws otherwise. It has no call site yet, so
 *   nothing enforces that today: getProdConfigReport() — served by
 *   /api/jobs/config — is where the gaps are currently visible.
 * - During `next build` (NEXT_PHASE === "phase-production-build") validation
 *   is deferred so static prerendering without prod secrets still works;
 *   requireProdEnv() is the check that must be invoked at runtime.
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

export type RequiredProdEnvKey = (typeof REQUIRED_PROD_ENV)[number];

/**
 * Why each entry above is required. Typed as a complete record, so adding a
 * name to REQUIRED_PROD_ENV without a reason here is a compile error — that is
 * what keeps the list authoritative instead of drifting from a second,
 * hand-maintained check list.
 */
const PROD_ENV_REASONS: Record<RequiredProdEnvKey, string> = {
  DATABASE_URL: "DATABASE_URL is required in production",
  WHOP_API_KEY: "WHOP_API_KEY is required in production",
  WHOP_WEBHOOK_SECRET: "WHOP_WEBHOOK_SECRET is required in production",
  NEXT_PUBLIC_APP_URL: "NEXT_PUBLIC_APP_URL must be an https URL in production (no localhost)",
  TURNSTILE_SECRET: "TURNSTILE_SECRET is required in production (bot checks must not bypass)",
  CLICK_SALT: "CLICK_SALT must be set to a private random value in production",
  CRON_SECRET: "CRON_SECRET is required in production (job endpoints must authenticate)",
  RESEND_API_KEY: "RESEND_API_KEY is required in production (receipts/outbid must deliver)",
  EMAIL_FROM: "EMAIL_FROM is required in production",
};

/** Entries whose presence alone does not make them valid. */
const PROD_ENV_VALIDATORS: Partial<Record<RequiredProdEnvKey, (env: NodeJS.ProcessEnv) => boolean>> = {
  NEXT_PUBLIC_APP_URL: (env) => isHttpsAppUrl(env.NEXT_PUBLIC_APP_URL),
  CLICK_SALT: (env) => !DEV_SALT_VALUES.has(env.CLICK_SALT ?? ""),
};

function prodEnvSatisfied(key: RequiredProdEnvKey, env: NodeJS.ProcessEnv): boolean {
  const validate = PROD_ENV_VALIDATORS[key];
  return validate ? validate(env) : !!env[key];
}

/** Returns human-readable descriptions of missing/invalid prod config. */
export function getMissingProdEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_PROD_ENV.filter((key) => !prodEnvSatisfied(key, env)).map((key) => PROD_ENV_REASONS[key]);
}

export type ProdConfigSeverity = "required" | "operator" | "degraded";
export type ProdConfigFinding = { key: string; severity: ProdConfigSeverity; detail: string };

/**
 * Config whose absence does not stop the site, so nothing fails and the
 * degradation is only visible if something reports it. Each entry names the
 * concrete consequence rather than only the missing variable.
 */
const PROD_ENV_ADVISORIES: {
  key: string;
  severity: Exclude<ProdConfigSeverity, "required">;
  satisfied: (env: NodeJS.ProcessEnv) => boolean;
  detail: string;
}[] = [
  {
    key: "ADMIN_TOKEN",
    severity: "operator",
    satisfied: (env) => !!env.ADMIN_TOKEN,
    detail:
      "ADMIN_TOKEN is unset: adminAuth() fails closed, so moderation triage and outbox retry are unreachable in production",
  },
  {
    key: "UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN",
    severity: "degraded",
    satisfied: (env) => !!env.UPSTASH_REDIS_REST_URL && !!env.UPSTASH_REDIS_REST_TOKEN,
    detail: "Upstash is unconfigured: rate limits fall back to per-instance memory and fail open (lib/rateStore.ts)",
  },
];

/**
 * Non-throwing production config status. `required` findings are exactly what
 * requireProdEnv() refuses to serve without; the advisory severities degrade
 * quietly, so they are reported here rather than thrown.
 *
 * `ok` tracks that same split: it answers "would requireProdEnv() refuse to
 * serve?", never "is anything at all less than perfect?". An advisory must not
 * fail it. /api/jobs/config answers a non-2xx when `ok` is false — that status
 * code is the only channel the external pinger can read — so a finding that is
 * non-fatal by definition would raise an alert on every 10-minute tick,
 * forever, and a monitor that cries wolf on schedule is muted long before a
 * required variable actually goes missing.
 *
 * Nothing is hidden by this: every advisory is still reported in `findings`
 * with its severity. /api/jobs/reconcile draws the identical line, keeping its
 * advisory `unverified` block out of `ok` while `divergent` fails it.
 */
export function getProdConfigReport(
  env: NodeJS.ProcessEnv = process.env
): { ok: boolean; findings: ProdConfigFinding[] } {
  const findings: ProdConfigFinding[] = REQUIRED_PROD_ENV.filter((key) => !prodEnvSatisfied(key, env)).map(
    (key) => ({ key, severity: "required" as const, detail: PROD_ENV_REASONS[key] })
  );
  for (const advisory of PROD_ENV_ADVISORIES) {
    if (!advisory.satisfied(env)) {
      findings.push({ key: advisory.key, severity: advisory.severity, detail: advisory.detail });
    }
  }
  return { ok: !findings.some((f) => f.severity === "required"), findings };
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
