import { describe, expect, it } from "vitest";
import {
  EXOTIC_SYMBOLS,
  EXOTIC_THEMES,
  getExoticTheme,
  isExoticSymbol,
} from "./exoticThemes";

describe("exotic theme registry", () => {
  it("covers every exotic symbol exactly once", () => {
    expect(Object.keys(EXOTIC_THEMES)).toEqual(EXOTIC_SYMBOLS);
    expect(new Set(EXOTIC_SYMBOLS).size).toBe(EXOTIC_SYMBOLS.length);
  });

  it.each(EXOTIC_SYMBOLS)("returns the theme for %s", (symbol) => {
    expect(isExoticSymbol(symbol)).toBe(true);
    expect(getExoticTheme(symbol)).toBe(EXOTIC_THEMES[symbol]);
    expect(EXOTIC_THEMES[symbol].className).toBe(`exotic-tile--${symbol.toLowerCase()}`);
  });

  it("keeps ordinary and unknown symbols out of the exotic path", () => {
    expect(isExoticSymbol("C")).toBe(false);
    expect(isExoticSymbol("")).toBe(false);
    expect(getExoticTheme("C")).toBeUndefined();
    expect(getExoticTheme("H̄")).toBeUndefined();
  });
});
