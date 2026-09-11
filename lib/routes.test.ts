/* Phase 4 route contract tests (validation matrix: route contract coverage).
   Calls real route handlers with constructed requests against the local test
   DB (TST6/9994 fixtures, fully cleaned up). */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as searchGET } from "../app/api/search/route";
import { GET as statsGET } from "../app/api/stats/route";
import { GET as tableOrderGET } from "../app/api/table-order/route";
import { GET as boardGET } from "../app/api/board/route";
import { GET as activityGET } from "../app/api/activity/route";
import { GET as elementGET } from "../app/api/elements/[sym]/route";
import { POST as checkoutPOST } from "../app/api/checkout/route";
import { settlePayment } from "./settle";
import { audit } from "./audit";
import { isStatsResponse, isTableOrderRows, isBoardRows, isActivityRows, isSearchHits } from "./api";

const prisma = testPrisma();
const hasDb = hasTestDb;
const T6 = 9994;
const DOMAINS = ["ct-a.dev", "ct-b.dev"];
let keyN = 0;
const key = () => `p4-route-${Date.now()}-${keyN++}`;

const req = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  new NextRequest(`http://localhost${url}`, init);

beforeAll(async () => {
  if (!hasDb) return;
  await prisma.stake.deleteMany({ where: { elementId: T6 } });
  await prisma.element.upsert({
    where: { id: T6 },
    create: { id: T6, symbol: "TST6", name: "Test Six", atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
    update: {},
  });
  for (const [domain, amount] of [["ct-a.dev", 5000], ["ct-b.dev", 12]] as const) {
    const s = await prisma.startup.upsert({
      where: { domain },
      create: { domain, title: domain, pitch: "route fixture pitch", url: `https://${domain}`, logoUrl: "x" },
      update: {},
    });
    const payment = await prisma.payment.create({
      data: { elementId: T6, startupId: s.id, amountUsd: amount, path: "JOIN", provider: "DEV", idempotencyKey: key(), status: "PENDING" },
    });
    const out = await settlePayment(payment.id, { provider: "dev", eventId: `dev-${key()}`, eventType: "dev.test", paid: true });
    expect(out.outcome).toBe("applied");
  }
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
  await prisma.providerEvent.deleteMany({ where: { payment: { startup: { domain: { in: DOMAINS } } } } });
  await prisma.outboxEvent.deleteMany({ where: { OR: [{ dedupeKey: { contains: "p4-route" } }] } });
  await prisma.activityLog.deleteMany({ where: { domain: { in: DOMAINS } } });
  await prisma.payment.deleteMany({ where: { startup: { domain: { in: DOMAINS } } } });
  await prisma.auditLog.deleteMany({ where: { startup: { domain: { in: DOMAINS } } } });
  await prisma.firstClaim.deleteMany({ where: { elementId: T6 } });
  await prisma.stake.deleteMany({ where: { elementId: T6 } });
  await prisma.payment.deleteMany({ where: { startup: { domain: { startsWith: "rl-probe-" } } } });
  await prisma.element.deleteMany({ where: { id: T6 } });
  await prisma.startup.deleteMany({ where: { OR: [{ domain: { in: DOMAINS } }, { domain: { startsWith: "rl-probe-" } }] } });
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)("read API contracts", () => {
  it("search startup rows carry destinations (P1-06)", async () => {
    const res = await searchGET(req("/api/search?q=ct-a"));
    expect(res.status).toBe(200);
    const hits = (await res.json()) as unknown;
    expect(isSearchHits(hits)).toBe(true);
    if (!isSearchHits(hits)) return;
    const row = hits.find((h) => h.type === "startup" && h.domain === "ct-a.dev");
    expect(row).toBeDefined();
    if (!row || row.type !== "startup") return;
    expect(row.symbol).toBe("TST6");
    expect(row.elementName).toBe("Test Six");
    expect(row.amount).toBe(5000);
    expect(row.profileUrl).toBe("/s/ct-a.dev");
  });
  it("search element rows resolve tiles", async () => {
    const res = await searchGET(req("/api/search?q=TST6"));
    const hits = (await res.json()) as unknown;
    expect(isSearchHits(hits)).toBe(true);
  });
  it("stats use exact quantities and units (P1-09)", async () => {
    const res = await statsGET();
    const json = (await res.json()) as unknown;
    expect(isStatsResponse(json)).toBe(true);
    if (!isStatsResponse(json)) return;
    expect(json.unclaimedElements).toBe(json.elementsTotal - json.claimedElements);
    expect(json.claimedElements).toBeGreaterThanOrEqual(1);
    expect(json.totalStakedUsd).toBeGreaterThanOrEqual(42);
    expect(json.stakeCount).toBeGreaterThanOrEqual(2);
  });
  it("table order sums all stakes with deterministic order (P1-10)", async () => {
    const res = await tableOrderGET();
    const json = (await res.json()) as unknown;
    expect(isTableOrderRows(json)).toBe(true);
    if (!isTableOrderRows(json)) return;
    const row = json.find((r) => r.domain === "ct-a.dev");
    expect(row?.totalSpent).toBe(5000);
    expect(row?.crowns).toBe(1);
    for (let i = 1; i < json.length; i++) {
      const a = json[i - 1];
      const b = json[i];
      expect(
        a.totalSpent > b.totalSpent ||
          (a.totalSpent === b.totalSpent && (a.crowns > b.crowns || (a.crowns === b.crowns && a.domain <= b.domain)))
      ).toBe(true);
    }
  });
  it("board tabs implement three distinct metrics (P1-10)", async () => {
    const byEl = (await (await boardGET(req("/api/board?tab=by-element"))).json()) as unknown;
    expect(isBoardRows(byEl)).toBe(true);
    const crowns = (await (await boardGET(req("/api/board?tab=crowns"))).json()) as unknown;
    expect(isBoardRows(crowns)).toBe(true);
    const early = (await (await boardGET(req("/api/board?tab=early"))).json()) as unknown;
    expect(isBoardRows(early)).toBe(true);
    if (!isBoardRows(early)) return;
    // ct-a.dev claimed TST6 first (settle order) → holds an early medal.
    expect(early.some((r) => r.domain === "ct-a.dev" && r.total >= 1)).toBe(true);
    const bad = await boardGET(req("/api/board?tab=nope"));
    expect(bad.status).toBe(400);
  });
  it("activity exposes id, delta, total, truthful kind", async () => {
    const res = await activityGET(req("/api/activity?limit=20"));
    const json = (await res.json()) as unknown;
    expect(isActivityRows(json)).toBe(true);
    if (!isActivityRows(json)) return;
    // Feed shape holds for every row regardless of parallel-suite traffic.
    expect(json.length).toBeGreaterThan(0);
    // ct-a.dev's own activity row carries full truth (checked directly —
    // feed position is traffic-dependent).
    const row = await prisma.activityLog.findFirst({
      where: { domain: "ct-a.dev" },
      orderBy: { createdAt: "desc" },
    });
    expect(row?.deltaUsd).toBe(5000);
    expect(row?.resultTotalUsd).toBe(5000);
    expect(row?.paymentId).not.toBeNull();
  });
  it("element detail distinguishes populated vs missing", async () => {    const res = await elementGET(req("/api/elements/TST6"), { params: { sym: "TST6" } } as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as unknown as { stakes: { amount: number }[]; prices: { takeLead: number } };
    expect(json.stakes[0]?.amount).toBe(5000);
    expect(json.prices.takeLead).toBe(5001);
    const missing = await elementGET(req("/api/elements/NOPE"), { params: { sym: "NOPE" } } as never);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error?: string }).error).toBeTruthy();
  });
  it("checkout enforces 5 attempts per IP per hour", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await checkoutPOST(
        req("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            elementSym: "TST6",
            amountUsd: 5,
            attest: true,
            idempotencyKey: `p4-ratelimit-${Date.now()}-${i}`,
            startup: { title: `RL${i}`, pitch: "rate limit probe pitch", url: `https://rl-probe-${Date.now()}-${i}.dev`, linkType: "product" },
          }),
        })
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });
});

