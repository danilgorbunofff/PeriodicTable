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
import { GET as faviconGET } from "../app/api/favicon/route";
import { settlePayment } from "./settle";
import { audit } from "./audit";
import { ATTEST_VERSION, CONSENT_TEXT_HASH } from "./consent";
import { faviconFor, upstreamFaviconUrl } from "./screenshots";
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
// R16-3: the icon proxy only serves a domain that is on the table, so this
// fixture is a listing and nothing else.
const LISTING = "rt-listing.dev";
const DOMAINS = ["ct-a.dev", "ct-b.dev", HIDDEN, "rt-hold-a.dev", "rt-hold-b.dev", "rt-zero-t.dev", "rt-r16-a.dev", LISTING, "instagram.com/rt-social-probe"];
// A different buyer IP: the checkout throttle is per client per hour, and the
// rate-limit fixture above spends a full bucket of its own.
const IP16 = "203.0.113.16";
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
  await prisma.startup.upsert({
    where: { domain: LISTING },
    create: { domain: LISTING, title: "Rt Listing", pitch: "route fixture pitch", url: `https://${LISTING}`, logoUrl: faviconFor(LISTING) },
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
  it("does not cap new attempts per IP, and replays a key for free (R06-2)", async () => {
    const stamp = Date.now();
    const probe = (i: number | string, idempotencyKey: string, extra: Record<string, unknown> = {}) =>
      checkoutPOST(
        req("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            elementSym: "TST6",
            // TST6's leader holds 5,000, so a newcomer's floor is the takeover
            // price (lib/pricing.ts).
            amountUsd: 5001,
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

    // A mistyped receipt address is still refused by the pure shape checks.
    const mistyped = await probe("bad", key(), { email: "a@b" });
    expect(mistyped.status).toBe(400);
    expect(((await mistyped.json()) as { field?: string }).field).toBe("email");

    const firstKey = key();
    const first = await probe(0, firstKey);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    // The per-IP cap was removed (2026-09-28): many NEW attempts in a row all
    // pass. Abuse control is the $5 floor, Turnstile and the payment gate.
    const statuses = [first.status];
    for (let i = 1; i < 8; i++) statuses.push((await probe(i, key())).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200]);

    // A retry of a payment the buyer already owns still replays: the key
    // resolves first and the answer is the envelope the first call returned
    // (R06-2, R06-9).
    const replay = await probe(0, firstKey);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
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

  /* The takeover floor (and the absence of holds): a newcomer on a claimed
     element cannot buy in below #1 + $1, and nothing refuses a second bidder
     who quotes the same price — the race is decided at settlement. */
  const probe = (sym: string, ip: string) => async (amountUsd: number, stamp: string) =>
    checkoutPOST(
      req("/api/checkout", {
        method: "POST",
        // `cf-ray` is the proof that `cf-connecting-ip` was written by the edge
        // and not by the caller (R14-2): without it the hop is ignored and every
        // probe here would share the header-less `0.0.0.0` bucket.
        headers: { "Content-Type": "application/json", "cf-connecting-ip": ip, "cf-ray": `${ip}-probe` },
        body: JSON.stringify({
          elementSym: sym,
          amountUsd,
          attest: true,
          idempotencyKey: key(),
          startup: {
            title: `RT${stamp}`,
            pitch: "takeover probe pitch",
            url: `https://rl-probe-${stamp}-${key()}.dev`,
            linkType: "product",
          },
        }),
      })
    );

  it("refuses a newcomer below the takeover price and names the price that works (R04-3)", async () => {
    const owner = await prisma.startup.upsert({
      where: { domain: "rt-hold-a.dev" },
      create: { domain: "rt-hold-a.dev", title: "Hold A", pitch: "hold fixture pitch", url: "https://rt-hold-a.dev", logoUrl: "x" },
      update: {},
    });
    const join = await prisma.payment.create({
      data: { elementId: T9, startupId: owner.id, amountUsd: 5, path: "JOIN", provider: "DEV", idempotencyKey: key(), status: "PENDING" },
    });
    expect((await settlePayment(join.id, { provider: "dev", eventId: `dev-${key()}`, eventType: "dev.test", paid: true })).outcome).toBe("applied");

    // The tile is claimed at $5, so a newcomer's floor is $6 — not the $5 that
    // used to join below the leader.
    const post = probe("TST9", "198.51.100.11");
    const refused = await post(5, "low");
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { code?: string; error?: string; takeLead?: number };
    expect(body.code).toBe("BELOW_FLOOR");
    expect(body.error).toContain("$6");
    expect(body.takeLead).toBe(6);
    // The amount the refusal named is one the server accepts.
    expect((await post(6, "ok")).status).toBe(200);
  });

  it("accepts two equal takes at the same moment — no hold refuses the second (R09-1 removed)", async () => {
    const post = probe("TST6", "198.51.100.13");
    // Both newcomers quote the same takeover price ($5,000 leader + $1). Both
    // are accepted; the ledger's tie order decides #1 at settlement.
    expect((await post(5001, "race-a")).status).toBe(200);
    expect((await post(5001, "race-b")).status).toBe(200);
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
  it("clamps the activity limit at both ends (R11-2)", async () => {
    // Prisma reads `take: -1` as "one row, from the end of the set", so
    // `?limit=-1` answered with a single oldest event instead of a page: a
    // silently wrong feed rather than a bounded one. Junk still means six.
    const negative = (await (await activityGET(req("/api/activity?limit=-1"))).json()) as unknown;
    expect(isActivityRows(negative)).toBe(true);
    if (!isActivityRows(negative)) return;
    expect(negative.length).toBe(1);

    const huge = (await (await activityGET(req("/api/activity?limit=1000000"))).json()) as unknown;
    expect(isActivityRows(huge)).toBe(true);
    if (!isActivityRows(huge)) return;
    expect(huge.length).toBeGreaterThan(0);
    expect(huge.length).toBeLessThanOrEqual(20);

    const junk = (await (await activityGET(req("/api/activity?limit=abc"))).json()) as unknown;
    expect(isActivityRows(junk)).toBe(true);
    if (!isActivityRows(junk)) return;
    expect(junk.length).toBeGreaterThan(0);
    expect(junk.length).toBeLessThanOrEqual(6);

    const two = (await (await activityGET(req("/api/activity?limit=2"))).json()) as unknown;
    expect(isActivityRows(two)).toBe(true);
    if (!isActivityRows(two)) return;
    expect(two.length).toBe(2); // in-range values are still honoured exactly
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
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(audit(bad)).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Phase 16's two promises that only a real database can prove: the consent
 * record that backs the checkbox (R16-6/R16-7) and the icon proxy that keeps
 * the browser away from a third party (R16-3).
 */
describe.skipIf(!hasDb)("phase 16: consent and the icon proxy", () => {
  const post16 = (body: Record<string, unknown>, idempotencyKey: string = key(), ip: string = IP16) =>
    checkoutPOST(
      req("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({
          elementSym: "TST6",
          // TST6's leader holds 5,000: a newcomer must clear the takeover price.
          amountUsd: 5001,
          idempotencyKey,
          startup: { title: "R16", pitch: "consent probe pitch", url: "https://rt-r16-a.dev", linkType: "product" },
          ...body,
        }),
      })
    );

  it("refuses a checkout that attests to wording the product no longer serves (R16-7)", async () => {
    // A tab left open across a rules change would otherwise attest to words it
    // never displayed, and the stored record would be a lie about what the
    // payer read. The refusal is a 409 with a code, so a client can tell
    // "reload" apart from "you forgot to tick the box". The stamp stays
    // invisible: nothing on the site prints a version for a reader to compare,
    // so the only place a stale tab meets it is here.
    const stale = await post16({ attest: true, consentVersion: "1999-01-01" });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as { code?: string; field?: string; error?: string };
    expect(staleBody.code).toBe("RULES_UPDATED");
    expect(staleBody.field).toBe("attest");
    expect(staleBody.error).toMatch(/Rules/);

    // Junk does not match either — a client that sends an object cannot be
    // assumed to have shown the page.
    const junk = await post16({ attest: true, consentVersion: { major: 1 } });
    expect(junk.status).toBe(409);
    expect(((await junk.json()) as { code?: string }).code).toBe("RULES_UPDATED");

    // Both refusals happen before anything is written: no listing, no payment.
    expect(await prisma.startup.findUnique({ where: { domain: "rt-r16-a.dev" } })).toBeNull();
    expect(await prisma.payment.count({ where: { startup: { domain: "rt-r16-a.dev" } } })).toBe(0);

    // The stamp in force is accepted, and the row is not merely a yes/no: it
    // carries the day, the hash of the words, and the clock — the internal
    // record of what was agreed to, which no page displays.
    const stampedKey = key();
    const ok = await post16({ attest: true, consentVersion: ATTEST_VERSION }, stampedKey);
    expect(ok.status).toBe(200);
    const stamped = await prisma.payment.findFirstOrThrow({ where: { idempotencyKey: stampedKey } });
    expect(stamped.consentVersion).toBe(ATTEST_VERSION);
    expect(stamped.consentTextHash).toBe(CONSENT_TEXT_HASH);
    expect(stamped.consentAt).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - (stamped.consentAt as Date).getTime())).toBeLessThan(120_000);

    // A client older than the field still checks out — refusing it would break
    // a page mid-deploy — and is recorded under the stamp in force, because
    // that is what the server is serving right now.
    const bareKey = key();
    expect((await post16({ attest: true }, bareKey)).status).toBe(200);
    const bare = await prisma.payment.findFirstOrThrow({ where: { idempotencyKey: bareKey } });
    expect(bare.consentVersion).toBe(ATTEST_VERSION);
    expect(bare.consentTextHash).toBe(CONSENT_TEXT_HASH);
  });

  it("serves listing icons through our own server and degrades to a local picture (R16-3)", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    // A fresh Response per call: a body can be read once, and this test now
    // serves two listings (a product host and a social host).
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(png, { headers: { "content-type": "image/png" } }));
    try {
      const ok = await faviconGET(req(`/api/favicon?domain=${LISTING}&sz=64`));
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/png");
      expect(ok.headers.get("cache-control")).toContain("immutable");
      expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
      // The one place the icon service is named is this server-side call.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toBe(upstreamFaviconUrl(LISTING, 64));

      spy.mockClear();
      // A social listing's identity is host + account path. The host's icon is
      // served for it — the identity itself would be refused by the host guard.
      const SOCIAL = "instagram.com/rt-social-probe";
      await prisma.startup.upsert({
        where: { domain: SOCIAL },
        create: { domain: SOCIAL, title: "Rt Social", pitch: "social fixture pitch", url: `https://${SOCIAL}`, linkType: "social", logoUrl: faviconFor(SOCIAL) },
        update: {},
      });
      const social = await faviconGET(req("/api/favicon?domain=instagram.com&sz=64"));
      expect(social.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toBe(upstreamFaviconUrl("instagram.com", 64));
      // The hostile neighbour of that host is still refused: the prefix match
      // requires the account path, not a lookalike domain.
      spy.mockClear();
      const lookalike = await faviconGET(req("/api/favicon?domain=instagram.com.evil.dev&sz=64"));
      expect(lookalike.status).toBe(404);
      expect(spy.mock.calls.length).toBe(0);

      spy.mockClear();
      // No icon → 404, so the caller's own fallback draws (Avatar's initial
      // chip). The route used to 302 every iconless listing at the Wikipedia
      // globe, which read as Wikimedia branding.
      const noIcon = async (query: string, label: string) => {
        const res = await faviconGET(req(`/api/favicon?${query}`));
        expect([label, res.status]).toEqual([label, 404]);
        expect([label, res.headers.get("location")]).toEqual([label, null]);
        expect([label, res.headers.get("cache-control")]).toEqual([label, "public, max-age=600"]);
        // Every refusal answers locally: no upstream call at all.
        expect([label, spy.mock.calls.length]).toEqual([label, 0]);
      };
      await noIcon("domain=not-a-listing-r16.dev&sz=64", "unlisted domain");
      await noIcon(`domain=${LISTING}&sz=999`, "disallowed size");
      await noIcon("domain=&sz=64", "missing domain");

      // A live domain whose icon is not an image, or is missing, is also a 404
      // — briefly cached, so a transient upstream failure is retried soon.
      const degraded = async (response: Response | Error, label: string) => {
        spy.mockClear();
        if (response instanceof Error) spy.mockRejectedValue(response);
        else spy.mockResolvedValue(response);
        const res = await faviconGET(req(`/api/favicon?domain=${LISTING}&sz=32`));
        expect([label, res.status]).toEqual([label, 404]);
        expect([label, res.headers.get("cache-control")]).toEqual([label, "public, max-age=600"]);
      };
      await degraded(new Response("<html>not an icon</html>", { headers: { "content-type": "text/html" } }), "html response");
      await degraded(new Response(null, { status: 500 }), "upstream error");
      await degraded(new Response(new Uint8Array(0), { headers: { "content-type": "image/png" } }), "empty image");
      await degraded(new DOMException("timed out", "TimeoutError"), "timeout");
    } finally {
      spy.mockRestore();
    }
  });

  it("never hands the browser an upstream icon URL (R16-3)", () => {
    // What pages embed is a relative path of ours, for every size, so a stored
    // legacy `logoUrl` is rewritten at render time and CSP can stay `img-src
    // 'self' data:`.
    for (const size of [20, 24, 32, 48, 64, 128]) {
      const src = faviconFor("ct-a.dev", size);
      expect(src).toBe(`/api/favicon?domain=ct-a.dev&sz=${size}`);
      expect(src.startsWith("/")).toBe(true);
      expect(src).not.toMatch(/^https?:/);
    }
    // A domain is data, never a way to add query parameters of one's own.
    expect(faviconFor("ct-a.dev&sz=1")).toBe("/api/favicon?domain=ct-a.dev%26sz%3D1&sz=64");
  });
});
