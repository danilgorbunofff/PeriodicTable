/* Phase 0 containment tests (no DB): fail-closed payments + prod env validation. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

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
  "WHOP_API_KEY",
  "WHOP_WEBHOOK_SECRET",
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
    set("WHOP_API_KEY", undefined);
    set("WHOP_WEBHOOK_SECRET", undefined);
    expect(paymentsLiveServer()).toBe(false); // absent flag must not default live
    set("WHOP_API_KEY", "k");
    set("WHOP_WEBHOOK_SECRET", "s");
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
    const { paymentsLiveServer } = await import("./flags");
    expect(paymentsLiveServer()).toBe(true);
    set("PAYMENTS_LIVE", "false");
    expect(paymentsLiveServer()).toBe(false);
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
          WHOP_API_KEY: "x",
          WHOP_WEBHOOK_SECRET: "x",
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
      WHOP_API_KEY: "x",
      WHOP_WEBHOOK_SECRET: "x",
      NEXT_PUBLIC_APP_URL: "https://periodictable.lol",
      TURNSTILE_SECRET: "x",
      CLICK_SALT: "a-private-random-value",
      CRON_SECRET: "x",
      RESEND_API_KEY: "x",
      EMAIL_FROM: "hi@periodictable.lol",
    });
    expect(() => requireProdEnv(good)).not.toThrow();
    set("NEXT_PHASE", "phase-production-build");
    expect(() => requireProdEnv(fakeEnv({}))).not.toThrow();
  });
});

describe("getProdConfigReport", () => {
  const FULL: Env = {
    DATABASE_URL: "postgresql://x",
    WHOP_API_KEY: "x",
    WHOP_WEBHOOK_SECRET: "x",
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
  });

  it("is clean for a fully configured production env", async () => {
    const { getProdConfigReport } = await import("./env");
    expect(getProdConfigReport(fakeEnv(FULL))).toEqual({ ok: true, findings: [] });
  });

  it("surfaces the quiet degradations without throwing", async () => {
    const { getProdConfigReport, requireProdEnv } = await import("./env");
    const noOperator: Env = { ...FULL };
    delete noOperator.ADMIN_TOKEN;
    delete noOperator.UPSTASH_REDIS_REST_URL;
    delete noOperator.UPSTASH_REDIS_REST_TOKEN;

    expect(getProdConfigReport(fakeEnv(noOperator)).findings.map((f) => [f.key, f.severity])).toEqual([
      ["ADMIN_TOKEN", "operator"],
      ["UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN", "degraded"],
    ]);

    // Non-fatal by design: an operator lockout, or rate limits degrading to
    // per-instance memory, must not take down public browsing.
    prodEnv();
    expect(() => requireProdEnv(fakeEnv(noOperator))).not.toThrow();
  });
});
