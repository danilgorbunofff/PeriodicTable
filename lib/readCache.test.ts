/* Review 03 / R03-3 — one home for the read-cache declaration.

   The finding claimed the declared `s-maxage=10` never reached the wire. The
   probe that re-tested it (2026-09-14, production, three requests 2 s apart on
   `/api/elements`) says otherwise: `x-vercel-cache: MISS` then `HIT`, `age:
   0/2/4`, `date` frozen — the edge honours the window and rewrites the
   browser-facing directive to `public, max-age=0, must-revalidate`, which is
   the conservative half, not a lost one. The residue worth testing is that the
   string lived in two route files and nowhere else. */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { READ_CACHE } from "./route";

const root = join(__dirname, "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

function apiRoutes(dir = join(root, "app/api"), acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) apiRoutes(full, acc);
    else if (entry.name === "route.ts" || entry.name === "route.tsx") acc.push(full);
  }
  return acc;
}

describe("R03-3 the declared read cache", () => {
  it("promises a short shared window, never a stale browser copy", () => {
    expect(READ_CACHE["Cache-Control"]).toBe("s-maxage=10, stale-while-revalidate=30");
    expect(READ_CACHE["Vercel-CDN-Cache-Control"]).toBe("s-maxage=10, stale-while-revalidate=30");
    // `s-maxage` is a shared-cache directive; a browser ignores it, so the
    // declaration cannot strand a visitor on a 10 s old board.
    expect(READ_CACHE["Cache-Control"]).not.toMatch(/max-age=\d/);
  });

  it("is the only place in app/api that names Cache-Control", () => {
    const inlined = apiRoutes().filter((f) => src(rel(f)).includes("Cache-Control"));
    expect(inlined.map(rel)).toEqual([]);
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
  return full.slice(root.length + 1);
}
