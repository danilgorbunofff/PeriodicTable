/* Phase 4 contract tests — pure (no DB): shape guards, board math,
   fetchJson error mapping. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  ApiError,
  fetchJson,
  isReportStatus,
  isStatsResponse,
  isTableOrderRows,
  isBoardRows,
  isActivityRows,
  isSearchHits,
  isElementDetail,
  REPORT_STATUSES,
} from "./api";
import { apiJson, apiRoute, codeForStatus, withContract } from "./route";
import { ChemicalFamily, PrestigeTier, ReportStatus } from "@prisma/client";
import { FAMILY_FILL } from "./familyFill";
import { aggregateEarlyAdopters, aggregateTableOrder, rankByElement, rankCrowns, rankEarlyAdopters } from "./boards";
import { readdirSync, readFileSync } from "fs";
import { join, sep } from "path";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(new URL(url, "http://localhost"), init);

describe("route boundary (R11-3)", () => {
  it("answers an unimplemented method with a JSON 405 that names the allowed ones", async () => {
    const route = apiRoute({ GET: () => apiJson({ ok: true }) });
    const res = await route.POST(req("/api/board", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "Method not allowed. Allowed: GET, HEAD, OPTIONS.", code: "METHOD_NOT_ALLOWED" });
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("answers OPTIONS with the same Allow list and no body", async () => {
    const route = apiRoute({ GET: () => apiJson({}), POST: () => apiJson({}) });
    const res = await route.OPTIONS(req("/api/x", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, POST, OPTIONS");
    expect(await res.text()).toBe("");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("turns an uncaught throw into a correlated JSON 500", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const route = apiRoute({
      GET: () => {
        throw new Error("synthetic explosion");
      },
    });
    const res = await route.GET(req("/api/x"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal error.", code: "INTERNAL" });
    const id = res.headers.get("x-request-id");
    expect(id).toBeTruthy();
    // The log line and the response header must name the same request.
    expect(logged.mock.calls[0]?.join(" ")).toContain(id as string);
    expect(logged.mock.calls[0]?.join(" ")).toContain("synthetic explosion");
  });

  it("reports an unreachable database as 503, not as an internal bug", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const init = apiRoute({
      GET: () => {
        throw Object.assign(new Error("Can't reach database server"), { name: "PrismaClientInitializationError" });
      },
    });
    expect(await (await init.GET(req("/api/x"))).json()).toEqual({ error: "Service unavailable.", code: "DB_UNAVAILABLE" });
    expect((await init.GET(req("/api/x"))).status).toBe(503);

    // Node's errno arrives wrapped in a Prisma error rather than on the root.
    const nested = apiRoute({
      GET: () => {
        throw Object.assign(new Error("wrapper"), { name: "PrismaClientKnownRequestError", cause: { code: "ECONNREFUSED" } });
      },
    });
    expect((await nested.GET(req("/api/x"))).status).toBe(503);
  });

  it("keeps the caller's request id so one id spans caller, log line and response", async () => {
    const route = apiRoute({ GET: () => apiJson({ ok: true }) });
    const res = await route.GET(req("/api/x", { headers: { "x-request-id": "caller-supplied-id" } }));
    expect(res.headers.get("x-request-id")).toBe("caller-supplied-id");
    const failing = withContract(() => NextResponse.json({ error: "Nope." }, { status: 403 }));
    expect((await failing(req("/api/x", { headers: { "x-request-id": "caller-supplied-id" } }))).headers.get("x-request-id")).toBe(
      "caller-supplied-id"
    );
  });

  it("gives a code to a JSON refusal that shipped without one, and keeps its body", async () => {
    const route = apiRoute({ POST: () => NextResponse.json({ error: "Nope." }, { status: 403 }) });
    const res = await route.POST(req("/api/x", { method: "POST" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Nope.", code: "FORBIDDEN" });
  });

  it("fills in a body for an empty refusal and leaves an error page alone", async () => {
    const bare = apiRoute({ GET: () => new Response(null, { status: 429 }) });
    const filled = await bare.GET(req("/api/x"));
    expect(filled.status).toBe(429);
    expect(await filled.json()).toEqual({ error: "Too many requests. Try again later.", code: "RATE_LIMITED" });

    // A proxy/HTML error page is the one body that is not ours to describe.
    const page = apiRoute({ GET: () => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }) });
    const untouched = await page.GET(req("/api/x"));
    expect(untouched.status).toBe(502);
    expect(await untouched.text()).toBe("<html>502</html>");
    expect(untouched.headers.get("x-request-id")).toBeTruthy();
  });

  it("does not touch a 2xx body or add anything to it", async () => {
    const route = apiRoute({ GET: () => apiJson({ ok: true }) });
    // The envelope stays in the header: checkout's idempotent replay is
    // asserted byte-for-byte against the first response (lib/routes.test.ts).
    expect(await (await route.GET(req("/api/x"))).text()).toBe('{"ok":true}');
  });

  it("maps statuses to codes on the way out", () => {
    expect(codeForStatus(404)).toBe("NOT_FOUND");
    expect(codeForStatus(503)).toBe("UNAVAILABLE");
    expect(codeForStatus(599)).toBe("INTERNAL");
    expect(codeForStatus(418)).toBe("BAD_REQUEST");
  });
});

/** Every `app/api/**\/route.ts` as [path relative to app/api, source]. */
function routeSources(): [string, string][] {
  const root = join(__dirname, "..", "app", "api");
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts")
        out.push([full.slice(root.length + 1).split(sep).join("/"), readFileSync(full, "utf8")]);
    }
  };
  walk(root);
  return out;
}

