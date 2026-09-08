/* Phase 6 ops tests — pure (no DB): trusted IP, URL validation, rate-store
   behavior, job/admin auth branches, visibility truth tables. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clientIp } from "./ip";
import { normalizeUrl, isPublicHost, domainFromUrl } from "./validate";
import { rateLimitAsync, setSharedRateLimitStore, type RateLimitStore } from "./rateStore";
import { jobAuth, adminAuth } from "./jobs";
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
