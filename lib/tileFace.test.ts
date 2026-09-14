/* R02-4: what a tile may say before the board has answered.

   The pre-hydration document — the one a crawler or a JS-less visitor reads —
   used to price all 122 elements: `He Helium · Unclaimed · $5` in the title, the
   tooltip and the face. That is an inventory claim with nothing behind it, and
   `$5` is not a neutral fallback: it is a specific offer.

   The truth table is the fix, so it is what this file tests, plus the source
   pins that stop the literal from creeping back into the component. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { FLOOR_PRICE, tileFace } from "./tileFace";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
/** Source minus comments: these pins are about what the component does, not
 *  about what its comments admit the component used to do. */
const code = (p: string) =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const HE = { symbol: "He", name: "Helium" };

describe("tileFace before the board answers (R02-4)", () => {
  it("states no price, for a tile with and without a claim", () => {
    for (const claim of [undefined, { price: 12 }]) {
      const face = tileFace(HE, claim, false);
      expect(face.priced).toBe(false);
      expect(face.claimed).toBe(false);
      expect(face.priceText).toBeNull();
      expect(face.ariaLabelSuffix).toBe("");
    }
  });

  it("still identifies the element — the tile is not blank, it is unpriced", () => {
    const face = tileFace(HE, undefined, false);
    expect(face.title).toBe("He Helium");
  });

  it("never mentions money, a claim, or a floor while unpriced", () => {
    for (const claim of [undefined, { price: 12 }]) {
      const face = tileFace(HE, claim, false);
      const spoken = `${face.title}${face.ariaLabelSuffix}`;
      expect(spoken).not.toMatch(/\$|unclaimed|claim|price/i);
    }
  });
});

describe("tileFace once the board has answered", () => {
  it("prices an unclaimed element at the advertised floor", () => {
    const face = tileFace(HE, undefined, true);
    expect(face).toEqual({
      priced: true,
      claimed: false,
      title: `He Helium · Unclaimed · $${FLOOR_PRICE}`,
      ariaLabelSuffix: ", unclaimed",
      priceText: `$${FLOOR_PRICE}`,
    });
  });

  it("punctuates a claimed element differently from a link's own text", () => {
    // The suffix is appended to "{symbol} {name}", so it has to open with a comma.
    const face = tileFace(HE, { price: 7 }, true);
    expect(face.claimed).toBe(true);
    expect(face.title).toBe("He Helium · #1 $7");
    expect(face.ariaLabelSuffix).toBe(", claimed, leader pays $7");
    expect(face.priceText).toBe("$7");
    expect(face.ariaLabelSuffix.startsWith(",")).toBe(true);
  });

  it("keeps the floor for a claim that carries no price", () => {
    // A zero price cannot come from the pricing rules, and "$0" would advertise
    // a free element — so the floor is drawn instead of the bad value.
    expect(tileFace(HE, { price: 0 }, true).priceText).toBe(`$${FLOOR_PRICE}`);
  });
});

describe("the price lives in one module (R02-4)", () => {
  it("Tile.tsx keeps no price of its own", () => {
    const s = code("components/Tile.tsx");
    expect(s).toMatch(/tileFace\(el, claim, pricesKnown\)/);
    expect(s).not.toMatch(/\$\d/); // no literal $5/$7 in the component
    expect(s).not.toMatch(/Unclaimed/);
    expect(s).not.toMatch(/\?\?\s*\d/); // no numeric default, whatever its value
  });

  it("reserves the price's box even when there is no price", () => {
    // Otherwise every tile resizes the moment the live prices land.
    const s = code("components/Tile.tsx");
    expect(s).toMatch(/face\.priced && claim\?\.logoUrl/);
    expect(s).toMatch(/face\.priceText \?/);
  });

  it("passes the flag down and gates it on the table having answered", () => {
    expect(src("components/PeriodicGrid.tsx")).toMatch(/pricesKnown=\{pricesKnown\}/);
    expect(src("components/Tile.tsx")).toMatch(/pricesKnown = false/);
    // The page may price the board only for ok/stale; the unavailable branch
    // replaces the grid with a notice instead.
    expect(src("app/page.tsx")).toMatch(/pricesKnown=\{tileState/);
  });
});
