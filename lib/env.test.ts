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
  "OPERATOR_NAME",
  "OPERATOR_ADDRESS",
  "OPERATOR_COUNTRY",
  "OPERATOR_LAW",
  "OPERATOR_DESCRIPTOR",
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
      EMAIL_FROM: "info@periodictable.lol",
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
    EMAIL_FROM: "info@periodictable.lol",
    ADMIN_TOKEN: "opaque-admin",
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "x",
    RESEND_WEBHOOK_SECRET: "whsec_VGVzdFNlY3JldA==",
    // R16-5: a *fully configured* production deployment names its operator. The
    // identity variables are advisory (they never fail `ok`), so this fixture
    // states the whole environment rather than only the variables the site
    // cannot serve without. Four of them, and no more: the documents publish no
    // operator, so the only values left are the ones a receipt has to name.
    OPERATOR_NAME: "Example Media Ltd",
    OPERATOR_COUNTRY: "England and Wales",
    OPERATOR_TAX_ID: "GB000000000",
    OPERATOR_DESCRIPTOR: "PERIODICTABLE.LOL",
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

  /* R10-7: the second advisory. Without the webhook secret the provider's own
   * evidence — a hard bounce, a spam complaint — never reaches the code, so we
   * keep mailing an address that refused us. It is not `required`: the site
   * serves fine, and setting it takes a dashboard visit. It must therefore not
   * fail `ok` (that would page on every tick) but must be visible in findings. */
  it("lists the operator's own gaps, without failing a deployment that serves and takes money (R16-11, R16-12b)", async () => {
    const { getProdConfigReport, requireProdEnv } = await import("./env");
    const anonymous: Env = { ...FULL };
    for (const key of ["OPERATOR_NAME", "OPERATOR_COUNTRY", "OPERATOR_TAX_ID", "OPERATOR_DESCRIPTOR"]) {
      delete anonymous[key as keyof Env];
    }

    // Two findings for four unset variables, because only two of them reach a
    // payer: the name and the country are printed on a receipt *if* they exist
    // and nothing breaks when they do not, so they raise nothing at all.
    const report = getProdConfigReport(fakeEnv(anonymous));
    expect(report.findings.map((f) => [f.key, f.severity])).toEqual([
      ["OPERATOR_DESCRIPTOR", "operator"],
      ["OPERATOR_TAX_ID", "operator"],
    ]);
    // A registration number is the one gap whose absence is legally thin, and
    // the finding has to say so without inventing a number: most sellers in this
    // position do not have one, and "set this" would be wrong advice for them.
    expect(report.findings[1].detail).toContain("Nothing is wrong if none exists");
    // The site is anonymous, not broken: it still serves pages and still takes
    // money, so the report stays `ok` and the pinger stays quiet.
    expect(report.ok).toBe(true);
    prodEnv();
    expect(() => requireProdEnv(fakeEnv(anonymous))).not.toThrow();

    // A descriptor Stripe would rewrite is the one operator gap that is a
    // payment problem, and it still reads as an advisory — the value is the
    // operator's to set, and the finding names what Stripe accepts.
    const bad = getProdConfigReport(fakeEnv({ ...FULL, OPERATOR_DESCRIPTOR: "ptl" }));
    expect(bad.findings.map((f) => f.key)).toEqual(["OPERATOR_DESCRIPTOR"]);
    expect(bad.findings[0].detail).toContain("5–22 characters");
  });

  it("reports a missing RESEND_WEBHOOK_SECRET as an operator finding, not a failure", async () => {
    const { getProdConfigReport, requireProdEnv } = await import("./env");
    const noWebhook: Env = { ...FULL };
    delete noWebhook.RESEND_WEBHOOK_SECRET;

    const report = getProdConfigReport(fakeEnv(noWebhook));
    expect(report.findings.map((f) => [f.key, f.severity])).toEqual([["RESEND_WEBHOOK_SECRET", "operator"]]);
    expect(report.findings[0].detail).toContain("/api/webhooks/resend");
    expect(report.ok).toBe(true);
    prodEnv();
    expect(() => requireProdEnv(fakeEnv(noWebhook))).not.toThrow();
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

    // In production it never throws, and the emit itself lives in lib/prisma.ts
    // (server-only): a throw at import time takes down /api/jobs/config as
    // well, which is the surface that explains what is missing.
    set("NEXT_PHASE", undefined);
    expect(() => reportProdEnvAtStartup()).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("names the missing variables and never their values", async () => {
    prodEnv();
    const { reportProdEnvAtStartup } = await import("./env");
    set("DATABASE_URL", "postgresql://sentinel:sentinel@host/db");
    set("STRIPE_SECRET_KEY", "sk_live_sentinel");
    // The emit is a module-scope side effect in lib/prisma.ts (server-only ?
    // env.ts is reachable from the client bundle), so the line's shape is
    // pinned statically the same way the call site is pinned below.
    const missing = reportProdEnvAtStartup();
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.join(" ")).toContain("STRIPE_WEBHOOK_SECRET"); // half a pair is named
    expect(missing.join(" ")).not.toContain("sentinel");
    const src = readFileSync(join(__dirname, "..", "lib", "prisma.ts"), "utf8");
    expect(src).toContain('logError("env", "production-incomplete"');
    expect(src).toMatch(/missing: missingProdEnv\.length/);
    expect(src).toMatch(/vars: missingProdEnv/);
  });

  it("is called from the module every data path imports", () => {
    // Static, because the call site is a module-scope side effect in lib/prisma.ts
    // and no unit test can observe "the server said nothing at boot".
    const src = readFileSync(join(__dirname, "..", "lib", "prisma.ts"), "utf8");
    expect(src).toMatch(/reportProdEnvAtStartup\(\)/);
    expect(src).toMatch(/from "@\/lib\/env"/);
  });
});
