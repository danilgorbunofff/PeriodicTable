/* Phase 0 containment tests (no DB): fail-closed payments + prod env validation. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

type Env = Record<string, string | undefined>;
const env = process.env as unknown as Env;

const KEYS = [
  "NODE_ENV",
  "VERCEL_ENV",
  "NEXT_PUBLIC_VERCEL_ENV",
  "NEXT_PHASE",
  "VITEST",
  "PAYMENTS_LIVE",
  "NEXT_PUBLIC_PAYMENTS_LIVE",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "DATABASE_URL",
  "NEXT_PUBLIC_APP_URL",
  "TURNSTILE_SECRET",
  "CLICK_SALT",
  "CRON_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
];
const saved: Env = {};
function set(k: string, v: string | undefined) {
  if (v === undefined) delete env[k];
  else env[k] = v;
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = env[k];
});

afterEach(() => {
  for (const k of KEYS) set(k, saved[k]);
});

function prodEnv() {
  set("VITEST", undefined);
  set("NODE_ENV", "production");
  set("VERCEL_ENV", "production");
  set("NEXT_PHASE", undefined);
}

function fakeEnv(o: Env): NodeJS.ProcessEnv {
  return o as unknown as NodeJS.ProcessEnv;
}

describe("getAppEnv", () => {
  it("maps test/dev/preview/production", async () => {
    const { getAppEnv } = await import("./env");
    set("VERCEL_ENV", undefined);
    set("NODE_ENV", "test");
    expect(getAppEnv()).toBe("test");
    set("VITEST", undefined);
    set("NODE_ENV", "development");
    expect(getAppEnv()).toBe("development");
    set("VERCEL_ENV", "preview");
    set("NODE_ENV", "production");
    expect(getAppEnv()).toBe("preview");
    set("VERCEL_ENV", "production");
    expect(getAppEnv()).toBe("production");
  });
});

describe("payments fail closed in production", () => {
  it("server requires explicit PAYMENTS_LIVE=true AND provider keys", async () => {
    prodEnv();
    const { paymentsLiveServer } = await import("./flags");
    set("PAYMENTS_LIVE", undefined);
    set("STRIPE_SECRET_KEY", undefined);
    set("STRIPE_WEBHOOK_SECRET", undefined);
    expect(paymentsLiveServer()).toBe(false); // absent flag must not default live
    set("STRIPE_SECRET_KEY", "k");
    set("STRIPE_WEBHOOK_SECRET", "s");
    expect(paymentsLiveServer()).toBe(false); // keys alone are not enough
    set("PAYMENTS_LIVE", "true");
    expect(paymentsLiveServer()).toBe(true);
    set("PAYMENTS_LIVE", "false");
    expect(paymentsLiveServer()).toBe(false);
  });

  it("server stays live by default outside production (dev simulator)", async () => {
    set("VERCEL_ENV", undefined);
    set("VITEST", undefined);
    set("NODE_ENV", "development");
    set("PAYMENTS_LIVE", undefined);
    set("STRIPE_SECRET_KEY", undefined);
    set("STRIPE_WEBHOOK_SECRET", undefined);
    const { paymentsLiveServer, devSimulatorEnabled } = await import("./flags");
    expect(paymentsLiveServer()).toBe(true);
    expect(devSimulatorEnabled()).toBe(true);
    set("PAYMENTS_LIVE", "false");
    expect(paymentsLiveServer()).toBe(false);
    expect(devSimulatorEnabled()).toBe(false); // the kill switch reaches the stand-in provider too
    set("PAYMENTS_LIVE", undefined);
    // R07-1/R07-2: half a configuration is an incident, not a licence to invent
    // payments — the storefront takes the waitlist instead.
    set("STRIPE_SECRET_KEY", "k");
    expect(paymentsLiveServer()).toBe(false);
    expect(devSimulatorEnabled()).toBe(false);
  });

  it("client requires explicit NEXT_PUBLIC_PAYMENTS_LIVE=true in production", async () => {
    prodEnv();
    set("NEXT_PUBLIC_VERCEL_ENV", "production");
    const { paymentsLiveClient } = await import("./flags");
    set("NEXT_PUBLIC_PAYMENTS_LIVE", undefined);
    expect(paymentsLiveClient()).toBe(false);
    set("NEXT_PUBLIC_PAYMENTS_LIVE", "true");
    expect(paymentsLiveClient()).toBe(true);
  });
});

describe("requireProdEnv", () => {
  it("no-ops outside production", async () => {
    set("VERCEL_ENV", undefined);
    set("VITEST", undefined);
    set("NODE_ENV", "development");
    const { requireProdEnv } = await import("./env");
    expect(() => requireProdEnv(fakeEnv({}))).not.toThrow();
  });

  it("throws in production with missing/invalid values", async () => {
    prodEnv();
    const { requireProdEnv } = await import("./env");
    expect(() => requireProdEnv(fakeEnv({}))).toThrow(/DATABASE_URL/);
    expect(() =>
      requireProdEnv(
        fakeEnv({
          DATABASE_URL: "x",
          STRIPE_SECRET_KEY: "x",
          STRIPE_WEBHOOK_SECRET: "x",
          NEXT_PUBLIC_APP_URL: "http://localhost:3000",
          TURNSTILE_SECRET: "x",
          CLICK_SALT: "change-me-in-prod",
          CRON_SECRET: "x",
          RESEND_API_KEY: "x",
          EMAIL_FROM: "x",
        })
      )
    ).toThrow(/NEXT_PUBLIC_APP_URL|CLICK_SALT/);
  });

  it("passes in production with valid values, skips during build phase", async () => {
    prodEnv();
    const { requireProdEnv } = await import("./env");
    const good = fakeEnv({
      DATABASE_URL: "postgresql://x",
      STRIPE_SECRET_KEY: "x",
      STRIPE_WEBHOOK_SECRET: "x",
      NEXT_PUBLIC_APP_URL: "https://periodictable.lol",
      TURNSTILE_SECRET: "x",
      CLICK_SALT: "a-private-random-value",
      CRON_SECRET: "x",
      RESEND_API_KEY: "x",
      EMAIL_FROM: "hi@periodictable.lol",
      ADMIN_TOKEN: "opaque-admin",
    });
    expect(() => requireProdEnv(good)).not.toThrow();
    set("NEXT_PHASE", "phase-production-build");
    expect(() => requireProdEnv(fakeEnv({}))).not.toThrow();
  });
});

describe("getProdConfigReport", () => {
  const FULL: Env = {
    DATABASE_URL: "postgresql://x",
    STRIPE_SECRET_KEY: "x",
    STRIPE_WEBHOOK_SECRET: "x",
    NEXT_PUBLIC_APP_URL: "https://periodictable.lol",
    TURNSTILE_SECRET: "x",
    CLICK_SALT: "a-private-random-value",
    CRON_SECRET: "x",
    RESEND_API_KEY: "x",
    EMAIL_FROM: "hi@periodictable.lol",
    ADMIN_TOKEN: "opaque-admin",
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "x",
  };

  it("reports exactly REQUIRED_PROD_ENV when nothing is set (drift guard)", async () => {
    // The whole point of the single-source change: the throwing path and the
    // reporting path must both derive from REQUIRED_PROD_ENV. If a second
    // hand-written check list ever reappears, these two assertions disagree.
    const { REQUIRED_PROD_ENV, getProdConfigReport, getMissingProdEnv } = await import("./env");
    const empty = fakeEnv({});
    const required = getProdConfigReport(empty)
      .findings.filter((f) => f.severity === "required")
      .map((f) => f.key);
    expect(required).toEqual([...REQUIRED_PROD_ENV]);
    expect(getMissingProdEnv(empty)).toHaveLength(REQUIRED_PROD_ENV.length);
    // A missing required variable is the whole reason this report exists, and
    // it is what the pinger needs to fail on.
    expect(getProdConfigReport(empty).ok).toBe(false);
  });

  it("is clean for a fully configured production env", async () => {
    const { getProdConfigReport } = await import("./env");
    expect(getProdConfigReport(fakeEnv(FULL))).toEqual({ ok: true, findings: [] });
  });

  it("keeps degradation advisory while a missing ADMIN_TOKEN is now required (R07-3)", async () => {
    const { getProdConfigReport, requireProdEnv } = await import("./env");
    const degraded: Env = { ...FULL };
    delete degraded.UPSTASH_REDIS_REST_URL;
    delete degraded.UPSTASH_REDIS_REST_TOKEN;

    expect(getProdConfigReport(fakeEnv(degraded)).findings.map((f) => [f.key, f.severity])).toEqual([
      ["UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN", "degraded"],
    ]);

    // Non-fatal by design: rate limits degrading to per-instance memory must not
    // take down public browsing.
    prodEnv();
    expect(() => requireProdEnv(fakeEnv(degraded))).not.toThrow();

    // ...and it must not fail `ok` either. /api/jobs/config answers ok:false
    // as a 503 that the external pinger alerts on, so an advisory reaching `ok`
    // would page every 10 minutes for a condition that is non-fatal by
    // definition — and a monitor that cries wolf on a schedule is muted long
    // before a required variable actually goes missing. The findings above are
    // still returned in full, so the degradation stays visible.
    expect(getProdConfigReport(fakeEnv(degraded)).ok).toBe(true);

    // R07-3: ADMIN_TOKEN moved from that advisory list to the required one. It
    // was the single variable whose absence locks the operator out of the report
    // that lists every other absence — adminAuth() fails closed on it — so its
    // absence now fails `ok`, the pinger and requireProdEnv() like the rest.
    const noAdmin: Env = { ...FULL };
    delete noAdmin.ADMIN_TOKEN;
    expect(getProdConfigReport(fakeEnv(noAdmin)).findings).toContainEqual({
      key: "ADMIN_TOKEN",
      severity: "required",
      detail: expect.stringContaining("ADMIN_TOKEN"),
    });
    expect(getProdConfigReport(fakeEnv(noAdmin)).ok).toBe(false);
    expect(() => requireProdEnv(fakeEnv(noAdmin))).toThrow(/ADMIN_TOKEN/);
  });
});

/* R07-4: presence and validity are different questions. The probe (in
 * lib/stripe.ts) answers the second one; this turns that answer into a finding,
 * and the severity is the whole decision — a key Stripe refuses fails every
 * checkout, so it must fail `ok` and the pinger with it, while a probe that
 * could not reach Stripe must raise nothing at all. */
