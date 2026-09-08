/* Phase 5 accessibility tests — pure contracts + static markup guarantees.
   DOM interaction (focus trap, roving focus) is verified by browser QA;
   these lock the computable parts: AA contrast ratios, grid-nav math, and
   the structural requirements every overlay/form must keep. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import tailwindConfig from "../tailwind.config";
import { cellMap, stepCell, rowEnd } from "./gridNav";
import { ELEMENTS } from "./elements";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

function luminance(hex: string): number {
  const c = [0, 2, 4].map((i) => {
    const x = parseInt(hex.slice(1 + i, 3 + i), 16) / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe("text contrast meets WCAG 2.2 AA (4.5:1 small text)", () => {
  const colors = tailwindConfig.theme!.extend!.colors as Record<string, string>;
  // Tiles render 6-8px *-ink text directly on family pastel fills
  // (components/Tile.tsx) — every ink must pass on every pastel.
  const FAMILY_PASTELS = [
    "#F8D6B3",
    "#F6E3A1",
    "#B9DDF3",
    "#DCE3EB",
    "#C4DDBC",
    "#F5C6D0",
    "#BDE4DB",
    "#C9B6F5",
    "#F6C2B7",
    "#C8E6BF",
    "#F2F7FC",
  ];
  const pairs: [string, string][] = [
    ["mutedink", "card"],
    ["mutedink", "icy"],
    ["moneyink", "card"],
    ["moneyink", "goldwash"],
    ["liveink", "card"],
    ["ink", "sale"],
  ];
  for (const [fg, bg] of pairs) {
    it(`${fg} on ${bg} ≥ 4.5`, () => {
      expect(ratio(colors[fg], colors[bg])).toBeGreaterThanOrEqual(4.5);
    });
  }
  for (const fg of ["mutedink", "moneyink", "liveink", "ink"]) {
    for (const pastel of FAMILY_PASTELS) {
      it(`${fg} on pastel ${pastel} ≥ 4.5`, () => {
        expect(ratio(colors[fg], pastel)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  it("no small-text class uses the decorative-only base hues", () => {
    // Base muted/money/live hues remain for large display text + decoration;
    // small text must use the *-ink variants. Spot-check high-traffic files.
    for (const f of ["components/Tile.tsx", "components/ActivityCard.tsx", "components/StatsCard.tsx"]) {
      const s = src(f);
      expect(s).not.toMatch(/text-muted[^-i]/);
      expect(s).not.toMatch(/text-money[^-i]/);
    }
  });
});

describe("grid navigation math (P2-08)", () => {
  const map = cellMap(ELEMENTS);
  const at = (r: number, c: number) => map[`${r}-${c}`];
  it("steps along rows, skipping gaps", () => {
    // Row 1: H(1,1) … gap … He(1,18)
    expect(stepCell(map, at(1, 1), 0, 1)?.symbol).toBe("He");
    expect(stepCell(map, at(1, 18), 0, 1)).toBeNull();
    expect(stepCell(map, at(1, 18), 0, -1)?.symbol).toBe("H");
  });
  it("steps vertically and stops at edges", () => {
    const h = at(1, 1);
    expect(stepCell(map, h, 1, 0)?.symbol).toBe("Li");
    expect(stepCell(map, h, -1, 0)).toBeNull();
  });
  it("Home/End hit row ends", () => {
    expect(rowEnd(map, 1, true)?.symbol).toBe("H");
    expect(rowEnd(map, 1, false)?.symbol).toBe("He");
  });
  it("never lands on the row-8 spacer", () => {
    // Column 4 has La-Lu below the spacer; stepping down skips row 8.
    const above = at(7, 4);
    const below = stepCell(map, above, 1, 0);
    expect(below).not.toBeNull();
    expect(below!.gridRow).not.toBe(8);
  });
});

describe("modal contract (static)", () => {
  const modal = src("components/Modal.tsx");
  it("close callback is ref-stable (no focus teardown on rerender)", () => {
    expect(modal).toMatch(/onCloseRef/);
    expect(modal).not.toMatch(/}, \[open, onClose\]\)/);
  });
  it("portals to body and inerts the app background", () => {
    expect(modal).toMatch(/createPortal/);
    expect(modal).toMatch(/setAttribute\("inert"/);
    expect(modal).toMatch(/getElementById\("app-root"\)/);
  });
  it("owns Escape exclusively and traps Tab", () => {
    expect(modal).toMatch(/stopImmediatePropagation/);
    expect(modal).toMatch(/aria-modal/);
  });
});

describe("camera contract (static, P2-11)", () => {
  const cam = src("components/TableCamera.tsx");
  it("yields to overlays, controls, and consumed keys", () => {
    expect(cam).toMatch(/data-modal-open/);
    expect(cam).toMatch(/defaultPrevented/);
    expect(cam).toMatch(/closest/);
  });
  it("forces stillness under reduced motion", () => {
    expect(cam).toMatch(/prefers-reduced-motion/);
  });
});

describe("form + status contracts (static)", () => {
  const modals = src("components/Modals.tsx");
  it("checkout is a semantic form with visible labels and described errors", () => {
    expect(modals).toMatch(/<form/);
    expect(modals).toMatch(/htmlFor="co-url"/);
    expect(modals).toMatch(/htmlFor="co-amount"/);
    expect(modals).toMatch(/aria-describedby/);
    expect(modals).toMatch(/aria-invalid/);
    expect(modals).toMatch(/aria-live="polite"/);
  });
  it("checkout terms are a real link", () => {
    expect(modals).toMatch(/href="\/legal\/rules"/);
  });
  it("toasts announce through a live region", () => {
    expect(src("components/Toast.tsx")).toMatch(/aria-live="polite"/);
    expect(src("components/Toast.tsx")).toMatch(/role="status"/);
  });
  it("legal links exist on mobile (never viewport-gated)", () => {
    const footer = src("components/FooterBar.tsx");
    expect(footer).not.toMatch(/hidden md:block/);
    expect(footer).toMatch(/aria-label="Legal"/);
  });
  it("touch controls reach 44px on coarse pointers", () => {
    expect(src("components/IconBtn.tsx")).toMatch(/pointer:coarse/);
  });
  it("grid exposes one tab stop with documented keys", () => {
    const grid = src("components/PeriodicGrid.tsx");
    expect(grid).toMatch(/role="grid"/);
    expect(grid).toMatch(/tabIndex=\{el\.id === activeId \? 0 : -1\}/);
    expect(grid).toMatch(/chrome-search-toggle/);
  });
});
