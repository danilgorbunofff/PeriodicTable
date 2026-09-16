/* Phase 7 tests (R07-1, R07-2, R07-5, R07-6, R07-7) — no DB, no network.
 *
 * The finding this file exists for: provider *mode* is derived from credential
 * presence alone, and every money path treated "mode is dev" as permission to
 * mint a stake. On a production box missing STRIPE_WEBHOOK_SECRET that meant
 * anyone holding a paymentId (they are in /pay/<id> URLs, so not a secret) could
 * POST /api/dev/pay and own a tile for free (R07-1); on a preview deployment
 * sharing the production database it meant real rows settled for free (R07-2).
 *
 * The gates are therefore asserted as a truth table over environments, plus the
 * static wiring of the three call sites, since this repo's route tests are all
 * DB-backed and a unit test cannot reach a route's first statement otherwise.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";

const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");

type Env = Record<string, string | undefined>;
const env = process.env as unknown as Env;
const saved: Env = {};
function set(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = env[k];
  if (v === undefined) delete env[k];
  else env[k] = v;
}

// Every variable the gate reads. Anything left ambient would make a case's
// outcome depend on the machine the suite runs on.
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

/** An environment, with the unstubbed variables explicitly unset. */
function shape(o: Env): Env {
  const base: Env = {};
  for (const k of KEYS) base[k] = undefined;
  return { ...base, ...o };
}

describe("the simulator gate is an environment, not the provider mode (R07-1, R07-2)", () => {
  const cases: {
    name: string;
    env: Env;
    /** What getProviderMode() answers — the value every gate used to read. */
    mode: "dev" | "stripe";
    /** Dev-only endpoints may be reachable at all. */
    simulator: boolean;
    /** The storefront may take money (or provide the stand-in). */
    live: boolean;
  }[] = [
    {
      name: "development with no Stripe variables — the local workflow this exists for",
      env: shape({ NODE_ENV: "development" }),
      mode: "dev",
      simulator: true,
      live: true,
    },
    {
      name: "the test suite",
      env: shape({ NODE_ENV: "test", VITEST: "true" }),
      mode: "dev",
      simulator: true,
      live: true,
    },
    {
      name: "production with half a pair — the R07-1 shape that granted free stakes",
      env: shape({ NODE_ENV: "production", VERCEL_ENV: "production", PAYMENTS_LIVE: "true", STRIPE_SECRET_KEY: "sk_live_x" }),
      mode: "dev",
      simulator: false,
      live: false,
    },
    {
      name: "production with nothing configured",
      env: shape({ NODE_ENV: "production", VERCEL_ENV: "production", PAYMENTS_LIVE: "true" }),
      mode: "dev",
      simulator: false,
      live: false,
    },
    {
      name: "preview sharing the production database — the R07-2 shape",
      env: shape({ NODE_ENV: "production", VERCEL_ENV: "preview", STRIPE_SECRET_KEY: "sk_live_x" }),
      mode: "dev",
      simulator: false,
      live: false,
    },
    {
      name: "development with half a pair — an incident everywhere, not a licence",
      env: shape({ NODE_ENV: "development", STRIPE_WEBHOOK_SECRET: "whsec_x" }),
      mode: "dev",
      simulator: false,
      live: false,
    },
    {
      name: "development with the kill switch pulled",
      env: shape({ NODE_ENV: "development", PAYMENTS_LIVE: "false" }),
      mode: "dev",
      simulator: false,
      live: false,
    },
    {
      name: "development with both keys — the real provider, so no stand-in",
      env: shape({ NODE_ENV: "development", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }),
      mode: "stripe",
      simulator: false,
      live: true,
    },
    {
      name: "production, both keys, flag on — the only live-production shape",
      env: shape({
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        PAYMENTS_LIVE: "true",
        STRIPE_SECRET_KEY: "sk_live_x",
        STRIPE_WEBHOOK_SECRET: "whsec_x",
      }),
      mode: "stripe",
      simulator: false,
      live: true,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      for (const [k, v] of Object.entries(c.env)) set(k, v);
      const { devSimulatorEnabled, paymentsLiveServer } = await import("./flags");
      const { getProviderMode } = await import("./stripe");
      expect(getProviderMode()).toBe(c.mode);
      expect(devSimulatorEnabled()).toBe(c.simulator);
      expect(paymentsLiveServer()).toBe(c.live);
      // The invariant, stated once for the whole table: nothing that mints value
      // may be reachable while the deployment is a production one, whatever the
      // provider mode says.
      if (c.live && c.mode === "dev") expect(c.env.VERCEL_ENV).not.toBe("production");
    });
  }

  it("the credential check duplicated in lib/flags.ts agrees with the provider mode", async () => {
    // lib/flags.ts cannot import lib/stripe.ts (client bundle: stripe.ts pulls in
    // node:crypto), so the "both keys present" test exists twice. Two copies that
    // disagreed would let the gate answer "no provider, run the simulator" while
    // mode answered "stripe" — this fails instead.
    const flags = read("lib", "flags.ts");
    expect(flags).toMatch(/process\.env\.STRIPE_SECRET_KEY/);
    expect(flags).toMatch(/process\.env\.STRIPE_WEBHOOK_SECRET/);
    const { stripeEnabled } = await import("./stripe");
    const { devSimulatorEnabled } = await import("./flags");
    for (const [key, secret] of [
      [undefined, undefined],
      ["sk_x", undefined],
      [undefined, "whsec_x"],
      ["sk_x", "whsec_x"],
    ] as [string | undefined, string | undefined][]) {
      set("NODE_ENV", "test");
      set("VITEST", "true");
      set("STRIPE_SECRET_KEY", key);
      set("STRIPE_WEBHOOK_SECRET", secret);
      const both = key !== undefined && secret !== undefined;
      const partial = (key === undefined) !== (secret === undefined);
      expect(stripeEnabled()).toBe(both);
      // The simulator survives only the "no credentials at all" shape: every
      // other shape is either the real provider or a misconfiguration.
      expect(devSimulatorEnabled()).toBe(!both && !partial);
    }
  });
});