describe("credentialFinding / configFindingsOk", () => {
  it("absent and valid keys add nothing (absence is REQUIRED_PROD_ENV's report)", async () => {
    const { credentialFinding } = await import("./env");
    expect(credentialFinding("STRIPE_SECRET_KEY", { status: "absent" })).toBeNull();
    expect(credentialFinding("STRIPE_SECRET_KEY", { status: "valid" })).toBeNull();
  });

  it("a refused key is 'required' — presence passes every other check while sales fail", async () => {
    const { credentialFinding, configFindingsOk } = await import("./env");
    const finding = credentialFinding("STRIPE_SECRET_KEY", { status: "invalid", detail: "HTTP 401" });
    expect(finding).toMatchObject({ key: "STRIPE_SECRET_KEY", severity: "required" });
    expect(finding?.detail).toContain("HTTP 401");
    expect(configFindingsOk(finding ? [finding] : [])).toBe(false);
  });

  it("an unreachable provider is 'degraded' — a network blip is not a bad key", async () => {
    const { credentialFinding, configFindingsOk } = await import("./env");
    const finding = credentialFinding("STRIPE_SECRET_KEY", { status: "unknown", detail: "network" });
    expect(finding).toMatchObject({ key: "STRIPE_SECRET_KEY", severity: "degraded" });
    expect(configFindingsOk(finding ? [finding] : [])).toBe(true);
  });

  it("ok means 'requireProdEnv() would refuse', so advisories never fail it", async () => {
    const { configFindingsOk } = await import("./env");
    expect(configFindingsOk([])).toBe(true);
    expect(configFindingsOk([{ key: "UPSTASH", severity: "degraded", detail: "x" }])).toBe(true);
    expect(configFindingsOk([{ key: "ADMIN_TOKEN", severity: "operator", detail: "x" }])).toBe(true);
    expect(
      configFindingsOk([
        { key: "UPSTASH", severity: "degraded", detail: "x" },
        { key: "STRIPE_SECRET_KEY", severity: "required", detail: "x" },
      ])
    ).toBe(false);
  });
});

