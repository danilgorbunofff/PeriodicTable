/* Phase 6 ops tests — pure (no DB): trusted IP, URL validation, rate-store
   behavior, job/admin auth branches, visibility truth tables. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { clientIp } from "./ip";
import { normalizeUrl, isPublicHost, domainFromUrl } from "./validate";
import {
  rateLimitAsync,
  setSharedRateLimitStore,
  type RateLimitStore,
} from "./rateStore";
import {
  jobAuth,
  adminAuth,
  adminGate,
  jobGate,
  operatorTokens,
  operatorIdentity,
  ADMIN_LIMIT,
  JOB_LIMIT,
  AUTH_REJECTION_LIMIT,
} from "./jobs";
import { isDiscoverable, isDirectVisible } from "./moderation";

type Env = Record<string, string | undefined>;
const env = process.env as unknown as Env;
/** `next-env.d.ts` requires NODE_ENV on ProcessEnv, so a partial snapshot needs
 *  the double assertion to reach a function that takes the real one. */
const penv = (o: Env) => o as unknown as NodeJS.ProcessEnv;
const saved: Env = {};
function set(k: string, v: string | undefined) {
  if (saved[k] === undefined && !(k in saved)) saved[k] = env[k];
  if (v === undefined) delete env[k];
  else env[k] = v;
}
/** A loopback database URL for the tests that exercise the local-rehearsal arm
 * of jobAuth: the live test database when the suite has one, an unlistened
 * loopback port otherwise. Either way the gate reads the host, and the
 * heartbeat read behind it is best-effort. Never the ambient value — this suite
 * is DB-less by design and .env holds the production URL (R13-2). */
const LOCAL_DB =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:55433/periodictable_test";
const REMOTE_DB =
  "postgresql://u:p@ep-remote-pooler.us-east-2.aws.neon.tech/db";

/* This suite is DB-less by design (no ./testDb import), so the ambient
 * DATABASE_URL is whatever .env holds — the production URL. Two things read it:
 * the R13-2 gate, which the tests below move per case through set()/restore, and
 * Prisma itself, which captures the URL when the config route's module graph
 * first imports lib/prisma.ts. Pin the process to a loopback database here, at
 * module scope and before any test body, so no assertion in this file can reach
 * the production queue; nothing in the static imports above loads lib/prisma.ts,
 * so this pin is the one the client is built from. */
process.env.DATABASE_URL = LOCAL_DB;

