/* R14-1(b) — the money path, as a truth table over deployments. No DB, no network.
 *
 * The finding: `PAYMENTS_LIVE=true` plus a complete Stripe pair is enough to take
 * a payment, and the rest of the production contract (a receipt that can be
 * mailed, a queue that can drain, an operator who can retry) was only ever
 * *reported* — by GET /api/jobs/config, to an authenticated operator who has no
 * reason to look. The refusal has to key on intent rather than on the report: a
 * pre-launch deployment is missing exactly the same names on purpose, and R14-1
 * asks for its waitlist to keep working.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { checkMoneyPath } from "./moneyPath";
import { paymentsLiveServer } from "./flags";
import { getProdConfigReport, isProduction } from "./env";

const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");

type Env = Record<string, string | undefined>;
const env = process.env as unknown as Env;
const saved: Env = {};
function set(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = env[k];
  if (v === undefined) delete env[k];
  else env[k] = v;
}

// The variables the gate reads to decide *whether* it speaks. Anything left
// ambient would make a case's outcome depend on the machine the suite runs on.
const KEYS = [
  "NODE_ENV",
  "VERCEL_ENV",
  "VITEST",
  "NEXT_PHASE",
  "PAYMENTS_LIVE",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
];
beforeEach(() => {
  for (const k of KEYS) if (!(k in saved)) saved[k] = env[k];
});
afterEach(() => {
  for (const k of Object.keys(saved)) set(k, saved[k]);
  for (const k of Object.keys(saved)) delete saved[k];
  vi.restoreAllMocks();
});

/** A production deployment that wants money, with every required name set. */
const LAUNCHED = shape({
  NODE_ENV: "production",
  VERCEL_ENV: "production",
  PAYMENTS_LIVE: "true",
  // Assembled at runtime: a literal that matches a key pattern trips
  // secret scanners over the repository history.
  STRIPE_SECRET_KEY: "sk_live_" + "0".repeat(24),
  STRIPE_WEBHOOK_SECRET: "whsec_" + "0".repeat(24),
  DATABASE_URL: "postgresql://app:pw@db.periodictable.internal:5432/periodictable",
  ADMIN_TOKEN: "operator-token",
  NEXT_PUBLIC_APP_URL: "https://periodictable.lol",
  TURNSTILE_SECRET: "turnstile-secret",
  CLICK_SALT: "a-private-random-salt",
  CRON_SECRET: "cron-secret",
  RESEND_API_KEY: "re_" + "0".repeat(24),
  EMAIL_FROM: "info@periodictable.lol",
});

/** An environment, with the unstubbed variables explicitly unset. */
function shape(o: Env): Env {
  const base: Env = {};
  for (const k of KEYS) base[k] = undefined;
  return { ...base, ...o };
}

function apply(overrides: Env = {}) {
  for (const [k, v] of Object.entries({ ...LAUNCHED, ...overrides })) set(k, v);
}

describe("checkMoneyPath keys on intent, not on the report (R14-1)", () => {
  it("lets a complete live production deployment sell", () => {
    apply();
    expect(isProduction()).toBe(true);
    expect(paymentsLiveServer()).toBe(true);
    expect(getProdConfigReport().findings.filter((f) => f.severity === "required")).toEqual([]);
    expect(checkMoneyPath()).toEqual({ ok: true });
  });

  it("refuses a live shop that cannot deliver a receipt, and names what is missing", () => {
    apply({ RESEND_API_KEY: undefined });
    const verdict = checkMoneyPath();
    expect(verdict.ok).toBe(false);
    // The detail strings, not the bare names: the same text an operator sees in
    // GET /api/jobs/config, so the 503 log line and the report cannot drift.
    const required = verdict.ok ? [] : verdict.required;
    expect(required).toEqual([
      "RESEND_API_KEY is required in production (receipts/outbid must deliver)",
    ]);
    expect(required.every((line) => line.length > 0)).toBe(true);
  });

  it("refuses a live shop with no way to drain or retry what it charged", () => {
    apply({ CRON_SECRET: undefined, ADMIN_TOKEN: undefined });
    const verdict = checkMoneyPath();
    expect(verdict.ok).toBe(false);
    const required = verdict.ok ? [] : verdict.required;
    expect(required).toHaveLength(2);
    expect(required.join("\n")).toContain("CRON_SECRET");
    expect(required.join("\n")).toContain("ADMIN_TOKEN");
  });

  it("leaves a pre-launch production shop alone — the waitlist is the promise", () => {
    // The shape a fresh production deployment is in *on purpose*: no Stripe yet,
    // so the report lists the pair and the gate must not turn the paused 403 (with
    // `waitlist: true`) into a generic 503.
    apply({ PAYMENTS_LIVE: undefined, STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined });
    expect(paymentsLiveServer()).toBe(false);
    expect(getProdConfigReport().ok).toBe(false);
    expect(checkMoneyPath()).toEqual({ ok: true });
  });

  it("treats the kill switch as intent, so a paused shop is never refused", () => {
    apply({ PAYMENTS_LIVE: "false", RESEND_API_KEY: undefined });
    expect(paymentsLiveServer()).toBe(false);
    expect(checkMoneyPath()).toEqual({ ok: true });
  });

  it("does not speak for a development or preview process", () => {
    // A preview deployment shares the production database (R07-2); what stops it
    // from charging is the paused guard and devSimulatorEnabled(), not this gate.
    apply({ NODE_ENV: "development", VERCEL_ENV: "preview", PAYMENTS_LIVE: undefined });
    expect(isProduction()).toBe(false);
    expect(checkMoneyPath()).toEqual({ ok: true });
  });

  it("keeps the operator's configuration list out of the buyer's response", () => {
    const checkout = read("app/api/checkout/route.ts");
    // The findings go to the log; the response is one generic sentence, because a
    // buyer has no use for the deployment's missing variable names.
    expect(checkout).toMatch(/status: 503/);
    expect(checkout).not.toMatch(/NextResponse\.json\(\s*\{[^}]*money\.required/);
    expect(checkout).not.toMatch(/NextResponse\.json\(\s*\{[^}]*join\("\\n- "\)/);
  });
});
