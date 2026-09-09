export const EXOTIC_SYMBOLS = ["Hbar", "Ps", "Uue", "DM"] as const;

export type ExoticSymbol = (typeof EXOTIC_SYMBOLS)[number];

export type ExoticTheme = {
  className: string;
};

export const EXOTIC_THEMES = {
  Hbar: {
    className: "exotic-tile--hbar",
  },
  Ps: {
    className: "exotic-tile--ps",
  },
  Uue: {
    className: "exotic-tile--uue",
  },
  DM: {
    className: "exotic-tile--dm",
  },
} satisfies Record<ExoticSymbol, ExoticTheme>;

export function isExoticSymbol(symbol: string): symbol is ExoticSymbol {
  return EXOTIC_SYMBOLS.some((candidate) => candidate === symbol);
}

export function getExoticTheme(symbol: string): ExoticTheme | undefined {
  return isExoticSymbol(symbol) ? EXOTIC_THEMES[symbol] : undefined;
}