beforeEach(() => {
  for (const k of [
    "NODE_ENV",
    "VERCEL_ENV",
    "VITEST",
    "CRON_SECRET",
    "ADMIN_TOKEN",
    "ADMIN_TOKENS",
    "DATABASE_URL",
  ]) {
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

describe("clientIp trust order (R14-2)", () => {
  it("trusts cf-connecting-ip only when cf-ray proves the request went through it", () => {
    expect(
      clientIp(
        headers({
          "cf-ray": "8f1a1b2c3d4e5f60-AMS",
          "cf-connecting-ip": "1.1.1.1",
          "x-real-ip": "2.2.2.2",
          "x-forwarded-for": "3.3.3.3",
        }),
      ),
    ).toBe("1.1.1.1");
    // A caller that sets the header itself has no cf-ray to go with it, so the
    // pair is not believed and the chain decides.
    expect(
      clientIp(headers({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "3.3.3.3, 4.4.4.4" })),
    ).toBe("4.4.4.4");
  });

  it("takes the rightmost hop a caller cannot write, not the leftmost", () => {
    expect(clientIp(headers({ "x-forwarded-for": "9.9.9.9, 4.4.4.4, 5.5.5.5" }))).toBe("5.5.5.5");
    // Junk on the right is skipped rather than used as a bucket.
    expect(clientIp(headers({ "x-forwarded-for": "4.4.4.4, unknown, " }))).toBe("4.4.4.4");
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.7, [2001:db8::1]" }))).toBe("2001:db8::1");
  });

  it("falls back to x-real-ip, then to one shared bucket", () => {
    expect(clientIp(headers({ "x-real-ip": "2.2.2.2" }))).toBe("2.2.2.2");
    expect(clientIp(headers({ "x-forwarded-for": "not-an-address" }))).toBe("0.0.0.0");
    expect(clientIp(headers({}))).toBe("0.0.0.0");
  });

  it("refuses to let an unshaped header rotate the bucket (R14-2)", () => {
    // The review's rotation: each request carried a different header and each
    // landed in a fresh bucket. Every shape a caller can invent without an edge
    // writing it collapses to the same answer.
    for (const junk of ["", " ", "unknown", "a".repeat(50), "1.1.1.1<script>", "::"]) {
      expect(clientIp(headers({ "x-forwarded-for": junk, "x-real-ip": junk }))).toBe("0.0.0.0");
    }
  });
});

describe("isPublicHost + normalizeUrl (SSRF-adjacent inputs)", () => {
  it("accepts ordinary public DNS names", () => {
    expect(isPublicHost("acme.dev")).toBe(true);
    expect(normalizeUrl("https://Acme-Startup.COM/launch?x=1")).toBe(
      "https://acme-startup.com/launch?x=1",
    );
  });
  it("rejects credentials in URLs", () => {
    expect(normalizeUrl("https://user:pass@acme.dev/")).toBeNull();
    expect(normalizeUrl("https://user@acme.dev/")).toBeNull();
  });
  it("rejects IPs, localhost, and obfuscations", () => {
    for (const h of [
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.9",
      "169.254.169.254",
      "0.0.0.0",
      "localhost",
      "[::1]",
      "2130706433",
      "0177.0.0.1",
    ]) {
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
    setSharedRateLimitStore({
      incr: async () => {
        throw new Error("redis down");
      },
    });
    expect(await rateLimitAsync("x", 1, 1000)).toBe(true);
  });
  it("fails closed when the caller asks it to (R14-2)", async () => {
    // The callers in front of mail and money choose this: if the store cannot
    // answer, the request is refused rather than waved through, because the
    // limiter is the only thing counting what that route is about to spend.
    setSharedRateLimitStore({
      incr: async () => {
        throw new Error("redis down");
      },
    });
    expect(await rateLimitAsync("y", 1, 1000, { onStoreError: "closed" })).toBe(false);
    // Explicit "open" is the historical behaviour, for callers that say so.
    expect(await rateLimitAsync("y", 1, 1000, { onStoreError: "open" })).toBe(true);
  });
});

describe("jobAuth", () => {
  const req = (bearer?: string) =>
    new Request(
      "http://localhost/api/jobs/outbox",
      bearer
        ? { headers: { authorization: `Bearer ${bearer}` } }
        : ({} as RequestInit),
    );
  it("allows with a matching secret outside production", () => {
    set("CRON_SECRET", "s3cr3t");
    expect(jobAuth(req("s3cr3t") as never, null)).toBeNull();
  });
  it("still honours the secret against a remote database — the tick is not a rehearsal", () => {
    set("CRON_SECRET", "s3cr3t");
    set("DATABASE_URL", REMOTE_DB);
    expect(jobAuth(req("s3cr3t") as never, null)).toBeNull();
    expect(jobAuth(req() as never, "s3cr3t")).toBeNull();
  });
  it("answers an unauthenticated call only while the database is on this machine (R13-2)", () => {
    // The finding: the exemption was decided by the environment string, so a
    // preview deployment — or `next start` on a laptop with the production
    // .env loaded — answered an unauthenticated worker call, and the queue it
    // drains is the same queue.
    set("VITEST", "true");
    set("NODE_ENV", "test");
    set("CRON_SECRET", "s3cr3t");
    set("DATABASE_URL", LOCAL_DB);
    expect(jobAuth(req() as never, null)).toBeNull();
    set("DATABASE_URL", REMOTE_DB);
    expect(jobAuth(req() as never, null)?.status).toBe(401);
    // Unparsable and unset both fail closed: the credential check is the only
    // thing left when we cannot say where the data is.
    set("DATABASE_URL", "not a url");
    expect(jobAuth(req() as never, null)?.status).toBe(401);
    set("DATABASE_URL", undefined);
    expect(jobAuth(req() as never, null)?.status).toBe(401);
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
  it("reports the mail driver and the suppression count the email runbook reads (R17-13)", async () => {
    const { GET } = await import("../app/api/jobs/config/route");
    const { mailDriver } = await import("./email");

    // Pure: the driver is an env read, so both arms are pinned without a send.
    expect(mailDriver(penv({}))).toBe("logged");
    expect(mailDriver(penv({ RESEND_API_KEY: "re_test" }))).toBe("resend");

    set("CRON_SECRET", "s3cr3t");
    set("DATABASE_URL", LOCAL_DB);
    const res = await GET(
      new NextRequest("http://localhost/api/jobs/config") as never,
    );
    const body = (await res.json()) as {
      mail: { driver: string; suppressed: number; failedCount: number } | null;
    };
    // `mail` is null when the database cannot answer — that is the block's own
    // design (R10-1). When it can, ops/email.md's first step reads two fields
    // that must be there whatever the queue looks like.
    if (body.mail) {
      expect(["resend", "logged"]).toContain(body.mail.driver);
      expect(body.mail.driver).toBe(mailDriver());
      expect(typeof body.mail.suppressed).toBe("number");
      expect(typeof body.mail.failedCount).toBe("number");
    }
  });

  it("gates like the other job endpoints and never echoes values", async () => {
    const { GET } = await import("../app/api/jobs/config/route");
    const call = (h?: Record<string, string>) =>
      GET(
        new NextRequest("http://localhost/api/jobs/config", {
          headers: h,
        }) as never,
      );

    set("CRON_SECRET", "s3cr3t");
    // R13-2: the unauthenticated arm of jobAuth is now decided by the database
    // host, and R13-3 made this route read the job heartbeats behind it. Pin
    // both, or the gate answer — and the query — come from .env's production
    // URL.
    set("DATABASE_URL", LOCAL_DB);
    // Outside production jobAuth permits the local rehearsal shape.
    const local = await call();
    const body = (await local.json()) as {
      ok: boolean;
      env: string;
      stripeKey: string;
      heartbeats: unknown;
      cost: unknown;
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
    // R13-3: the ages the heartbeat findings were drawn from, or null when the
    // report could not read them. Best-effort either way — a database that
    // cannot answer this must not turn the report into a 500.
    expect(body.heartbeats === null || Array.isArray(body.heartbeats)).toBe(
      true,
    );
    // R15-11/R15-13: the spend/backlog numbers, or null when the database could
    // not answer. Same best-effort contract as `heartbeats` — this is the
    // operator surface, and a report that turns into a 500 because a count
    // failed is a report nobody can read.
    expect(body.cost === null || typeof body.cost === "object").toBe(true);
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
    const call = () =>
      GET(new NextRequest("http://localhost/api/jobs/config") as never);

    // Pin the environment rather than inheriting it: all required variables are
    // about to be set, and in a production process that would let the S4 probe
    // issue a real call with the stub key "x".
    set("VERCEL_ENV", undefined);
    set("VITEST", "true");
    set("NODE_ENV", "test");

    for (const k of REQUIRED_PROD_ENV) set(k, "x");
    set("NEXT_PUBLIC_APP_URL", "https://periodictable.lol");
    set("CLICK_SALT", "a-private-random-value");
    // DATABASE_URL is one of the required variables the loop just set to "x",
    // and the R13-2 gate reads it: an unauthenticated call is answered only
    // from a loopback database, so "x" would 401 before health was ever read.
    set("DATABASE_URL", LOCAL_DB);

    const healthy = await call();
    const healthyBody = (await healthy.json()) as {
      ok: boolean;
      stripeKey: string;
      heartbeats: unknown;
      findings: { key: string; severity: string }[];
    };
    expect(healthy.status).toBe(200);
    expect(healthyBody.ok).toBe(true);
    expect(healthyBody.stripeKey).toBe("not-checked");
    expect(
      healthyBody.heartbeats === null || Array.isArray(healthyBody.heartbeats),
    ).toBe(true);
    // Advisories may or may not be present depending on the host environment;
    // what must be absent is anything that blocks serving.
    expect(
      healthyBody.findings.filter((f) => f.severity === "required"),
    ).toEqual([]);

    // One required variable gone is exactly the failure the pinger must see.
    set("TURNSTILE_SECRET", undefined);
    const gap = await call();
    const gapBody = (await gap.json()) as {
      ok: boolean;
      findings: { key: string; severity: string }[];
    };
    expect(gap.status).toBe(503);
    expect(gapBody.ok).toBe(false);
    expect(gapBody.findings.map((f) => f.key)).toContain("TURNSTILE_SECRET");
  });
});

describe("adminAuth", () => {
  const req = (bearer?: string) =>
    new Request(
      "http://localhost/api/admin/x",
      bearer
        ? { headers: { authorization: `Bearer ${bearer}` } }
        : ({} as RequestInit),
    );
  it("403s when unset or mismatched, passes on match", () => {
    set("ADMIN_TOKEN", undefined);
    expect(adminAuth(req("anything") as never)?.status).toBe(403);
    set("ADMIN_TOKEN", "opaque-admin");
    expect(adminAuth(req("wrong") as never)?.status).toBe(403);
    expect(adminAuth(req() as never)?.status).toBe(403);
    expect(adminAuth(req("opaque-admin") as never)).toBeNull();
  });
});

describe("named operator tokens (R17-6)", () => {
  const req = (bearer?: string) =>
    new Request(
      "http://localhost/api/admin/x",
      bearer ? { headers: { authorization: `Bearer ${bearer}` } } : ({} as RequestInit),
    );

  it("parses name:token pairs, tolerating spaces and tokens that contain colons", () => {
    expect(operatorTokens(penv({ ADMIN_TOKENS: undefined }))).toEqual([]);
    expect(operatorTokens(penv({ ADMIN_TOKENS: "" }))).toEqual([]);
    expect(
      operatorTokens(penv({ ADMIN_TOKENS: "alice:aaa, bob:bbb" })),
    ).toEqual([
      { name: "alice", token: "aaa" },
      { name: "bob", token: "bbb" },
    ]);
    // indexOf(":") — a base64-ish token with a colon in it still resolves, and
    // the name is what precedes the *first* separator.
    expect(operatorTokens(penv({ ADMIN_TOKENS: "carol:a:b:c" }))).toEqual([
      { name: "carol", token: "a:b:c" },
    ]);
    // Malformed entries are skipped rather than treated as anonymous
    // credentials: a pair with no name or no token must not authenticate.
    expect(operatorTokens(penv({ ADMIN_TOKENS: ":nope,dan: ,eve:" }))).toEqual([]);
  });

  it("names a credential only when the list names it, never the shared token", () => {
    set("ADMIN_TOKEN", "shared");
    set("ADMIN_TOKENS", "alice:aaa,bob:bbb");
    expect(operatorIdentity(req("shared") as never)).toBeNull();
    expect(operatorIdentity(req("bbb") as never)).toBe("bob");
    expect(operatorIdentity(req("nope") as never)).toBeNull();
    expect(operatorIdentity(req() as never)).toBeNull();
  });

  it("adminAuth accepts a named token too, and still refuses everything else", () => {
    set("ADMIN_TOKEN", "shared");
    set("ADMIN_TOKENS", "alice:aaa,bob:bbb");
    expect(adminAuth(req("bbb") as never)).toBeNull();
    expect(adminAuth(req("shared") as never)).toBeNull();
    // Removing one entry revokes exactly that person.
    set("ADMIN_TOKENS", "alice:aaa");
    expect(adminAuth(req("bbb") as never)?.status).toBe(403);
    expect(adminAuth(req("aaa") as never)).toBeNull();
    // Named list only: no shared token, no anonymous exit.
    set("ADMIN_TOKEN", undefined);
    expect(adminAuth(req("aaa") as never)).toBeNull();
    expect(adminAuth(req() as never)?.status).toBe(403);
  });
});

describe("adminGate / jobGate — the metered gates (R11-4)", () => {
  const withBearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const adminReq = (token?: string, route = "admin/probe") =>
    new NextRequest(
      `http://localhost/api/${route}`,
      token ? { headers: withBearer(token) } : undefined,
    );
  const jobReq = (token?: string, route = "jobs/probe") =>
    new NextRequest(
      `http://localhost/api/${route}`,
      token ? { headers: withBearer(token) } : undefined,
    );

  it("checks the credential before it spends budget, so probing is free (R14-2)", async () => {
    set("ADMIN_TOKEN", "gate-a");
    // The review's reproduction: fifty consecutive unauthorised calls, all 200
    // for the job route it probed. Refusals must not consume the operator's own
    // budget either, or a stranger could lock the operator out of triage — they
    // are metered separately, by source address, and only for the prober.
    for (let i = 0; i < AUTH_REJECTION_LIMIT; i++) {
      const denied = await adminGate(adminReq("wrong"), "admin/probe-free");
      expect(denied?.status).toBe(403);
      expect(denied?.headers.get("x-request-id")).toBeTruthy();
    }
    // The operator's own call still passes after a full hour of probing: the
    // refusal meter is not the credential budget.
    expect(await adminGate(adminReq("gate-a"), "admin/probe-free")).toBeNull();
    // And the prober has spent their allowance on this route, so the gate stops
    // answering them at all.
    const throttled = await adminGate(adminReq("wrong"), "admin/probe-free");
    expect(throttled?.status).toBe(429);
    const body = (await throttled!.json()) as { error: string; code: string };
    expect(body.code).toBe("RATE_LIMITED");
    // Per route: the same source may still be refused properly elsewhere.
    expect((await adminGate(adminReq("wrong"), "admin/probe-free-2"))?.status).toBe(403);
  });

  it("logs every refusal by shape and source, and never the value (R14-10)", async () => {
    const CANARY = "wrong-gate-token-canary";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      set("ADMIN_TOKEN", "gate-shape");
      // A prober with a bearer token and one with no credential at all are
      // different events, and the line says which one happened.
      await adminGate(adminReq(CANARY), "admin/probe-log-bearer");
      await adminGate(adminReq(), "admin/probe-log-none");
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines[0]).toContain("auth: refused (bearer token, 403)");
      expect(lines[0]).toContain("/api/admin/probe-log-bearer");
      expect(lines[0]).toContain("from 0.0.0.0");
      expect(lines[1]).toContain("auth: refused (no credential, 403)");
      expect(lines[1]).toContain("admin/probe-log-none");

      // The alert threshold escalates exactly the twentieth refusal on a route:
      // the review's hundred wrong tokens crosses it in the first minute, and a
      // line per guess would be the flood the operator is meant to see instead.
      for (let i = 0; i < 20; i++) await adminGate(adminReq(CANARY), "admin/probe-log-alert");
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain("(a rate no operator reaches by hand)");
      expect(String(error.mock.calls[0][0])).toContain("20 this hour");

      // A log line is a durable artefact on a platform we do not own: the value
      // tried, and the value stored, must not be legible in it.
      set("ADMIN_TOKEN", "gate-real-value");
      await adminGate(adminReq("gate-real-value"), "admin/probe-log-ok");
      await adminGate(adminReq("gate-real-value-typo"), "admin/probe-log-typo");
      const everything = [...warn.mock.calls, ...error.mock.calls].map((c) => String(c[0])).join("\n");
      expect(everything).not.toContain(CANARY);
      expect(everything).not.toContain("gate-real-value");
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it(`meters allowed admin calls per credential per route (${ADMIN_LIMIT}/window)`, async () => {
    set("ADMIN_TOKEN", "gate-b");
    for (let i = 0; i < ADMIN_LIMIT; i++) {
      expect(
        await adminGate(adminReq("gate-b"), "admin/probe-limit"),
      ).toBeNull();
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
    const noToken = await adminGate(
      adminReq("anything"),
      "admin/probe-envelope",
    );
    expect(noToken?.status).toBe(403);
    expect((await noToken!.json()) as unknown).toEqual({
      error: "forbidden",
      code: "FORBIDDEN",
    });
    // In production the job failure is an authentication failure, not a
    // permissions one, and it says so in the same shape.
    set("CRON_SECRET", "gate-secret");
    set("VITEST", undefined);
    set("NODE_ENV", "production");
    set("VERCEL_ENV", "production");
    const unauth = await jobGate(jobReq("wrong"), "jobs/probe-envelope", null);
    expect(unauth?.status).toBe(401);
    expect((await unauth!.json()) as unknown).toEqual({
      error: "unauthorized",
      code: "UNAUTHORIZED",
    });
  });

  it(`meters job calls per caller, including the credential-free rehearsal arm (${JOB_LIMIT}/window)`, async () => {
    set("CRON_SECRET", "gate-secret");
    // The calls below carry no credential at all — they rely on the local
    // rehearsal arm of jobAuth, which R13-2 decides by the database host, so
    // they all share the "unauthenticated" budget. R14-8 deleted the `?secret=`
    // query term that used to name it: a query string is part of the request a
    // caller writes, so it must not be able to buy a fresh bucket.
    set("DATABASE_URL", LOCAL_DB);
    for (let i = 0; i < JOB_LIMIT; i++) {
      expect(
        await jobGate(
          jobReq(undefined, "jobs/probe-limit"),
          "jobs/probe-limit",
          null,
        ),
      ).toBeNull();
    }
    const over = await jobGate(
      jobReq(undefined, "jobs/probe-limit?secret=gate-secret"),
      "jobs/probe-limit",
      null,
    );
    expect(over?.status).toBe(429);
    expect(((await over!.json()) as { code: string }).code).toBe(
      "RATE_LIMITED",
    );
    // The same caller on a different endpoint has its own budget — and inventing
    // a secret per request does not create one.
    expect(
      await jobGate(jobReq(undefined, "jobs/probe-limit-2"), "jobs/probe-limit-2", null),
    ).toBeNull();
    // A real credential is a different caller: it is not billed for the probing
    // above, which is the whole reason the key is the credential and not the IP.
    expect(await jobGate(jobReq("gate-secret"), "jobs/probe-limit", null)).toBeNull();
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