describe("the gates, statically (R07-1, R07-2, R07-6)", () => {
  const devPay = read("app", "api", "dev", "pay", "route.ts");
  const payPage = read("app", "pay", "[paymentId]", "page.tsx");
  const simulator = read("app", "pay", "[paymentId]", "PaySimulator.tsx");
  const checkout = read("app", "api", "checkout", "route.ts");

  it("/api/dev/pay refuses before it parses a body or touches the database", () => {
    expect(devPay).toMatch(/if \(!devSimulatorEnabled\(\)\)/);
    // Order matters here and only here: a gate that runs after the JSON parse
    // still spends work on every refused request, and one that runs after the
    // row lookup has already told the caller whether a paymentId exists.
    expect(devPay.indexOf("devSimulatorEnabled()")).toBeLessThan(devPay.indexOf("await req.json()"));
    expect(devPay.indexOf("devSimulatorEnabled()")).toBeLessThan(devPay.indexOf("prisma.payment.findUnique"));
    // The comment the probe disproved, and the gate it was attached to.
    expect(devPay).not.toMatch(/can never grant stakes/);
    expect(devPay).not.toMatch(/getProviderMode/);
  });

  it("/api/dev/pay is not on a production deployment at all (R14-1)", () => {
    // Gate 0, ahead of the flag: devSimulatorEnabled() already requires a
    // development|test environment, and the review asked for the environment
    // check to be its own gate anyway — a flag is a variable an operator can set
    // back, "this is production" is not. 404, because on production the route
    // does not exist, and a 403 would advertise one variable's distance from it.
    expect(devPay).toMatch(/if \(getAppEnv\(\) === "production"\) \{/);
    expect(devPay).toMatch(/status: 404/);
    // The gate on the environment, not the flag — prose mentions both names, so
    // anchor on the two conditions as they are actually written.
    expect(devPay.indexOf('if (getAppEnv() === "production") {')).toBeLessThan(
      devPay.indexOf("if (!devSimulatorEnabled()) {")
    );
    expect(devPay.indexOf('if (getAppEnv() === "production") {')).toBeLessThan(devPay.indexOf("await req.json()"));
  });

  it("checkout gates the sale on the whole production config, not just the Stripe pair (R14-1)", () => {
    // A payment needs a receipt, a drain, and someone who can retry it; the
    // Stripe pair is only the part that is visible from the outside.
    expect(checkout).toMatch(/const money = checkMoneyPath\(\)/);
    expect(checkout).toMatch(/if \(!money\.ok\) \{[\s\S]{0,900}status: 503/);
    // Before the payment row is read, so a refused sale is refused without a
    // query, and before the quote transaction, so no reservation is made for
    // money that cannot be settled.
    expect(checkout.indexOf("checkMoneyPath()")).toBeLessThan(
      checkout.indexOf("prisma.payment.findUnique({ where: { idempotencyKey } })")
    );
    expect(checkout.indexOf("checkMoneyPath()")).toBeLessThan(checkout.indexOf("withTxnRetry(() =>"));
    // Ahead of the paused guard, which is what makes 503 reachable: a shop with
    // PAYMENTS_LIVE=true and a complete Stripe pair is `paymentsLiveServer()`, so
    // without this ordering an unserviceable shop answered the paused 403 and
    // promised a waitlist it does not want.
    expect(checkout.indexOf("checkMoneyPath()")).toBeLessThan(checkout.indexOf("if (!paymentsLiveServer()) {"));
  });

  it("the simulator page 404s on the same two conditions, then on the row's provider", () => {
    expect(payPage).toMatch(/if \(!devSimulatorEnabled\(\)\) notFound\(\)/);
    expect(payPage.indexOf("devSimulatorEnabled()")).toBeLessThan(payPage.indexOf("prisma.payment.findUnique"));
    // R07-6: the page can only drive the dev simulator, so a legacy WHOP row
    // must not render a button whose every press is a 403.
    expect(payPage).toMatch(/payment\?\.provider !== PaymentProvider\.DEV\) notFound\(\)/);
    expect(payPage).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("the checkout hands out a /pay/ URL only where the simulator may exist", () => {
    expect(checkout).toMatch(/if \(devSimulatorEnabled\(\)\) \{/);
    // The old gate — and the reason a key-less preview minted real rows.
    expect(checkout).not.toMatch(/getProviderMode\(\) === "dev"/);
  });

  it("the simulator copy does not claim a configuration it cannot see (R07-7)", () => {
    expect(simulator).not.toMatch(/No Stripe keys are configured here/);
    expect(simulator).not.toMatch(/reason\??:/);
    expect(simulator).toMatch(/stand-in for the real checkout/);
  });
});

describe("the partial-configuration warning is reachable where it matters (R07-5)", () => {
  it("sits above the paused guard, so a paused production shop still says why", async () => {
    const src = read("app", "api", "checkout", "route.ts");
    expect(src.indexOf("stripePartiallyConfigured()")).toBeLessThan(src.indexOf("!paymentsLiveServer()"));

    // Behavioural: in production with one key set, the pre-fix order returned
    // the 403 before reaching the warning, so the operator's log — the only
    // channel that names the cause — stayed empty.
    for (const [k, v] of Object.entries(
      shape({ NODE_ENV: "production", VERCEL_ENV: "production", STRIPE_SECRET_KEY: "sk_live_x" })
    )) {
      set(k, v);
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("../app/api/checkout/route");
    const call = () => POST(new NextRequest("http://localhost/api/checkout", { method: "POST", body: "{}" }) as never);

    const paused = await call();
    expect(paused.status).toBe(403);
    const warnings = () => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("partial Stripe configuration"));
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("payments are paused");

    // Once per process, not once per request: the environment cannot change
    // while this instance lives, so a second line would only repeat the first.
    const again = await call();
    expect(again.status).toBe(403);
    expect(warnings()).toHaveLength(1);
  });
});
