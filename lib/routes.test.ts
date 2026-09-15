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
// A second fixture tile for the R09-1 hold tests: it needs a board whose only
// bid sits on the $5 floor, which T6 (with a $5,000 leader) can never be.
const T9 = 9990;
// A symbol the inventory actually authors (`Hbar`, not `HBAR`) is the only way
// to test canonical casing end to end (R04-4).
const HBAR = 9992;
const HIDDEN = "helemprobe.dev";
const DOMAINS = ["ct-a.dev", "ct-b.dev", HIDDEN, "rt-hold-a.dev", "rt-hold-b.dev", "rt-zero-t.dev"];
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
  await prisma.element.upsert({
    where: { id: T9 },
    create: { id: T9, symbol: "TST9", name: "Test Nine", atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
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
  // Holds point at payments, so they go first (R09-1 fixtures).
  await prisma.claimReservation.deleteMany({ where: { elementId: { in: [T6, T9] } } });
  await purgeSettledOutbox(prisma, {
    OR: [{ startup: { domain: { in: DOMAINS } } }, { startup: { domain: { startsWith: "rl-probe-" } } }],
  });
  await prisma.activityLog.deleteMany({ where: { domain: { in: DOMAINS } } });
  await prisma.payment.deleteMany({ where: { startup: { domain: { in: DOMAINS } } } });
  await prisma.auditLog.deleteMany({ where: { startup: { domain: { in: DOMAINS } } } });
  await prisma.firstClaim.deleteMany({ where: { elementId: T6 } });
  await prisma.stake.deleteMany({ where: { elementId: T6 } });
  await prisma.stake.deleteMany({ where: { elementId: T9 } });
  await prisma.firstClaim.deleteMany({ where: { elementId: T9 } });
  if (madeHbar) {
    await prisma.firstClaim.deleteMany({ where: { elementId: HBAR } });
    await prisma.stake.deleteMany({ where: { elementId: HBAR } });
    await prisma.payment.deleteMany({ where: { element: { id: HBAR } } });
    await prisma.element.deleteMany({ where: { id: HBAR } });
  }
  await prisma.payment.deleteMany({ where: { startup: { domain: { startsWith: "rl-probe-" } } } });
  await prisma.element.deleteMany({ where: { id: T6 } });
  await prisma.element.deleteMany({ where: { id: T9 } });
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

  /* R09-1: a live take hold is the fact that decides a bid, and the payload
     has to publish it — the refusal on a floor-priced tile has no amount to
     offer, and the client may not promise a takeover it will not get. */
  const holdProbe = (sym: string, ip: string) => async (amountUsd: number, stamp: string) =>
    checkoutPOST(
      req("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({
          elementSym: sym,
          amountUsd,
          attest: true,
          idempotencyKey: key(),
          startup: {
            title: `RT${stamp}`,
            pitch: "take hold probe pitch",
            url: `https://rl-probe-${stamp}-${key()}.dev`,
            linkType: "product",
          },
        }),
      })
    );

  it("publishes the live hold and closes a floor tile instead of hinting (R09-1)", async () => {
    const owner = await prisma.startup.upsert({
      where: { domain: "rt-hold-a.dev" },
      create: { domain: "rt-hold-a.dev", title: "Hold A", pitch: "hold fixture pitch", url: "https://rt-hold-a.dev", logoUrl: "x" },
      update: {},
    });
    const join = await prisma.payment.create({
      data: { elementId: T9, startupId: owner.id, amountUsd: 5, path: "JOIN", provider: "DEV", idempotencyKey: key(), status: "PENDING" },
    });
    const settled = await settlePayment(join.id, { provider: "dev", eventId: `dev-${key()}`, eventType: "dev.test", paid: true });
    expect(settled.outcome).toBe("applied");

    // The leader owns the quote on a $5 tile, so the hold is minted at $6: $5
    // is the tie and everything above it is the hold.
    const quote = await prisma.payment.create({
      data: { elementId: T9, startupId: owner.id, amountUsd: 6, path: "TAKE", provider: "DEV", idempotencyKey: key(), status: "PENDING" },
    });
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await prisma.claimReservation.create({
      data: { elementId: T9, startupId: owner.id, paymentId: quote.id, quotedLeaderTotal: 5, quotedLeaderStartupId: owner.id, reservedTotal: 6, expiresAt },
    });

    // The board says so before the buyer types: this is what the modal's crown
    // sentence reads (R09-1, R09-6).
    const open = await elementGET(req("/api/elements/TST9"), { params: { sym: "TST9" } } as never);
    const openJson = (await open.json()) as { count: number; stakes: { amount: number }[]; takeHold: { reservedTotal: number; expiresAt: string } | null };
    expect(openJson.takeHold).toEqual({ reservedTotal: 6, expiresAt: expiresAt.toISOString() });
    expect(openJson.count).toBe(openJson.stakes.length);
    expect(openJson.stakes[0]?.amount).toBe(5);

    // The refusal names the hold, and does not offer the amount the tie rule
    // would have hinted at (it does not land either).
    const walled = await holdProbe("TST9", "198.51.100.11")(6, "wall");
    expect(walled.status).toBe(409);
    const walledBody = (await walled.json()) as { code?: string; reservedTotal?: number; expiresAt?: string; joinBlocked?: boolean; joinHint?: number };
    expect(walledBody.code).toBe("RESERVATION_CONFLICT");
    expect(walledBody.reservedTotal).toBe(6);
    expect(walledBody.expiresAt).toBe(expiresAt.toISOString());
    expect(walledBody.joinBlocked).toBe(true);
    expect(walledBody.joinHint).toBeUndefined();

    // When the hold lapses the same $6 is a plain take: the tile was never
    // closed, it was held.
    await prisma.claimReservation.updateMany({ where: { elementId: T9 }, data: { status: "EXPIRED" } });
    const after = await elementGET(req("/api/elements/TST9"), { params: { sym: "TST9" } } as never);
    expect(((await after.json()) as { takeHold: unknown }).takeHold).toBeNull();
    expect((await holdProbe("TST9", "198.51.100.12")(6, "after")).status).toBe(200);
  });

  it("hints an amount that still lands under a hold, and it lands (R09-1)", async () => {
    const owner = await prisma.startup.upsert({
      where: { domain: "rt-hold-b.dev" },
      create: { domain: "rt-hold-b.dev", title: "Hold B", pitch: "hold fixture pitch", url: "https://rt-hold-b.dev", logoUrl: "x" },
      update: {},
    });
    const leader = await prisma.startup.findUniqueOrThrow({ where: { domain: "ct-a.dev" } });
    const quote = await prisma.payment.create({
      data: { elementId: T6, startupId: owner.id, amountUsd: 5001, path: "TAKE", provider: "DEV", idempotencyKey: key(), status: "PENDING" },
    });
    await prisma.claimReservation.create({
      data: {
        elementId: T6,
        startupId: owner.id,
        paymentId: quote.id,
        quotedLeaderTotal: 5000,
        quotedLeaderStartupId: leader.id,
        reservedTotal: 5001,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });

    const post = holdProbe("TST6", "198.51.100.13");
    // Aiming at #1 is exactly what the hold refuses.
    const refused = await post(5001, "aim");
    expect(refused.status).toBe(409);
    const refusedBody = (await refused.json()) as { code?: string; joinHint?: number; joinBlocked?: boolean };
    expect(refusedBody.code).toBe("RESERVATION_CONFLICT");
    expect(refusedBody.joinBlocked).toBeUndefined();
    expect(refusedBody.joinHint).toBe(5);
    // The amount the server just printed is one the server accepts.
    expect((await post(refusedBody.joinHint as number, "hint")).status).toBe(200);
  });

  it("keeps a fully reversed row off the board it can no longer lead (R09-4)", async () => {
    const ghost = await prisma.startup.upsert({
      where: { domain: "rt-zero-t.dev" },
      create: { domain: "rt-zero-t.dev", title: "Zero", pitch: "zero fixture pitch", url: "https://rt-zero-t.dev", logoUrl: "x" },
      update: {},
    });
    // What an unwind leaves behind: the row survives for click history and the
    // first claim, with nothing left on it.
    await prisma.stake.create({ data: { elementId: T6, startupId: ghost.id, amountUsd: 0, rank: 50, isLeader: false } });

    const res = await elementGET(req("/api/elements/TST6"), { params: { sym: "TST6" } } as never);
    const json = (await res.json()) as { count: number; pool: number; stakes: { domain: string; amount: number; rank: number }[]; prices: { takeLead: number } };
    expect(json.stakes.some((s) => s.domain === "rt-zero-t.dev")).toBe(false);
    expect(json.stakes.every((s) => s.amount > 0)).toBe(true);
    // Ranks are re-derived from the listed rows, so nothing is skipped.
    expect(json.stakes.map((s) => s.rank)).toEqual(json.stakes.map((_, i) => i + 1));
    // The count the tile prints is the count it lists; pool keeps counting all
    // money (a reversed row contributes nothing anyway).
    expect(json.count).toBe(json.stakes.length);
    const el = await prisma.element.findUniqueOrThrow({ where: { id: T6 } });
    expect(json.pool).toBe(el.totalPoolUsd);
    // A $0 row must not price the lead either: the floor is still $5, not $1.
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