/* R07-3: production configuration was reported to nobody — an incomplete
 * deployment booted quietly and looked identical to a healthy one until a buyer
 * paid. The startup line is the report; throwing stays an explicit operator
 * decision (requireProdEnv). */
describe("reportProdEnvAtStartup", () => {
  it("stays silent outside production and during a build", async () => {
    const { reportProdEnvAtStartup } = await import("./env");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    set("VITEST", undefined);
    set("NEXT_PHASE", undefined);
    set("VERCEL_ENV", undefined);
    set("NODE_ENV", "development");
    expect(reportProdEnvAtStartup()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();

    // `next build` prerenders without the production secrets, by design.
    set("NODE_ENV", "production");
    set("VERCEL_ENV", "production");
    set("NEXT_PHASE", "phase-production-build");
    expect(reportProdEnvAtStartup()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();

    // In production it is exactly one line, and it never throws: a throw at
    // import time takes down /api/jobs/config as well, which is the surface
    // that explains what is missing.
    set("NEXT_PHASE", undefined);
    expect(() => reportProdEnvAtStartup()).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("names the missing variables and never their values", async () => {
    prodEnv();
    const { reportProdEnvAtStartup } = await import("./env");
    set("DATABASE_URL", "postgresql://sentinel:sentinel@host/db");
    set("STRIPE_SECRET_KEY", "sk_live_sentinel");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = reportProdEnvAtStartup();
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("STRIPE_WEBHOOK_SECRET"); // half a pair is named
    expect(line).toContain(`${missing.length} required`);
    expect(line).not.toContain("sentinel");
    expect(missing.join(" ")).not.toContain("sentinel");
    spy.mockRestore();
  });

  it("is called from the module every data path imports", () => {
    // Static, because the call site is a module-scope side effect in lib/prisma.ts
    // and no unit test can observe "the server said nothing at boot".
    const src = readFileSync(join(__dirname, "..", "lib", "prisma.ts"), "utf8");
    expect(src).toMatch(/reportProdEnvAtStartup\(\)/);
    expect(src).toMatch(/from "@\/lib\/env"/);
  });
});
