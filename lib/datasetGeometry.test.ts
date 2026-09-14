/* Review 03 / R03-1 — one dataset, and a pod that follows it.

   The finding: `Hbar/Ps/Uue/DM` moved to columns 8-11 in `lib/elements.ts`
   when `03d8591` repositioned the pod, but `lib/elements.json` kept 7-10 and
   `doc/ROADMAP.md` kept 7-10 with it. Nothing in the build reads the JSON, so
   the copy could rot forever and any doc reader would learn the wrong layout.
   The duplicate is deleted; the pod box is now derived from the served data;
   these tests hold both halves down. */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { ELEMENTS } from "./elements";
import {
  TILE_WIDTH,
  TILE_HEIGHT,
  GRID_GAP,
  POD_BLEED,
  cellLeft,
  cellTop,
  exoticPodBox,
  cellOf,
  ELEMENT_CELLS,
} from "./gridGeometry";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const EXOTIC_SYMBOLS = ["Hbar", "Ps", "Uue", "DM"];

describe("R03-1 the dataset has one home", () => {
  it("ships no second copy of the table", () => {
    expect(existsSync(join(__dirname, "elements.json"))).toBe(false);
  });

  it("holds all 122 tiles with unique ids, symbols and coordinates", () => {
    expect(ELEMENTS).toHaveLength(122);
    expect(new Set(ELEMENTS.map((e) => e.id)).size).toBe(122);
    expect(new Set(ELEMENTS.map((e) => e.symbol)).size).toBe(122);
    expect(new Set(ELEMENTS.map((e) => `${e.gridRow}-${e.gridCol}`)).size).toBe(122);
    for (const el of ELEMENTS) {
      expect(Number.isInteger(el.gridRow) && el.gridRow >= 1 && el.gridRow <= 10).toBe(true);
      expect(Number.isInteger(el.gridCol) && el.gridCol >= 1 && el.gridCol <= 18).toBe(true);
    }
  });

  it("keeps the four exotics on one contiguous row of the main table", () => {
    const exotics = ELEMENTS.filter((e) => e.tier === "EXOTIC");
    expect(exotics.map((e) => e.symbol)).toEqual(EXOTIC_SYMBOLS);
    // Above the f-block spacer (row 8): rows 9-10 carry extra margin the pod
    // math does not model, so the pod is only drawable in rows 1-7.
    expect(new Set(exotics.map((e) => e.gridRow))).toEqual(new Set([2]));
    expect(exotics.map((e) => e.gridCol)).toEqual([8, 9, 10, 11]);
    expect(exotics.map((e) => e.family)).toEqual(EXOTIC_SYMBOLS.map(() => "EXOTIC_THEORETICAL"));
  });

  it("documents the served columns in the roadmap", () => {
    const roadmap = src("doc/ROADMAP.md");
    expect(roadmap).toMatch(/EXOTIC POD cols 8-11/);
    expect(roadmap).toMatch(/H̄\(-1,c8\) Ps\(0,c9\) Uue\(119,c10\) DM\(999,c11\)/);
    expect(roadmap).not.toMatch(/EXOTIC POD cols 7-10/);
  });

  it("names one seed source in the phase-0 docs", () => {
    expect(src("doc/phase-0-foundation/02-element-seed-data.md")).toMatch(
      /Single source of truth `lib\/elements\.ts` with all 122 nodes/
    );
    expect(src("prisma/seed.ts")).toMatch(/import \{ ELEMENTS \} from "\.\.\/lib\/elements"/);
  });
});

describe("R03-1 the pod box comes from the data", () => {  it("frames every exotic tile with the standard bleed", () => {
    const box = exoticPodBox();
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.left).toBe(cellLeft(8) - POD_BLEED);
    expect(box.top).toBe(cellTop(2) - POD_BLEED);
    expect(box.width).toBe(cellLeft(11) + TILE_WIDTH + POD_BLEED - box.left);
    expect(box.height).toBe(TILE_HEIGHT + 2 * POD_BLEED);
    // Containment, stated for any layout: the frame never crops a tile.
    for (const el of ELEMENTS.filter((e) => e.tier === "EXOTIC")) {
      expect(cellLeft(el.gridCol)).toBeGreaterThanOrEqual(box.left + POD_BLEED);
      expect(cellLeft(el.gridCol) + TILE_WIDTH).toBeLessThanOrEqual(box.left + box.width - POD_BLEED);
    }
  });

  it("moves with the data instead of with a hand-written number", () => {
    const moved = ELEMENTS.map((el) =>
      el.tier === "EXOTIC" ? { ...el, gridCol: el.gridCol + 1 } : el
    );
    const before = exoticPodBox();
    const after = exoticPodBox(moved);
    expect(before && after).toBeTruthy();
    if (!before || !after) return;
    expect(after.left - before.left).toBe(TILE_WIDTH + GRID_GAP);
    expect(after.width).toBe(before.width);
    expect(after.top).toBe(before.top);
  });

  it("refuses to draw a frame it cannot describe", () => {
    const exotics = ELEMENTS.filter((e) => e.tier === "EXOTIC");
    const rest = ELEMENTS.filter((e) => e.tier !== "EXOTIC");
    // No exotics at all.
    expect(exoticPodBox(rest)).toBeNull();
    // Split across two rows.
    const split = exotics.map((el, i) => ({ ...el, gridRow: i < 2 ? 2 : 3 }));
    expect(exoticPodBox([...rest, ...split])).toBeNull();
    // Scattered columns (a gap would draw a frame over unrelated tiles).
    const scattered = exotics.map((el, i) => ({ ...el, gridCol: el.gridCol + i }));
    expect(exoticPodBox([...rest, ...scattered])).toBeNull();
    // Below the f-block spacer, where rows carry extra margin.
    const low = exotics.map((el) => ({ ...el, gridRow: 9 }));
    expect(exoticPodBox([...rest, ...low])).toBeNull();
  });

  it("is the only place the grid gets pod geometry from", () => {
    const grid = src("components/PeriodicGrid.tsx");
    expect(grid).toMatch(/const EXOTIC_POD = exoticPodBox\(\);/);
    expect(grid).toMatch(/import \{ exoticPodBox \} from "\.\.\/lib\/gridGeometry"/);
    // No resurrected hand-numbered box.
    expect(grid).not.toMatch(/EXOTIC_POD = \{/);
    expect(grid).not.toMatch(/7 \* \(TILE_WIDTH \+ GRID_GAP\)/);
    // A missing box must draw nothing rather than crash or drift.
    expect(grid).toMatch(/if \(!EXOTIC_POD\) return null;/);
  });
});

describe("R03-1 the API publishes the geometry the board draws", () => {
  it("answers with the dataset's coordinates for every symbol it serves", () => {
    for (const el of ELEMENTS) {
      expect(cellOf(el.symbol)).toEqual({ gridRow: el.gridRow, gridCol: el.gridCol });
    }
    expect(ELEMENT_CELLS.size).toBe(122);
    expect(cellOf("Zz")).toBeNull();
  });

  it("does not echo the seeded column mirror to clients", () => {
    const route = src("app/api/elements/route.ts");
    expect(route).toMatch(/import \{ cellOf \} from "@\/lib\/gridGeometry"/);
    expect(route).toMatch(/gridRow: cellOf\(e\.symbol\)\?\.gridRow \?\? e\.gridRow,/);
    expect(route).toMatch(/gridCol: cellOf\(e\.symbol\)\?\.gridCol \?\? e\.gridCol,/);
    expect(route).not.toMatch(/^\s+gridRow: e\.gridRow,$/m);
  });
});
