import { describe, it, expect } from "vitest";
import { ELEMENTS, findElementBySymbol } from "./elements";

/* Review 04 / R04-4 — one symbol must name one element on every surface.
   The inventory is authored mixed-case, so this cannot be a `.toUpperCase()`. */

describe("findElementBySymbol", () => {
  it("resolves a symbol however the URL spells it", () => {
    expect(findElementBySymbol("Au")?.symbol).toBe("Au");
    expect(findElementBySymbol("au")?.symbol).toBe("Au");
    expect(findElementBySymbol("AU")?.symbol).toBe("Au");
    expect(findElementBySymbol(" au ")?.symbol).toBe("Au");
    expect(findElementBySymbol("a u")).toBeNull();
  });

  it("keeps authored casing that uppercasing would destroy", () => {
    // `Hbar` (the HBAR ticker), `Ps` and `Uue` are real rows, not typos.
    for (const symbol of ["Hbar", "Ps", "Uue", "DM"]) {
      expect(ELEMENTS.some((e) => e.symbol === symbol)).toBe(true);
      expect(findElementBySymbol(symbol)?.symbol).toBe(symbol);
      expect(findElementBySymbol(symbol.toLowerCase())?.symbol).toBe(symbol);
      expect(findElementBySymbol(symbol.toUpperCase())?.symbol).toBe(symbol);
    }
  });

  it("is case-insensitive but not case-mangling", () => {
    expect(findElementBySymbol("hbar")?.name).toBe(findElementBySymbol("Hbar")?.name);
    expect(findElementBySymbol("PS")?.symbol).toBe("Ps");
    expect(findElementBySymbol("ps")).not.toBeNull();
    // Lowercasing a symbol must not find a different element: `ps` is not `P`,
    // `s`-suffixed or otherwise.
    expect(findElementBySymbol("ps")?.symbol).not.toBe("P");
    expect(findElementBySymbol("dm")?.symbol).toBe("DM");
  });

  it("returns null for nothing and for names it does not have", () => {
    expect(findElementBySymbol(null)).toBeNull();
    expect(findElementBySymbol(undefined)).toBeNull();
    expect(findElementBySymbol("")).toBeNull();
    expect(findElementBySymbol("   ")).toBeNull();
    expect(findElementBySymbol("Xx")).toBeNull();
    expect(findElementBySymbol("auu")).toBeNull();
  });

  it("names exactly one element per case-insensitive key", () => {
    const seen = new Map<string, string>();
    for (const el of ELEMENTS) {
      const key = el.symbol.toLowerCase();
      const prior = seen.get(key);
      expect(prior === undefined || prior === el.symbol).toBe(true);
      seen.set(key, el.symbol);
      expect(findElementBySymbol(el.symbol)?.symbol).toBe(el.symbol);
    }
  });
});
