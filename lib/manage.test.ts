/* Phase 1 ownership integration tests — requires DATABASE_URL.
   Uses isolated fixtures (manage-t.dev, own-t.dev, TST3/9997) created and
   cleaned up by the suite. Covers: immutable existing profiles, magic-link
   lifecycle, waitlist upsert, FirstClaim runtime creation, and R14-7 (the raw
   manage token needs a development process *and* an explicit opt-in). */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first: pins DATABASE_URL before lib singletons bind
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { findOrCreateCheckoutStartup } from "./startups";
import {
  requestManageToken,
  consumeManageToken,
  getManageSession,
  hashToken,
  devManageTokenEnabled,
} from "./manage";
import { POST as manageRequestPOST } from "../app/api/manage/request/route";
import { applyStakeTx } from "./recompute";

const prisma = testPrisma();
const hasDb = hasTestDb;
const T3 = 9997;

beforeAll(async () => {
  if (!hasDb) return;
  await prisma.stake.deleteMany({ where: { elementId: T3 } });
  await prisma.element.upsert({
    where: { id: T3 },
    create: { id: T3, symbol: "TST3", name: "Test TST3", atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
    update: {},
  });
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
  const domains = ["manage-t.dev", "own-t.dev", "fc-t.dev"];
  await prisma.manageToken.deleteMany({ where: { startup: { domain: { in: domains } } } });
  await prisma.manageSession.deleteMany({ where: { startup: { domain: { in: domains } } } });
  await prisma.auditLog.deleteMany({ where: { startup: { domain: { in: domains } } } });
  await prisma.activityLog.deleteMany({ where: { domain: { in: domains } } });
  await prisma.waitlistEntry.deleteMany({ where: { email: { in: ["wait-t@example.com"] } } });
  await prisma.firstClaim.deleteMany({ where: { elementId: T3 } });
  await prisma.stake.deleteMany({ where: { elementId: T3 } });
  await prisma.element.deleteMany({ where: { id: T3 } });
  await prisma.startup.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)("checkout startup ownership", () => {
  it("creates once, then never mutates the existing profile", async () => {
    const first = await findOrCreateCheckoutStartup({
      domain: "own-t.dev",
      title: "Original",
      pitch: "Original pitch here",
      url: "https://own-t.dev",
      linkType: "product",
      email: "owner@own-t.dev",
    });
    expect(first.created).toBe(true);
    const second = await findOrCreateCheckoutStartup({
      domain: "own-t.dev",
      title: "Hijacked",
      pitch: "Hijacked pitch here!!",
      url: "https://evil.example.com",
      linkType: "product",
      email: "attacker@example.com",
    });
    expect(second.created).toBe(false);
    const row = await prisma.startup.findUniqueOrThrow({ where: { domain: "own-t.dev" } });
    expect(row.title).toBe("Original");
    expect(row.url).toBe("https://own-t.dev");
    expect(row.email).toBe("owner@own-t.dev");
    const audits = await prisma.auditLog.findMany({ where: { startupId: row.id, action: "STARTUP_CREATED" } });
    expect(audits.length).toBe(1);
  });
});

/* R14-7: the raw token must not be reachable by a caller on a deployment. The
   app-env gate excludes preview and production; DEV_MANAGE_TOKENS=1 is the
   second, independent gate, so a misclassified environment is not enough and a
   deployment the Vercel project never sets the flag on hands nothing out. */
describe("devManageTokenEnabled (R14-7)", () => {
  /** Classify one environment with VITEST cleared: the runner's own marker pins
   *  every answer to "test" otherwise, and "test" is precisely the case that
   *  must withhold the token. */
  function classify(env: {
    VERCEL_ENV?: string;
    NODE_ENV?: string;
    DEV_MANAGE_TOKENS?: string;
  }): boolean {
    // VITEST is stubbed to "" rather than deleted: the runner's own marker would
    // pin every answer to "test" otherwise, and "test" is precisely the case that
    // must withhold the token. vi.unstubAllEnvs restores all four.
    vi.stubEnv("VITEST", "");
    vi.stubEnv("VERCEL_ENV", env.VERCEL_ENV);
    vi.stubEnv("NODE_ENV", env.NODE_ENV);
    vi.stubEnv("DEV_MANAGE_TOKENS", env.DEV_MANAGE_TOKENS);
    try {
      return devManageTokenEnabled();
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it("refuses every deployment shape, flag or no flag", () => {
    expect(classify({ NODE_ENV: "production", DEV_MANAGE_TOKENS: "1" })).toBe(false);
    expect(classify({ VERCEL_ENV: "production", DEV_MANAGE_TOKENS: "1" })).toBe(false);
    // The preview class may point at the production database (checklist l.16).
    expect(classify({ VERCEL_ENV: "preview", DEV_MANAGE_TOKENS: "1" })).toBe(false);
    // A local process is development whatever it is called by, flag or no flag.
    expect(classify({ NODE_ENV: "development" })).toBe(false);
    expect(classify({ VERCEL_ENV: "development", DEV_MANAGE_TOKENS: "1" })).toBe(true);
  });

  it("needs the opt-in spelled out, not merely present", () => {
    for (const value of ["true", "yes", "dev", "0", "", " 1"]) {
      expect(classify({ NODE_ENV: "development", DEV_MANAGE_TOKENS: value }), value).toBe(false);
    }
    expect(classify({ NODE_ENV: "development", DEV_MANAGE_TOKENS: "1" })).toBe(true);
  });
});

describe.skipIf(!hasDb)("magic-link lifecycle", () => {
  it("unknown domain reveals nothing and stores nothing", async () => {
    const before = await prisma.manageToken.count();
    const r = await requestManageToken({ domain: "no-such-t.dev", email: "x@y.zz" });
    expect(r).toEqual({ sent: true });
    expect(await prisma.manageToken.count()).toBe(before);
  });
  it("request → consume → session, single-use", async () => {
    await findOrCreateCheckoutStartup({
      domain: "manage-t.dev",
      title: "Manage",
      pitch: "Manage pitch here",
      url: "https://manage-t.dev",
      linkType: "product",
      email: "owner@manage-t.dev",
    });
    const before = await prisma.manageToken.count();
    const req = await requestManageToken({ domain: "manage-t.dev", email: "owner@manage-t.dev" });
    expect(req.sent).toBe(true);
    // R10-2/R14-7: the raw token is a development-only convenience behind an
    // explicit opt-in. Under the test app env the request still mints, but the
    // response never carries it — and the test runner's own env marker counts
    // as "not development" however the rest of the process is configured.
    expect(devManageTokenEnabled()).toBe(false);
    expect(req.__devToken).toBeUndefined();
    expect(await prisma.manageToken.count()).toBe(before + 1);
    const minted = await prisma.manageToken.findFirstOrThrow({
      where: { startup: { domain: "manage-t.dev" } },
      orderBy: { createdAt: "desc" },
    });
    expect(minted.email).toBe("owner@manage-t.dev");
    // The audit names the address that controls the listing's own address, so
    // "owner" in the trail is a fact rather than an assumption (R10-2).
    const requested = await prisma.auditLog.findFirstOrThrow({
      where: { startupId: minted.startupId, action: "MANAGE_LINK_REQUESTED" },
      orderBy: { createdAt: "desc" },
    });
    expect(requested.actorType).toBe("owner");
    expect(requested.actorRef).toBe("owner@manage-t.dev");

    // The consume/session half is driven with a token this test knows the raw
    // form of, since the route no longer hands one back outside development.
    const startup = await prisma.startup.findUniqueOrThrow({ where: { domain: "manage-t.dev" } });
    await prisma.manageToken.create({
      data: {
        startupId: startup.id,
        email: "owner@manage-t.dev",
        tokenHash: hashToken("manage-raw-token"),
        purpose: "profile-manage",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const consumed = await consumeManageToken("manage-raw-token");
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) return;
    expect(consumed.domain).toBe("manage-t.dev");
    // Single-use: replay fails.
    expect((await consumeManageToken("manage-raw-token")).ok).toBe(false);
    // Session resolves, unknown token does not.
    const session = await getManageSession(consumed.sessionToken);
    expect(session?.domain).toBe("manage-t.dev");
    expect(await getManageSession("bogus")).toBeNull();
  });

  /* R14-7 ends at the HTTP boundary: the field name and the two gates have to
   * hold in the response a caller can read, not just in the function. */
  it("hands the raw token over HTTP only while both gates are open", async () => {
    const ask = () =>
      manageRequestPOST(
        new NextRequest("http://localhost/api/manage/request", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ domain: "manage-t.dev", email: "owner@manage-t.dev" }),
        })
      );
    try {
      // A development process that asked for it: the token is in the body, under
      // a name that cannot read like a shipped field.
      vi.stubEnv("VITEST", "");
      vi.stubEnv("VERCEL_ENV", undefined);
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("DEV_MANAGE_TOKENS", "1");
      const on = await ask();
      expect(on.status).toBe(200);
      const onBody = (await on.json()) as { ok: boolean; note: string; __devToken?: string };
      expect(onBody.ok).toBe(true);
      expect(onBody.__devToken).toMatch(/^[0-9a-f]{64}$/);

      // Same process, same request, flag removed: the shape is the shipped one.
      vi.stubEnv("DEV_MANAGE_TOKENS", undefined);
      const off = await ask();
      expect(off.status).toBe(200);
      expect(await off.json()).toEqual({
        ok: true,
        note: "Listing management is not enabled — your listing is set at checkout and is final.",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /* R10-2 (P0): the mint used to accept whatever address the caller supplied and
   * never compare it with the listing, so one unauthenticated POST produced a
   * working token for someone else's startup on every deployment whose app env
   * was not `production` — including a preview deployment pointed at the
   * production database. Asking is not owning: nothing is minted unless the
   * request comes from the address the listing itself carries. */
  it("mints nothing for a stranger's address, and nothing for a listing with no address", async () => {
    const startup = await prisma.startup.findUniqueOrThrow({ where: { domain: "manage-t.dev" } });
    const before = await prisma.manageToken.count();
    expect(await requestManageToken({ domain: "manage-t.dev", email: "attacker@d10.dev" })).toEqual({
      sent: true,
    });
    expect(await prisma.manageToken.count()).toBe(before);

    // `Startup.email = null` is not "anyone may manage it": there is no address
    // to compare against, so the request fails closed the same way.
    await prisma.startup.update({ where: { id: startup.id }, data: { email: null } });
    expect(await requestManageToken({ domain: "manage-t.dev", email: "owner@manage-t.dev" })).toEqual({
      sent: true,
    });
    expect(await prisma.manageToken.count()).toBe(before);
    await prisma.startup.update({ where: { id: startup.id }, data: { email: "owner@manage-t.dev" } });
  });
  it("expired tokens do not consume", async () => {
    const startup = await prisma.startup.findUniqueOrThrow({ where: { domain: "manage-t.dev" } });
    await prisma.manageToken.create({
      data: {
        startupId: startup.id,
        email: "owner@manage-t.dev",
        tokenHash: hashToken("expired-raw-token"),
        purpose: "profile-manage",
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    expect((await consumeManageToken("expired-raw-token")).ok).toBe(false);
  });
});

describe.skipIf(!hasDb)("waitlist + first-claim writes", () => {
  it("one row per email, re-submits refresh consent", async () => {
    const a = await prisma.waitlistEntry.upsert({
      where: { email: "wait-t@example.com" },
      create: { email: "wait-t@example.com", domain: "x.dev", source: "checkout-paused" },
      update: { consentAt: new Date() },
    });
    const b = await prisma.waitlistEntry.upsert({
      where: { email: "wait-t@example.com" },
      create: { email: "wait-t@example.com" },
      update: { domain: "y.dev", consentAt: new Date() },
    });
    expect(a.id).toBe(b.id);
    expect((await prisma.waitlistEntry.findMany({ where: { email: "wait-t@example.com" } })).length).toBe(1);
  });
  it("applyStakeTx records the first claim with ledger provenance", async () => {
    const s = await findOrCreateCheckoutStartup({
      domain: "fc-t.dev",
      title: "FC",
      pitch: "FC pitch here",
      url: "https://fc-t.dev",
      linkType: "product",
      email: null,
    });
    await applyStakeTx({ elementId: T3, startupId: s.startup.id, addUsd: 5, kind: "join" });
    const fc = await prisma.firstClaim.findUniqueOrThrow({ where: { elementId: T3 } });
    expect(fc.startupId).toBe(s.startup.id);
    expect(fc.source).toBe("ledger");
    expect(fc.confidence).toBe("HIGH");
  });
});
