export const EXOTIC_SYMBOLS = ["Hbar", "Ps", "Uue", "DM"] as const;

export type ExoticSymbol = (typeof EXOTIC_SYMBOLS)[number];

export type ExoticTheme = {
  className: string;
  concept: string;
  glyphLabel: string;
};

export const EXOTIC_THEMES = {
  Hbar: {
    className: "exotic-tile--hbar",
    concept: "matter-antimatter containment",
    glyphLabel: "Antimatter atom",
  },
  Ps: {
    className: "exotic-tile--ps",
    concept: "paired particle state",
    glyphLabel: "Paired particles",
  },
  Uue: {
    className: "exotic-tile--uue",
    concept: "superheavy frontier nucleus",
    glyphLabel: "Superheavy nucleus",
  },
  DM: {
    className: "exotic-tile--dm",
    concept: "gravitational lens",
    glyphLabel: "Dark matter lens",
  },
} satisfies Record<ExoticSymbol, ExoticTheme>;

export function isExoticSymbol(symbol: string): symbol is ExoticSymbol {
  return EXOTIC_SYMBOLS.some((candidate) => candidate === symbol);
}

export function getExoticTheme(symbol: string): ExoticTheme | undefined {
  return isExoticSymbol(symbol) ? EXOTIC_THEMES[symbol] : undefined;
}