/* The boundary is only worth anything if every route goes through it: one
   file exporting a bare verb handler reopens the 405/request-id split, and one
   file calling `jobAuth` directly reopens the unmetered loop the review
   measured. Both are invisible to the type checker, so they are asserted here. */
describe("route wiring (R11-3, R11-4)", () => {
  const routes = routeSources();

  it("puts every route file behind the shared boundary", () => {
    // 28 at R11-3; +1 for the icon proxy (R16-3); +1 for the operator bulk
    // moderation route (R17-14); +2 for the observability pair (R18-9 health,
    // R18-1 the error sink's write end); +1 for the composite daily run (R20-7).
    // The count is a tripwire, not bookkeeping: a new route file has to be added
    // here on purpose, so it cannot arrive outside the boundary unnoticed.
    expect(routes).toHaveLength(35);
    for (const [path, src] of routes) {
      expect(src, `${path} must use apiRoute`).toContain("apiRoute(");
      expect(src, `${path} must not export a raw verb handler`).not.toMatch(
        /export (async )?function (GET|POST|PUT|PATCH|DELETE|OPTIONS)\b/,
      );
    }
  });

  it("meters every admin and job route, and no route bypasses a gate", () => {
    const gated = routes.filter(([path]) => path.startsWith("admin/") || path.startsWith("jobs/"));
    expect(gated.map(([path]) => path).sort()).toEqual([
      "admin/audit/route.ts",
      "admin/ops/route.ts",
      "admin/outbox/retry/route.ts",
      "admin/reports/[id]/route.ts",
      "admin/reports/route.ts",
      "admin/startups/[domain]/moderate/route.ts",
      "admin/startups/moderate-batch/route.ts",
      "jobs/abandoned-checkouts/route.ts",
      "jobs/config/route.ts",
      "jobs/daily/route.ts",
      "jobs/outbox/route.ts",
      "jobs/reconcile/route.ts",
      "jobs/screenshot/route.ts",
    ]);
    for (const [path, src] of routes) {
      expect(src, `${path} must not call adminAuth() directly`).not.toMatch(/\badminAuth\(/);
      expect(src, `${path} must not call jobAuth() directly`).not.toMatch(/\bjobAuth\(/);
      if (path.startsWith("admin/")) expect(src, `${path} must use adminGate`).toContain("adminGate(");
      if (path.startsWith("jobs/")) expect(src, `${path} must use jobGate`).toContain("jobGate(");
    }
  });
});

describe("wire case for enum-valued fields (R12-7)", () => {
  const elementRoute = routeSources().find(([path]) => path === "elements/route.ts")?.[1] ?? "";

  it("sends uppercase members for the three DB enums, tier included", () => {
    // A Prisma enum field is always presented as its member name, whether or not
    // the column carries an @map — so the member spelling is what reaches the
    // wire. ChemicalFamily and PrestigeTier are unmapped and uppercase; tier is
    // compared as "EXOTIC" in lib/gridGeometry.ts and the family string is a
    // FAMILY_FILL key, so both consumers assume this case and would render blank
    // tiles if it changed.
    expect(Object.values(ChemicalFamily)).toEqual(Object.keys(ChemicalFamily));
    expect(Object.values(PrestigeTier)).toEqual(Object.keys(PrestigeTier));
    expect(PrestigeTier.EXOTIC).toBe("EXOTIC");
    expect(Object.keys(FAMILY_FILL)).toEqual(Object.keys(ChemicalFamily));
  });

  it("passes the element enum fields through untouched", () => {
    expect(elementRoute).toMatch(/\bfamily: e\.family,/);
    expect(elementRoute).toMatch(/\btier: e\.tier,/);
  });

  it("takes the operator report filter in the member spelling, not the column's", () => {
    // ReportStatus is the one enum with an @map: the row on disk says "open"
    // while Prisma and its filters speak "OPEN". The URL parameter follows the
    // member spelling, and ?status=open is a 400 rather than an empty queue —
    // both pinned behaviourally in lib/moderation.test.ts.
    expect(ReportStatus.OPEN).toBe("OPEN");
    expect([...REPORT_STATUSES].sort()).toEqual(Object.keys(ReportStatus).sort());
    for (const value of REPORT_STATUSES) expect(value).toBe(value.toUpperCase());
    expect(isReportStatus("open")).toBe(false);
    expect(isReportStatus("OPEN")).toBe(true);
  });

  it("keeps the plain-String activity kind lowercase, unlike the enums", () => {
    // ActivityLog.kind is a String column with no enum behind it, so nothing in
    // the database says anything about its case: only the writers and the
    // client agreeing do. lib/recompute.ts is the write path that lands both the
    // literal "refund" and each caller's StakeKind ("stake" | "reclaim").
    const recompute = readFileSync(join(process.cwd(), "lib/recompute.ts"), "utf8");
    const refund = /kind: "([a-z_]+)",/.exec(recompute)?.[1];
    expect(refund).toBe("refund");
  });
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
    expect(isStatsResponse({ elementsTotal: 122, claimedElements: 3, unclaimedElements: 119, stakeCount: 5, totalStakedUsd: 100, moneyScope: "board" })).toBe(true);
    // R18-7: the scope label is part of the shape. A money field without one is
    // the ambiguity this fix exists to remove.
    expect(isStatsResponse({ elementsTotal: 122, claimedElements: 3, unclaimedElements: 119, stakeCount: 5, totalStakedUsd: 100 })).toBe(false);
    expect(isStatsResponse({ elementsLive: 122, totalBids: 5, onSale: 3 })).toBe(false);
    expect(isStatsResponse(null)).toBe(false);
  });
  it("search hits require destinations on startup rows", () => {
    expect(
      isSearchHits([{ type: "startup", domain: "a.dev", symbol: "C", elementName: "Carbon", amount: 5, profileUrl: "/s/a.dev", elements: [{ symbol: "C", elementName: "Carbon", amount: 5 }], elementCount: 1 }])
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
  it("accepts an element detail with or without the board-complete flag", () => {
    // Optional by design (R04-2): a payload cached before the flag shipped must
    // still parse, and the client reads anything but `true` as a partial board.
    expect(isElementDetail({ symbol: "C", stakes: [], prices: { takeLead: 21, joinMin: 5, boardComplete: true } })).toBe(true);
    expect(isElementDetail({ symbol: "C", stakes: [], prices: { takeLead: 21, joinMin: 5 } })).toBe(true);
  });
});

describe("aggregateTableOrder (P1-10: ALL stakes summed)", () => {
  it("sums non-leader stakes instead of leaders only", () => {
    const rows = aggregateTableOrder([
      { domain: "big.dev", logoUrl: "l", amountUsd: 50, isLeader: true, elementSymbol: "C", id: "s1", createdAt: new Date("2024-01-01") },
      { domain: "wide.dev", logoUrl: "l", amountUsd: 30, isLeader: false, elementSymbol: "C", id: "s2", createdAt: new Date("2024-01-01") },
      { domain: "wide.dev", logoUrl: "l", amountUsd: 30, isLeader: false, elementSymbol: "Au", id: "s3", createdAt: new Date("2024-01-02") },
    ]);
    expect(rows[0].domain).toBe("wide.dev");
    expect(rows[0].totalSpent).toBe(60);
    expect(rows[0].crowns).toBe(0);
    expect(rows[0].elements).toBe(2);
    expect(rows[0].stakeId).toBe("s2");
    expect(rows[1].domain).toBe("big.dev");
  });
  it("tie-breaks by crowns then domain", () => {
    const rows = aggregateTableOrder([
      { domain: "b.dev", logoUrl: "l", amountUsd: 10, isLeader: false, elementSymbol: "C", id: "1", createdAt: new Date("2024-01-01") },
      { domain: "a.dev", logoUrl: "l", amountUsd: 10, isLeader: false, elementSymbol: "C", id: "2", createdAt: new Date("2024-01-01") },
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

describe("aggregateEarlyAdopters (element must match the row's own date)", () => {
  // logoUrl is startup-scoped, so every claim for a domain carries the same value.
  const logo = "logo.png";

  it("counts one medal per claim and names the EARLIEST claim's element", () => {
    const rows = aggregateEarlyAdopters([
      { domain: "s.dev", logoUrl: logo, elementSymbol: "Au", elementName: "Gold", claimedAt: new Date("2024-01-01") },
      { domain: "s.dev", logoUrl: logo, elementSymbol: "C", elementName: "Carbon", claimedAt: new Date("2024-05-01") },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].medals).toBe(2);
    expect(rows[0].elementSymbol).toBe("Au");
    expect(rows[0].elementName).toBe("Gold");
  });

  it("names the earliest element even when claims arrive NEWEST-FIRST", () => {
    // Regression: the route's findMany had no orderBy, so "first on {element}"
    // could name a later claim's element while firstClaimedAt still pointed at
    // the earliest one — the row contradicted its own date.
    const rows = aggregateEarlyAdopters([
      { domain: "s.dev", logoUrl: logo, elementSymbol: "C", elementName: "Carbon", claimedAt: new Date("2024-05-01") },
      { domain: "s.dev", logoUrl: logo, elementSymbol: "Au", elementName: "Gold", claimedAt: new Date("2024-01-01") },
    ]);
    expect(rows[0].elementSymbol).toBe("Au");
    expect(rows[0].elementName).toBe("Gold");
    expect(rows[0].medals).toBe(2);
  });

  it("composes with rankEarlyAdopters into an order-independent board", () => {
    // Encounter order out of the aggregator is deliberately unsorted; the
    // board's contract is the composition, which must be a total order.
    const claims = [
      { domain: "a.dev", logoUrl: logo, elementSymbol: "H", elementName: "Hydrogen", claimedAt: new Date("2024-02-01") },
      { domain: "b.dev", logoUrl: logo, elementSymbol: "N", elementName: "Nitrogen", claimedAt: new Date("2024-01-01") },
      { domain: "a.dev", logoUrl: logo, elementSymbol: "O", elementName: "Oxygen", claimedAt: new Date("2024-01-15") },
    ];
    const forward = rankEarlyAdopters(aggregateEarlyAdopters(claims));
    const reversed = rankEarlyAdopters(aggregateEarlyAdopters([...claims].reverse()));
    expect(forward).toEqual(reversed);
    expect(forward.find((r) => r.domain === "a.dev")?.elementSym).toBe("O");
  });

  it("breaks identical timestamps by element symbol", () => {
    const at = new Date("2024-01-01");
    const rows = aggregateEarlyAdopters([
      { domain: "s.dev", logoUrl: logo, elementSymbol: "Ne", elementName: "Neon", claimedAt: at },
      { domain: "s.dev", logoUrl: logo, elementSymbol: "Ar", elementName: "Argon", claimedAt: at },
    ]);
    expect(rows[0].elementSymbol).toBe("Ar");
  });
});
