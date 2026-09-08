/* Phase 4 contract tests — pure (no DB): shape guards, board math,
   fetchJson error mapping. */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ApiError,
  fetchJson,
  isStatsResponse,
  isTableOrderRows,
  isBoardRows,
  isActivityRows,
  isSearchHits,
  isElementDetail,
} from "./api";
import { aggregateTableOrder, rankByElement, rankCrowns, rankEarlyAdopters } from "./boards";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJson (P1-07)", () => {
  it("returns parsed JSON on 2xx", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    expect(await fetchJson("/x")).toEqual({ a: 1 });
  });
  it("throws ApiError with the server code on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ error: "Nope.", code: "IDEMPOTENCY_CONFLICT" }), { status: 409 })
    );
    const err = (await fetchJson("/x").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(err.message).toBe("Nope.");
  });
  it("throws BAD_SHAPE when the guard rejects", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ wrong: 1 }), { status: 200 }));
    const err = (await fetchJson("/api/stats", isStatsResponse).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("BAD_SHAPE");
  });
  it("throws on invalid JSON", async () => {
    vi.stubGlobal("fetch", async () => new Response("not json{{", { status: 200 }));
    const err = (await fetchJson("/x").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
  });
});

describe("shape guards", () => {
  it("stats requires all five exact fields", () => {
    expect(isStatsResponse({ elementsTotal: 122, claimedElements: 3, unclaimedElements: 119, stakeCount: 5, totalStakedUsd: 100 })).toBe(true);
    expect(isStatsResponse({ elementsLive: 122, totalBids: 5, onSale: 3 })).toBe(false);
    expect(isStatsResponse(null)).toBe(false);
  });
  it("search hits require destinations on startup rows", () => {
    expect(
      isSearchHits([{ type: "startup", domain: "a.dev", symbol: "C", elementName: "Carbon", amount: 5, profileUrl: "/s/a.dev" }])
    ).toBe(true);
    expect(isSearchHits([{ type: "startup", domain: "a.dev", name: "A" }])).toBe(false);
    expect(isSearchHits([{ type: "element", symbol: "C", elementName: "Carbon" }])).toBe(true);
  });
  it("activity rows require stable ids and delta/total", () => {
    const good = { id: "1", domain: "a.dev", elementSymbol: "C", delta: 2, total: 22, kind: "reclaim", createdAt: "x" };
    expect(isActivityRows([good])).toBe(true);
    expect(isActivityRows([{ domain: "a.dev", elementSymbol: "C", amount: 2 }])).toBe(false);
  });
  it("table-order and board rows validate", () => {
    expect(isTableOrderRows([{ domain: "a", logoUrl: "l", totalSpent: 10, crowns: 1, elements: 2 }])).toBe(true);
    expect(isTableOrderRows([{ domain: "a", total: 10 }])).toBe(false);
    expect(isBoardRows([{ domain: "a", logoUrl: "l", elementSym: "C", elementName: "Carbon", total: 10 }])).toBe(true);
    expect(isElementDetail({ symbol: "C", stakes: [], prices: {} })).toBe(true);
    expect(isElementDetail({ symbol: "C" })).toBe(false);
  });
});

describe("aggregateTableOrder (P1-10: ALL stakes summed)", () => {
  it("sums non-leader stakes instead of leaders only", () => {
    const rows = aggregateTableOrder([
      { domain: "big.dev", logoUrl: "l", amountUsd: 50, isLeader: true, elementSymbol: "C", elementName: "Carbon" },
      { domain: "wide.dev", logoUrl: "l", amountUsd: 30, isLeader: false, elementSymbol: "C", elementName: "Carbon" },
      { domain: "wide.dev", logoUrl: "l", amountUsd: 30, isLeader: false, elementSymbol: "Au", elementName: "Gold" },
    ]);
    expect(rows[0].domain).toBe("wide.dev");
    expect(rows[0].totalSpent).toBe(60);
    expect(rows[0].crowns).toBe(0);
    expect(rows[0].elements).toBe(2);
    expect(rows[1].domain).toBe("big.dev");
  });
  it("tie-breaks by crowns then domain", () => {
    const rows = aggregateTableOrder([
      { domain: "b.dev", logoUrl: "l", amountUsd: 10, isLeader: false, elementSymbol: "C", elementName: "C" },
      { domain: "a.dev", logoUrl: "l", amountUsd: 10, isLeader: false, elementSymbol: "C", elementName: "C" },
    ]);
    expect(rows.map((r) => r.domain)).toEqual(["a.dev", "b.dev"]);
  });
});

describe("rankByElement (biggest single-territory stake)", () => {
  it("ranks leader amounts, not total pools", () => {
    const rows = rankByElement([
      { domain: "pool.dev", logoUrl: "l", amountUsd: 40, elementSymbol: "C", elementName: "Carbon", createdAt: new Date("2024-01-02"), id: "1" },
      { domain: "whale.dev", logoUrl: "l", amountUsd: 88, elementSymbol: "Au", elementName: "Gold", createdAt: new Date("2024-01-01"), id: "2" },
    ]);
    expect(rows[0].domain).toBe("whale.dev");
    expect(rows[0].total).toBe(88);
  });
});

describe("rankCrowns (count then spend)", () => {
  it("orders by crowns, then spend, then domain", () => {
    const rows = rankCrowns([
      { domain: "rich.dev", logoUrl: "l", crowns: 1, totalSpent: 500 },
      { domain: "king.dev", logoUrl: "l", crowns: 3, totalSpent: 30 },
      { domain: "mid.dev", logoUrl: "l", crowns: 3, totalSpent: 20 },
    ]);
    expect(rows.map((r) => r.domain)).toEqual(["king.dev", "mid.dev", "rich.dev"]);
    expect(rows[0].total).toBe(3);
  });
});

describe("rankEarlyAdopters (medals from FirstClaim)", () => {
  it("orders by medals, then earliest claim, then domain", () => {
    const rows = rankEarlyAdopters([
      { domain: "late.dev", logoUrl: "l", medals: 2, firstClaimedAt: new Date("2024-03-01"), elementSymbol: "C", elementName: "Carbon" },
      { domain: "first.dev", logoUrl: "l", medals: 2, firstClaimedAt: new Date("2024-01-01"), elementSymbol: "Au", elementName: "Gold" },
      { domain: "solo.dev", logoUrl: "l", medals: 1, firstClaimedAt: new Date("2023-01-01"), elementSymbol: "H", elementName: "Hydrogen" },
    ]);
    expect(rows.map((r) => r.domain)).toEqual(["first.dev", "late.dev", "solo.dev"]);
    expect(rows[0].total).toBe(2);
  });
});
