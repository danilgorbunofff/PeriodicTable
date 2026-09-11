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
import { FAMILY_FILL } from "./familyFill";

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
  // (components/Tile.tsx) — every ink must pass on every pastel. Imported
  // dynamically so the test can never drift from the real fills.
  const FAMILY_PASTELS = Object.values(FAMILY_FILL) as string[];
  // Medal podium surfaces (rank washes, deepened hovers, badge fills) host
  // small ink text in TerritoryView / BoardPreview / WorldOrder rows.
  const PODIUM_SURFACES = [
    "goldwash",
    "silverwash",
    "bronzewash",
    "golddeep",
    "silverdeep",
    "bronzedeep",
    "medalgold",
    "medalsilver",
    "medalbronze",
  ];
  const pairs: [string, string][] = [
    ["mutedink", "cardbg"],
    ["mutedink", "icy"],
    ["moneyink", "cardbg"],
    ["moneyink", "goldwash"],
    ["liveink", "cardbg"],
    ["ink", "sale"],
  ];
  for (const [fg, bg] of pairs) {
    it(`${fg} on ${bg} ≥ 4.5`, () => {
      expect(ratio(colors[fg], colors[bg])).toBeGreaterThanOrEqual(4.5);
    });
  }
  // Small text on family pastels is always plain `ink` (Tile.tsx: hue inks
  // are reserved for white/icy/wash surfaces, where they all pass).
  for (const pastel of FAMILY_PASTELS) {
    it(`ink on pastel ${pastel} ≥ 4.5`, () => {
      expect(ratio(colors.ink, pastel)).toBeGreaterThanOrEqual(4.5);
    });
  }
  for (const fg of ["mutedink", "moneyink", "liveink", "ink"]) {
    for (const surface of PODIUM_SURFACES) {
      it(`${fg} on ${surface} ≥ 4.5`, () => {
        expect(ratio(colors[fg], colors[surface])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  // Claimed-exotic tile faces: dark gradients host WHITE small text (DM,
  // Uue) and ink small text on the lighter stops (Ps mid cyan/magenta).
// Claimed-exotic tile faces come from the themed system
// (app/globals.css .exotic-tile--{hbar,ps,uue,dm} --exotic-bg-start/end).
// All four faces are dark and render near-white --exotic-ink text plus a
// dark text-shadow, so assert white text on each gradient stop.
  const EXOTIC_FACES = {
    hbar: { hex: "#8f3209", text: "#FFFFFF" },
    hbarEnd: { hex: "#321746", text: "#FFFFFF" },
    ps: { hex: "#126b8b", text: "#FFFFFF" },
    psEnd: { hex: "#7b287f", text: "#FFFFFF" },
    uue: { hex: "#542399", text: "#FFFFFF" },
    uueEnd: { hex: "#22115f", text: "#FFFFFF" },
    dm: { hex: "#172448", text: "#FFFFFF" },
    dmEnd: { hex: "#050714", text: "#FFFFFF" },
  } as const;
  for (const [name, { hex, text }] of Object.entries(EXOTIC_FACES)) {
    it(`${text} on exotic face ${name} ≥ 4.5`, () => {
      expect(ratio(text, hex)).toBeGreaterThanOrEqual(4.5);
    });
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
  it("the small wordmark pill (.lol) uses the AA-safe money ink", () => {
    // The /s/[domain] pill is text-sm font-bold: 14px is *normal* text, so it
    // needs 4.5:1, and the decorative `money` hue only manages 3.25:1 on white.
    const domain = src("app/s/[domain]/page.tsx");
    expect(ratio(colors.money, "#FFFFFF")).toBeLessThan(4.5);
    expect(ratio(colors.moneyink, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(domain).toMatch(/periodictable<span className="text-moneyink">\.lol/);
    expect(domain).not.toMatch(/text-money[^-i]/);
    // The homepage pill is text-[22px] font-bold — large text, 3:1 floor — so
    // it may keep the display hue, but only for as long as it stays that large.
    expect(src("app/page.tsx")).toMatch(
      /text-\[22px\] font-bold shadow-float[\s\S]{0,400}?periodictable<span className="text-money">\.lol/
    );
    expect(ratio(colors.money, "#FFFFFF")).toBeGreaterThanOrEqual(3);
  });
  it("the dev pay simulator keeps its muted text at AA", () => {
    // Inline-styled (no Tailwind tokens), so the class-based guard above misses
    // it: the light grey #999 is only 2.84:1 on the card's #fff at 12px.
    const pay = src("app/pay/[paymentId]/page.tsx");
    expect(ratio("#999999", "#FFFFFF")).toBeLessThan(4.5);
    expect(ratio("#666666", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(pay).not.toMatch(/(?<![-a-zA-Z])color:\s*"#[89abAB][0-9a-fA-F]{2}"/);
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
  it("the report button's name follows its visible text and the result is announced", () => {
    const report = src("components/ReportListingButton.tsx");
    // A static aria-label would override "reported ✓" / "failed — retry?", so
    // AT would announce the wrong state and voice control could not match the
    // name it can see (WCAG 2.5.3). The visible text is the name instead.
    expect(report).not.toMatch(/aria-label=/);
    expect(report).toMatch(/role="status"/);
    expect(report).toMatch(/aria-live="polite"/);
    // send() closes the modal and flips pending in the same render, so a real
    // `disabled` would make Modal's focus-restore miss and drop focus to
    // <body>. aria-disabled plus the click guard keeps that impossible.
    expect(report).not.toMatch(/(?<!aria-)disabled=\{/);
    expect(report).toMatch(/aria-disabled=\{pending\}/);
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
  it("exotic tiles share the standard tile structure with ambient coloring only", () => {
    const tile = src("components/Tile.tsx");
    expect(tile).toMatch(/aria-label=\{`\$\{el\.symbol\}/);
    expect(tile).not.toMatch(/ExoticGlyph/);
    expect(tile).not.toMatch(/EXOTIC_STYLES/);
    expect(tile).not.toMatch(/exotic-tile__/);
    expect(tile).toMatch(/exotic-tile/);
    expect(tile).toMatch(/onError=/);
  });
  it("exotic ambient sheen has a static reduced-motion state", () => {
    const css = src("app/globals.css");
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    expect(css).toMatch(/\.exotic-tile::before/);
    expect(css).toMatch(/animation: none !important/);
  });
});
