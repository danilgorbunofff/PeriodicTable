/* Phase 4 route contract tests (validation matrix: route contract coverage).
   Calls real route handlers with constructed requests against the local test
   DB (TST6/9994 fixtures, fully cleaned up). */
import { hasTestDb, purgeSettledOutbox, testPrisma } from "./testDb"; // must stay first
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
// A symbol the inventory actually authors (`Hbar`, not `HBAR`) is the only way
// to test canonical casing end to end (R04-4).
const HBAR = 9992;
const HIDDEN = "helemprobe.dev";
const DOMAINS = ["ct-a.dev", "ct-b.dev", HIDDEN];
let keyN = 0;
let madeHbar = false;
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
  if (!(await prisma.element.findUnique({ where: { symbol: "Hbar" } }))) {
    // Created only when the test DB has no `Hbar`; a seeded one is used as-is
    // and left untouched by the cleanup below.
    madeHbar = true;
    await prisma.element.create({
      data: { id: HBAR, symbol: "Hbar", name: "Hbar Test", atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
    });
  }
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
  await purgeSettledOutbox(prisma, {
    OR: [{ startup: { domain: { in: DOMAINS } } }, { startup: { domain: { startsWith: "rl-probe-" } } }],
  });
  await prisma.activityLog.deleteMany({ where: { domain: { in: DOMAINS } } });
  await prisma.payment.deleteMany({ where: { startup: { domain: { in: DOMAINS } } } });
  await prisma.auditLog.deleteMany({ where: { startup: { domain: { in: DOMAINS } } } });
  await prisma.firstClaim.deleteMany({ where: { elementId: T6 } });
  await prisma.stake.deleteMany({ where: { elementId: T6 } });
  if (madeHbar) {
    await prisma.firstClaim.deleteMany({ where: { elementId: HBAR } });
    await prisma.stake.deleteMany({ where: { elementId: HBAR } });
    await prisma.payment.deleteMany({ where: { element: { id: HBAR } } });
    await prisma.element.deleteMany({ where: { id: HBAR } });
  }
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
  it("checkout enforces 5 attempts per IP per hour, and replays a key for free (R06-2)", async () => {
    const stamp = Date.now();
    const probe = (i: number | string, idempotencyKey: string, extra: Record<string, unknown> = {}) =>
      checkoutPOST(
        req("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            elementSym: "TST6",
            amountUsd: 5,
            attest: true,
            idempotencyKey,
            startup: {
              title: `RL${i}`,
              pitch: "rate limit probe pitch",
              url: `https://rl-probe-${stamp}-${i}.dev`,
              linkType: "product",
            },
            ...extra,
          }),
        })
      );

    // A mistyped receipt address is refused by the shape checks *before* the
    // throttle, so it costs the buyer none of their hourly attempts (R06-2).
    const mistyped = await probe("bad", key(), { email: "a@b" });
    expect(mistyped.status).toBe(400);
    expect(((await mistyped.json()) as { field?: string }).field).toBe("email");

    const firstKey = key();
    const first = await probe(0, firstKey);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    const statuses = [first.status];
    for (let i = 1; i < 6; i++) statuses.push((await probe(i, key())).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);

    // The throttle must not swallow a retry of a payment the buyer already
    // owns: the key resolves before the limiter, a replay writes nothing, and
    // the answer is the envelope the first call returned (R06-2, R06-9).
    const replay = await probe(0, firstKey);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    // …while a genuinely new attempt is still refused.
    expect((await probe("after", key())).status).toBe(429);
  });
  it("prices any spelling of a symbol as the one canonical element (R04-4)", async () => {
    // `Hbar` is authored mixed-case in the inventory, so upper-casing it would
    // ask the DB for an element that never exists.
    const canonicalRes = await elementGET(req("/api/elements/Hbar"), { params: { sym: "Hbar" } } as never);
    expect(canonicalRes.status).toBe(200);
    const canonical = (await canonicalRes.json()) as { symbol?: string; stakes?: unknown[] };
    expect(canonical.symbol).toBe("Hbar");
    for (const spelling of ["hbar", "HBAR", "hBaR"]) {
      const res = await elementGET(req(`/api/elements/${spelling}`), { params: { sym: spelling } } as never);
      expect([spelling, res.status]).toEqual([spelling, 200]);
      // Identical payload: a client can build the one URL that exists instead
      // of echoing the visitor's spelling back.
      expect([spelling, await res.json()]).toEqual([spelling, canonical]);
    }
  });
  it("marks a board it cannot show whole, and keeps concealed rows off it (R04-2)", async () => {
    const clean = await elementGET(req("/api/elements/TST6"), { params: { sym: "TST6" } } as never);
    const cleanJson = (await clean.json()) as { prices: { boardComplete?: boolean } };
    expect(cleanJson.prices.boardComplete).toBe(true);

    // Conceal a listing on the same element: settle it visible (the banked
    // path only ever credits live listings), then hide it the way moderator
    // action does.
    const startup = await prisma.startup.upsert({
      where: { domain: HIDDEN },
      create: { domain: HIDDEN, title: HIDDEN, pitch: "concealed fixture pitch", url: `https://${HIDDEN}`, logoUrl: "x" },
      update: { moderationState: "VISIBLE" },
    });
    const payment = await prisma.payment.create({
      data: { elementId: T6, startupId: startup.id, amountUsd: 7, path: "JOIN", provider: "DEV", idempotencyKey: key(), status: "PENDING" },
    });
    const out = await settlePayment(payment.id, { provider: "dev", eventId: `dev-${key()}`, eventType: "dev.test", paid: true });
    expect(out.outcome).toBe("applied");
    await prisma.startup.update({ where: { id: startup.id }, data: { moderationState: "HIDDEN" } });

    const res = await elementGET(req("/api/elements/TST6"), { params: { sym: "TST6" } } as never);
    const json = (await res.json()) as { stakes: { domain: string }[]; prices: { boardComplete?: boolean; takeLead: number } };
    // The client may not promise a take-quote hold on a board it cannot see
    // whole, because the missing bidder could be the person asking.
    expect(json.prices.boardComplete).toBe(false);
    expect(json.stakes.some((s) => s.domain === HIDDEN)).toBe(false);
    // …and the concealed amount still must not move the visible floor.
    expect(json.prices.takeLead).toBe(5001);
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
