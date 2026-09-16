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
 *   valid; requireProdEnv() throws otherwise. It is the *strict* form and still
 *   has no call site: refusing to boot a deployment is an operator decision, so
 *   the startup path reports instead (reportProdEnvAtStartup(), called from
 *   lib/prisma.ts), and getProdConfigReport() — served by /api/jobs/config — is
 *   the authenticated surface that answers with the same list. See R07-3.
 * - During `next build` (NEXT_PHASE === "phase-production-build") validation
 *   is deferred so static prerendering without prod secrets still works;
 *   requireProdEnv() is the check that must be invoked at runtime.
 */

// lib/operator.ts is dependency-free (it reads the environment and prints it),
// so the config report can name the operator gaps alongside the rest without
// pulling anything else into this module's import graph.
import { operatorAdvisories } from "./operator";

export type AppEnv = "development" | "test" | "preview" | "production";

export function getAppEnv(): AppEnv {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return "test";
  const vercel = process.env.VERCEL_ENV;
  if (
    vercel === "production" ||
    vercel === "preview" ||
    vercel === "development"
  ) {
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

/**
 * Is the database this process would talk to on this machine? (Phase 13, R13-2.)
 *
 * The one honest answer to "is this a rehearsal?", because the framework's
 * environment string is not: a preview deployment, a `next start` on a laptop
 * with the production `.env` loaded, and a test run all look like "not
 * production" while only one of them is harmless to leave unauthenticated.
 * Anything that cannot be parsed, and anything whose host is not a loopback
 * literal, counts as remote — the caller is deciding whether to fail *closed*.
 *
 * Deliberately a host test and not a DNS lookup: no network call, no cached
 * answer, and `localhost`/`127.0.0.1`/`[::1]` are exactly the shapes
 * lib/testDb.ts pins and doc/ARCHITECTURE.md's runbook uses (`ptl-local`
 * :55440, `ptl-fix08-pg` :55433, `localhost` on a CI runner).
 */
export function isLocalDatabase(
  url: string | undefined = process.env.DATABASE_URL,
): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1"
    );
  } catch {
    return false;
  }
}

export const REQUIRED_PROD_ENV = [
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "ADMIN_TOKEN",
  "NEXT_PUBLIC_APP_URL",
  "TURNSTILE_SECRET",
  "CLICK_SALT",
  "CRON_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
] as const;

const DEV_SALT_VALUES = new Set([
  "",
  "ptl-dev-salt",
  "change-me-in-prod",
  "change-me",
]);

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
  STRIPE_SECRET_KEY: "STRIPE_SECRET_KEY is required in production",
  STRIPE_WEBHOOK_SECRET: "STRIPE_WEBHOOK_SECRET is required in production",
  // R07-3: promoted from an advisory. The report that lists missing variables is
  // itself behind adminAuth(), so without this the deployment could be locked
  // out of the one endpoint that explains what else is missing — and the
  // operator's only other symptom is a 403 on every moderation action.
  ADMIN_TOKEN:
    "ADMIN_TOKEN is required in production (adminAuth() fails closed: moderation triage and outbox retry must stay reachable)",
  NEXT_PUBLIC_APP_URL:
    "NEXT_PUBLIC_APP_URL must be an https URL in production (no localhost)",
  TURNSTILE_SECRET:
    "TURNSTILE_SECRET is required in production (bot checks must not bypass)",
  CLICK_SALT: "CLICK_SALT must be set to a private random value in production",
  CRON_SECRET:
    "CRON_SECRET is required in production (job endpoints must authenticate)",
  RESEND_API_KEY:
    "RESEND_API_KEY is required in production (receipts/outbid must deliver)",
  EMAIL_FROM: "EMAIL_FROM is required in production",
};

/** Entries whose presence alone does not make them valid. */
const PROD_ENV_VALIDATORS: Partial<
  Record<RequiredProdEnvKey, (env: NodeJS.ProcessEnv) => boolean>
> = {
  NEXT_PUBLIC_APP_URL: (env) => isHttpsAppUrl(env.NEXT_PUBLIC_APP_URL),
  CLICK_SALT: (env) => !DEV_SALT_VALUES.has(env.CLICK_SALT ?? ""),
};

function prodEnvSatisfied(
  key: RequiredProdEnvKey,
  env: NodeJS.ProcessEnv,
): boolean {
  const validate = PROD_ENV_VALIDATORS[key];
  return validate ? validate(env) : !!env[key];
}

/** Returns human-readable descriptions of missing/invalid prod config. */
export function getMissingProdEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return REQUIRED_PROD_ENV.filter((key) => !prodEnvSatisfied(key, env)).map(
    (key) => PROD_ENV_REASONS[key],
  );
}

export type ProdConfigSeverity = "required" | "operator" | "degraded";
export type ProdConfigFinding = {
  key: string;
  severity: ProdConfigSeverity;
  detail: string;
};

/**
 * The single definition of `ok`: "would requireProdEnv() refuse to serve?".
 * Extracted so every surface that adds findings (the credential probe below,
 * R07-4) answers that question the same way instead of re-deriving it.
 */