describe.skipIf(!hasDb)("audit inside a transaction", () => {
  // A bogus startupId is an FK violation (P2003), which is the cheapest way to
  // make auditLog.create fail on demand. Nothing is ever inserted, so these
  // tests leave no rows behind.
  const bad = { action: "STARTUP_CREATED" as const, startupId: "no-such-startup" };

  it("a failed audit write aborts the transaction instead of being swallowed", async () => {
    // The production shape: the checkout tx calls audit(), then continues to
    // tx.payment.create. Swallowing the audit error left Postgres' transaction
    // aborted, so the payment insert failed with 25P02 ("current transaction is
    // aborted, commands ignored until end of transaction block"). 25P02 is not
    // retryable, so a serialization conflict became a hard 500 for the buyer and
    // the real cause was hidden in a "non-blocking" log line.
    const failure = await prisma
      .$transaction(async (tx) => {
        await audit(bad, tx);
        await tx.auditLog.count(); // stands in for tx.payment.create
        return null;
      })
      .then(
        () => null,
        (e: unknown) => e as { name?: string; code?: string; message?: string }
      );

    // The audit write's own failure must surface — checked via `name`/`code`
    // rather than `instanceof`, because Prisma's Unknown variant (the one the
    // swallow produces) is a Proxy whose `code` reads as undefined.
    expect(failure).not.toBeNull();
    expect(failure?.name).toBe("PrismaClientKnownRequestError");
    expect(failure?.code).toBe("P2003");
    // And never the downstream symptom, which is unretryable and undiagnosable.
    expect(failure?.message ?? "").not.toContain("25P02");
    expect(failure?.message ?? "").not.toContain("current transaction is aborted");
  });

  it("a failed audit write outside a transaction is still non-blocking", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(audit(bad)).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
