/* Review 03 / R03-3 — one home for the read-cache declaration. Review 15 /
   R15-1 — that declaration's browser window.

   The finding claimed the declared `s-maxage=10` never reached the wire. The
   probe that re-tested it (2026-09-14, production, three requests 2 s apart on
   `/api/elements`) says otherwise: `x-vercel-cache: MISS` then `HIT`, `age:
   0/2/4`, `date` frozen — the edge honours the window and rewrites the
   browser-facing directive to `public, max-age=0, must-revalidate`, which is
   the conservative half, not a lost one. The residue worth testing is that the
   string lived in two route files and nowhere else.

   R15-1 (2026-09-16) revisited the other half: `max-age=0` means a repeat view,
   a remount or a back-navigation always pays a round trip, and the board's own
   pollers re-ask every 30 s anyway. The declaration now carries `max-age=5`,
   and the test below asserts the inequality that makes that safe rather than
   the string itself: the browser window must stay under the shortest interval
   any consumer polls at, so an entry can never outlive the request that would
   have replaced it. The `30_000` here is the client's own literal (`app/page.tsx`
   and the three components that poll these routes), read from the source, so
   changing the poll cadence moves this test with it. */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, sep } from "path";
import { READ_CACHE } from "./route";

const root = join(__dirname, "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");
/** The poll cadence every consumer of READ_CACHE shares (R15-1). */
const POLL_INTERVAL_MS = 30_000;

function apiRoutes(dir = join(root, "app/api"), acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) apiRoutes(full, acc);
    else if (entry.name === "route.ts" || entry.name === "route.tsx") acc.push(full);
  }
  return acc;
}

describe("R03-3 the declared read cache", () => {
  it("promises a short shared window and a shorter browser one", () => {
    expect(READ_CACHE["Cache-Control"]).toBe("public, max-age=5, s-maxage=10, stale-while-revalidate=30");
    expect(READ_CACHE["Vercel-CDN-Cache-Control"]).toBe("s-maxage=10, stale-while-revalidate=30");
  });

  it("keeps the browser window under every consumer's poll interval (R15-1)", () => {
    const declared = Number(/max-age=(\d+)/.exec(READ_CACHE["Cache-Control"])?.[1]);
    expect(declared).toBeGreaterThan(0);
    // Safe because an entry expires long before the next poll would replace it.
    expect(declared * 1000).toBeLessThan(POLL_INTERVAL_MS);
    // And the pollers are the only thing that refreshes the board, so the
    // inequality is only meaningful while that cadence is what they use.
    for (const f of ["app/page.tsx", "components/WorldOrder.tsx", "components/TerritoryView.tsx", "components/ActivityCard.tsx"]) {
      expect(src(f)).toMatch(/refreshInterval:\s*30_?000/);
    }
    // Still no three-digit window hiding in the string: a browser promise long
    // enough to outlive a user's session is the failure this guards.
    expect(READ_CACHE["Cache-Control"]).not.toMatch(/max-age=\d\d\d/);
  });

  it("is the only place in app/api that names Cache-Control", () => {
    // Three deliberate exceptions, none of them a copy of the window above:
    // the icon proxy (R16-3) serves bytes rather than a JSON read and must
    // cache them for a day or it would ask the icon service once per visitor,
    // and the two operator readers (`admin/ops`, `admin/audit`, R18-5/R18-8)
    // answer behind a bearer and say `no-store` out loud rather than trusting
    // a proxy's default. Every public JSON route still goes through READ_CACHE
    // — that is what this asserts, and why the allowed list is spelled out
    // rather than filtered.
    const inlined = apiRoutes().map(rel).filter((f) => src(f).includes("Cache-Control"));
    expect(inlined).toEqual([
      "app/api/admin/audit/route.ts",
      "app/api/admin/ops/route.ts",
      "app/api/favicon/route.ts",
    ]);
  });

  it("keeps the icon proxy's window long, and its fallback short (R16-3)", () => {
    const proxy = src("app/api/favicon/route.ts");
    // A day for a cached icon, minutes for a miss, so a transient upstream
    // failure is retried rather than pinned for a day.
    expect(proxy).toContain('"public, max-age=86400, s-maxage=86400, immutable"');
    expect(proxy).toContain('"public, max-age=600"');
  });

  it("is what the two cacheable read APIs send", () => {
    for (const p of ["app/api/elements/route.ts", "app/api/elements/[sym]/route.ts"]) {
      const route = src(p);
      expect(route).toMatch(/import \{[^}]*READ_CACHE[^}]*\} from "@\/lib\/route"/);
      expect(route).toMatch(/headers: READ_CACHE/);
    }
  });

  it("does not let the element list smuggle a query-dependent cache key", () => {
    // The list is the same for everyone; the detail route keys `?me=` per URL,
    // which is what keeps one visitor's reclaim quote out of another's cache.
    // The list takes no request at all, so nothing query-dependent can reach
    // its cache key; the detail route keys `?me=` per URL. The impl is named
    // rather than exported since R11-3 put every route behind `apiRoute()`.
    expect(src("app/api/elements/route.ts")).toMatch(/async function listElements\(\)/);
    expect(src("app/api/elements/[sym]/route.ts")).toMatch(/searchParams\.get\("me"\)/);
  });

  it("stays out of the paths that must never be cached", () => {
    expect(src("app/go/[stakeId]/route.ts")).toMatch(/"Cache-Control": "no-store"/);
  });
});

function rel(full: string) {
  return full.slice(root.length + 1).split(sep).join("/");
}