export function configFindingsOk(findings: ProdConfigFinding[]): boolean {
  return !findings.some((f) => f.severity === "required");
}

/**
 * The result of asking the provider whether a credential works, as opposed to
 * whether the variable is set (lib/stripe.ts probeStripeKey()). `unknown` is
 * deliberately separate from `invalid`: a probe that could not reach Stripe says
 * nothing about the key.
 */
export type CredentialHealth =
  | { status: "absent" }
  | { status: "valid" }
  | { status: "invalid"; detail: string }
  | { status: "unknown"; detail: string };

/**
 * Turns a provider credential probe into a config finding (R07-4).
 *
 * A key the provider *rejects* is a `required` finding, and the only one here
 * that is derived from a live check rather than from the environment's shape:
 * presence passes every other test while every checkout answers 502, so the
 * deployment is unservable in the way that matters most and the pinger must fail
 * on it. `absent` is already reported by REQUIRED_PROD_ENV — never doubled — and
 * an unreachable provider is a `degraded` advisory: a network blip must not
 * raise an alert.
 */
export function credentialFinding(
  key: string,
  health: CredentialHealth,
): ProdConfigFinding | null {
  if (health.status === "absent") return null;
  if (health.status === "valid") return null;
  if (health.status === "invalid") {
    return {
      key,
      severity: "required",
      detail: `${key} is present but the provider rejects it (${health.detail}): every checkout would fail`,
    };
  }
  return {
    key,
    severity: "degraded",
    detail: `could not verify ${key}: ${health.detail}`,
  };
}

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
    key: "UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN",
    severity: "degraded",
    satisfied: (env) =>
      !!env.UPSTASH_REDIS_REST_URL && !!env.UPSTASH_REDIS_REST_TOKEN,
    detail:
      "Upstash is unconfigured: rate limits fall back to per-instance memory and fail open (lib/rateStore.ts)",
  },
  {
    // R10-7: without this secret the Resend webhook refuses every delivery
    // (verifyResendWebhook fails closed), so a hard bounce or a spam complaint
    // reaches Resend's dashboard and nothing else — and we keep mailing an
    // address that refused us. `operator`, not `required`: the site still
    // serves, and it takes a dashboard visit to create the webhook endpoint,
    // but it is not a "nice to have" either.
    key: "RESEND_WEBHOOK_SECRET",
    severity: "operator",
    satisfied: (env) => !!env.RESEND_WEBHOOK_SECRET,
    detail:
      "Resend bounce/complaint webhooks cannot authenticate: set RESEND_WEBHOOK_SECRET (whsec_…) so /api/webhooks/resend can suppress addresses the provider rejects",
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
export function getProdConfigReport(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  findings: ProdConfigFinding[];
} {
  const findings: ProdConfigFinding[] = REQUIRED_PROD_ENV.filter(
    (key) => !prodEnvSatisfied(key, env),
  ).map((key) => ({
    key,
    severity: "required" as const,
    detail: PROD_ENV_REASONS[key],
  }));
  for (const advisory of PROD_ENV_ADVISORIES) {
    if (!advisory.satisfied(env)) {
      findings.push({
        key: advisory.key,
        severity: advisory.severity,
        detail: advisory.detail,
      });
    }
  }
  // R16-5: the operator's own identity belongs in the same report as the rest
  // of the deployment's configuration, because the gaps it names are only
  // visible to a reader of the legal pages — and a missing statement descriptor
  // surfaces as a payer who does not recognise a charge, which is a billing
  // problem long before it is a legal one. Never `required`: an unset operator
  // name serves traffic, takes money and prints a page; it just cannot be
  // enforced against, and a monitor that alerts on it would be muted within a
  // week. Reported here so /api/jobs/config lists it and the checklist has a
  // line to point at.
  for (const gap of operatorAdvisories(env)) {
    findings.push({
      key: gap.key,
      severity: "operator",
      detail: gap.reason,
    });
  }
  return { ok: configFindingsOk(findings), findings };
}

/**
 * Startup validation (R07-3). Returns the missing-required descriptions and logs
 * them once per cold start at `error` level, so an incomplete production
 * environment appears in the deployment logs without anyone asking for it.
 *
 * This is the report-only half on purpose. A throw at import time takes the
 * whole deployment down — including /api/jobs/config, the surface that explains
 * why — so refusing to boot stays an explicit operator decision
 * (requireProdEnv(), below), and until that switch is thrown the gap is loud
 * rather than fatal. Callers must not otherwise act on the result: the app keeps
 * serving, exactly as it did before, and money paths stay closed by
 * paymentsLiveServer() in the meantime.
 */
export function reportProdEnvAtStartup(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isProduction() || isBuildPhase()) return [];
  const missing = getMissingProdEnv(env);
  if (missing.length > 0) {
    console.error(
      `startup: production configuration is incomplete (${missing.length} required) — ` +
        `GET /api/jobs/config reports the same list to an authenticated caller:\n- ${missing.join("\n- ")}`,
    );
  }
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
    throw new Error(
      `Missing production configuration:\n- ${missing.join("\n- ")}`,
    );
  }
}
