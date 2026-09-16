/* Phase 6 ops tests — pure (no DB): trusted IP, URL validation, rate-store
   behavior, job/admin auth branches, visibility truth tables. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { clientIp } from "./ip";
import { normalizeUrl, isPublicHost, domainFromUrl } from "./validate";
import { rateLimitAsync, setSharedRateLimitStore, type RateLimitStore } from "./rateStore";
import { jobAuth, adminAuth, adminGate, jobGate, ADMIN_LIMIT, JOB_LIMIT } from "./jobs";
import { isDiscoverable, isDirectVisible } from "./moderation";

type Env = Record<string, string | undefined>;
const env = process.env as unknown as Env;
const saved: Env = {};
function set(k: string, v: string | undefined) {
  if (saved[k] === undefined && !(k in saved)) saved[k] = env[k];
  if (v === undefined) delete env[k];
  else env[k] = v;
}
beforeEach(() => {
  for (const k of ["NODE_ENV", "VERCEL_ENV", "VITEST", "CRON_SECRET", "ADMIN_TOKEN"]) {
    if (!(k in saved)) saved[k] = env[k];
  }
  setSharedRateLimitStore(null);
});
afterEach(() => {
  for (const k of Object.keys(saved)) set(k, saved[k]);
  for (const k of Object.keys(saved)) delete saved[k];
  setSharedRateLimitStore(null);
  vi.unstubAllGlobals();
});

const headers = (h: Record<string, string>) => new Headers(h);

describe("clientIp trust order", () => {
  it("prefers cf-connecting-ip, then x-real-ip, then xff, then default", () => {
    expect(clientIp(headers({ "cf-connecting-ip": "1.1.1.1", "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" }))).toBe("1.1.1.1");
    expect(clientIp(headers({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" }))).toBe("2.2.2.2");
    expect(clientIp(headers({ "x-forwarded-for": "3.3.3.3, 4.4.4.4" }))).toBe("3.3.3.3");
    expect(clientIp(headers({}))).toBe("0.0.0.0");
  });
});

describe("isPublicHost + normalizeUrl (SSRF-adjacent inputs)", () => {
  it("accepts ordinary public DNS names", () => {
    expect(isPublicHost("acme.dev")).toBe(true);
    expect(normalizeUrl("https://Acme-Startup.COM/launch?x=1")).toBe("https://acme-startup.com/launch?x=1");
  });
  it("rejects credentials in URLs", () => {
    expect(normalizeUrl("https://user:pass@acme.dev/")).toBeNull();
    expect(normalizeUrl("https://user@acme.dev/")).toBeNull();
  });
  it("rejects IPs, localhost, and obfuscations", () => {
    for (const h of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.9", "169.254.169.254", "0.0.0.0", "localhost", "[::1]", "2130706433", "0177.0.0.1"]) {
      expect(isPublicHost(h)).toBe(false);
    }
    expect(normalizeUrl("http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(normalizeUrl("https://127.0.0.1/admin")).toBeNull();
  });
  it("rejects single-label hosts, normalizes case and trailing dots", () => {
    expect(normalizeUrl("https://intranet/")).toBeNull();
    expect(domainFromUrl("https://WWW.ACME.DEV/x")).toBe("acme.dev");
  });
  it("rejects cloud metadata and wildcard-DNS helpers", () => {
    for (const h of [
      "metadata.google.internal",
      "METADATA.GOOGLE.INTERNAL.",
      "instance-data.compute.internal",
      "metadata.azure.internal",
      "foo.nip.io",
      "127.0.0.1.nip.io",
      "169.254.169.254.nip.io",
      "10.0.0.1.xip.io",
      "app.sslip.io",
      "host.internal",
      "host.local",
    ]) {
      expect(isPublicHost(h)).toBe(false);
    }
    expect(normalizeUrl("http://metadata.google.internal/")).toBeNull();
    expect(normalizeUrl("http://169.254.169.254.nip.io/")).toBeNull();
    expect(normalizeUrl("http://127.0.0.1.nip.io/")).toBeNull();
  });
});

describe("rateLimitAsync", () => {
  it("allows under the limit, blocks over it (memory store)", async () => {
    const k = `ops-${Date.now()}`;
    expect(await rateLimitAsync(k, 2, 60_000)).toBe(true);
    expect(await rateLimitAsync(k, 2, 60_000)).toBe(true);
    expect(await rateLimitAsync(k, 2, 60_000)).toBe(false);
  });
  it("honors a custom store", async () => {
    let n = 0;
    const fake: RateLimitStore = { incr: async () => ++n };
    setSharedRateLimitStore(fake);
    expect(await rateLimitAsync("x", 1, 1000)).toBe(true);
    expect(await rateLimitAsync("x", 1, 1000)).toBe(false);
  });
  it("fails open when the store throws", async () => {
    setSharedRateLimitStore({ incr: async () => { throw new Error("redis down"); } });
    expect(await rateLimitAsync("x", 1, 1000)).toBe(true);
  });
});

describe("jobAuth", () => {
  const req = (bearer?: string) =>
    new Request("http://localhost/api/jobs/outbox", bearer ? { headers: { authorization: `Bearer ${bearer}` } } : ({} as RequestInit));
  it("allows with a matching secret outside production", () => {
    set("CRON_SECRET", "s3cr3t");
    expect(jobAuth(req("s3cr3t") as never, null)).toBeNull();
  });
  it("rejects everything in production without a valid secret", () => {
    set("VITEST", undefined);
    set("NODE_ENV", "production");
    set("VERCEL_ENV", "production");
    set("CRON_SECRET", "s3cr3t");
    expect(jobAuth(req("wrong") as never, "s3cr3t")).toBeNull();
    const bad = jobAuth(req("wrong") as never, null);
    expect(bad?.status).toBe(401);
    set("CRON_SECRET", undefined);
    expect(jobAuth(req("s3cr3t") as never, null)?.status).toBe(401);
  });
});

describe("config report route", () => {
  it("gates like the other job endpoints and never echoes values", async () => {
    const { GET } = await import("../app/api/jobs/config/route");
    const call = (h?: Record<string, string>) =>
      GET(new NextRequest("http://localhost/api/jobs/config", { headers: h }) as never);

    set("CRON_SECRET", "s3cr3t");
    // Outside production jobAuth permits the local rehearsal shape.
    const local = await call();
    const body = (await local.json()) as {
      ok: boolean;
      env: string;
      stripeKey: string;
      findings: { key: string; severity: string; detail: string }[];
    };
    expect(body.env).toBe("test");
    // The status code — not the `ok` field — is the only thing the external
    // pinger can read (the free cron-job.org tier fails a job on non-2xx and
    // cannot inspect bodies), so the two must never disagree. Asserted as a
    // coupling rather than a fixed number: this suite runs against whatever
    // environment it is started in, and a hardcoded 200 is precisely the
    // blindness being guarded against.
    expect(local.status).toBe(body.ok ? 200 : 503);
    expect(Array.isArray(body.findings)).toBe(true);
    for (const f of body.findings) {
      expect(typeof f.key).toBe("string");
      expect(["required", "operator", "degraded"]).toContain(f.severity);
      expect(typeof f.detail).toBe("string");
    }
    // Findings describe configuration shape, never the configured values.
    expect(JSON.stringify(body.findings)).not.toContain("s3cr3t");
    // R07-4: the live key check is a production-only probe — a rehearsal must
    // not reach out to Stripe, and must say so rather than pretending it passed.
    expect(body.stripeKey).toBe("not-checked");

    // In production the report is not public.
    set("VITEST", undefined);
    set("NODE_ENV", "production");
    set("VERCEL_ENV", "production");
    set("STRIPE_SECRET_KEY", undefined);
    // Prove the probe is the only network call this route can make: with no key
    // there is nothing to probe, and a regression that probes anyway fails here
    // instead of quietly spending a real API call from a test run.
    vi.stubGlobal("fetch", () => {
      throw new Error("the config route must not call out during tests");
    });
    expect((await call()).status).toBe(401);
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    const allowed = await call({ authorization: "Bearer s3cr3t" });
    // Auth is checked before health, so an authorised call is never 401. It is
    // never a blanket 200 either: the report is non-fatal in that it always
    // *answers* with its findings, which has never meant "answers 200" — the
    // status code reports health so the pinger can see it.
    const prod = (await allowed.json()) as { ok: boolean; stripeKey: string };
    expect(typeof prod.ok).toBe("boolean");
    expect(allowed.status).toBe(prod.ok ? 200 : 503);
    expect(prod.stripeKey).toBe("absent");
  });

  it("answers 200 with nothing required missing, and 503 the moment one is", async () => {
    // Deterministic, unlike the ambient assertions above: this suite's process
    // env is bare, so `ok` is always false there and an implementation that
    // answered 503 unconditionally would satisfy every other test in this
    // block. Nothing would ever prove a healthy deployment reports healthy.
    const { REQUIRED_PROD_ENV } = await import("./env");
    const { GET } = await import("../app/api/jobs/config/route");
    const call = () => GET(new NextRequest("http://localhost/api/jobs/config") as never);

    // Pin the environment rather than inheriting it: all required variables are
    // about to be set, and in a production process that would let the S4 probe
    // issue a real call with the stub key "x".
    set("VERCEL_ENV", undefined);
    set("VITEST", "true");
    set("NODE_ENV", "test");

    for (const k of REQUIRED_PROD_ENV) set(k, "x");
    set("NEXT_PUBLIC_APP_URL", "https://periodictable.lol");
    set("CLICK_SALT", "a-private-random-value");

    const healthy = await call();
    const healthyBody = (await healthy.json()) as {
      ok: boolean;
      stripeKey: string;
      findings: { key: string; severity: string }[];
    };
    expect(healthy.status).toBe(200);
    expect(healthyBody.ok).toBe(true);
    expect(healthyBody.stripeKey).toBe("not-checked");
    // Advisories may or may not be present depending on the host environment;
    // what must be absent is anything that blocks serving.
    expect(healthyBody.findings.filter((f) => f.severity === "required")).toEqual([]);

    // One required variable gone is exactly the failure the pinger must see.
    set("TURNSTILE_SECRET", undefined);
    const gap = await call();
    const gapBody = (await gap.json()) as { ok: boolean; findings: { key: string; severity: string }[] };
    expect(gap.status).toBe(503);
    expect(gapBody.ok).toBe(false);
    expect(gapBody.findings.map((f) => f.key)).toContain("TURNSTILE_SECRET");
  });
});

describe("adminAuth", () => {
  const req = (bearer?: string) =>
    new Request("http://localhost/api/admin/x", bearer ? { headers: { authorization: `Bearer ${bearer}` } } : ({} as RequestInit));
  it("403s when unset or mismatched, passes on match", () => {
    set("ADMIN_TOKEN", undefined);
    expect(adminAuth(req("anything") as never)?.status).toBe(403);
    set("ADMIN_TOKEN", "opaque-admin");
    expect(adminAuth(req("wrong") as never)?.status).toBe(403);
    expect(adminAuth(req() as never)?.status).toBe(403);
    expect(adminAuth(req("opaque-admin") as never)).toBeNull();
  });
});

describe("adminGate / jobGate — the metered gates (R11-4)", () => {
  const withBearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const adminReq = (token?: string, route = "admin/probe") =>
    new NextRequest(`http://localhost/api/${route}`, token ? { headers: withBearer(token) } : undefined);
  const jobReq = (token?: string, route = "jobs/probe") =>
    new NextRequest(`http://localhost/api/${route}`, token ? { headers: withBearer(token) } : undefined);

  it("checks the credential before it spends budget, so probing is free", async () => {
    set("ADMIN_TOKEN", "gate-a");
    // The review's reproduction: fifty consecutive unauthorised calls, all 200
    // for the job route it probed. Refusals must not consume the operator's own
    // budget either, or a stranger could lock the operator out of triage.
    for (let i = 0; i < ADMIN_LIMIT + 1; i++) {
      const denied = await adminGate(adminReq("wrong"), "admin/probe-free");
      expect(denied?.status).toBe(403);
      expect(denied?.headers.get("x-request-id")).toBeTruthy();
    }
    expect(await adminGate(adminReq("gate-a"), "admin/probe-free")).toBeNull();
  });

  it(`meters allowed admin calls per credential per route (${ADMIN_LIMIT}/window)`, async () => {
    set("ADMIN_TOKEN", "gate-b");
    for (let i = 0; i < ADMIN_LIMIT; i++) {
      expect(await adminGate(adminReq("gate-b"), "admin/probe-limit")).toBeNull();
    }
    const over = await adminGate(adminReq("gate-b"), "admin/probe-limit");
    expect(over?.status).toBe(429);
    const body = (await over!.json()) as { error: string; code: string };
    expect(body.code).toBe("RATE_LIMITED");
    // The budget is per credential and per route: one exhausted endpoint must
    // not close triage on the others, and a rotation is not a shared bucket.
    expect(await adminGate(adminReq("gate-b"), "admin/probe-other")).toBeNull();
    set("ADMIN_TOKEN", "gate-c");
    expect(await adminGate(adminReq("gate-c"), "admin/probe-limit")).toBeNull();
  });

  it("refusals use the shared envelope: code, message, request id", async () => {
    set("ADMIN_TOKEN", undefined);
    const noToken = await adminGate(adminReq("anything"), "admin/probe-envelope");
    expect(noToken?.status).toBe(403);
    expect((await noToken!.json()) as unknown).toEqual({ error: "forbidden", code: "FORBIDDEN" });
    // In production the job failure is an authentication failure, not a
    // permissions one, and it says so in the same shape.
    set("CRON_SECRET", "gate-secret");
    set("VITEST", undefined);
    set("NODE_ENV", "production");
    set("VERCEL_ENV", "production");
    const unauth = await jobGate(jobReq("wrong"), "jobs/probe-envelope", null);
    expect(unauth?.status).toBe(401);
    expect((await unauth!.json()) as unknown).toEqual({ error: "unauthorized", code: "UNAUTHORIZED" });
  });

  it(`meters job calls per credential, including the body/query secret path (${JOB_LIMIT}/window)`, async () => {
    set("CRON_SECRET", "gate-secret");
    for (let i = 0; i < JOB_LIMIT; i++) {
      expect(await jobGate(jobReq(undefined, "jobs/probe-limit?secret=gate-secret"), "jobs/probe-limit", null)).toBeNull();
    }
    const over = await jobGate(jobReq(undefined, "jobs/probe-limit?secret=gate-secret"), "jobs/probe-limit", null);
    expect(over?.status).toBe(429);
    expect(((await over!.json()) as { code: string }).code).toBe("RATE_LIMITED");
    // Same secret, different endpoint: its own budget.
    expect(await jobGate(jobReq(undefined, "jobs/probe-limit-2?secret=gate-secret"), "jobs/probe-limit-2", null)).toBeNull();
  });
});

describe("visibility truth tables", () => {
  it("discoverable = VISIBLE only; direct = VISIBLE + UNLISTED", () => {
    expect(isDiscoverable("VISIBLE")).toBe(true);
    expect(isDiscoverable("UNLISTED")).toBe(false);
    expect(isDiscoverable("HIDDEN")).toBe(false);
    expect(isDirectVisible("VISIBLE")).toBe(true);
    expect(isDirectVisible("UNLISTED")).toBe(true);
    expect(isDirectVisible("HIDDEN")).toBe(false);
  });
});
