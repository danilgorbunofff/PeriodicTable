/**
 * What an OG card says and how big it may be (R01-2, R01-8, U01-3) — pure, so
 * the PNG renderer (lib/ogCardImage.tsx) and the static SVG fallback agree.
 *
 * The SVG branch is markup, so every value taken from the database goes through
 * escapeXml() before interpolation (R01-8): the card's safety must not depend on
 * lib/validate.ts having rejected every hostile domain before storage.
 */
import { MIN_STAKE } from "./pricing";

export const OG_CARD = { width: 1200, height: 630 } as const;
export const OG_SITE = "periodictable.lol";
/** Text column: 1200 − 80 (pad) − 220 (tile) − 60 (gap) − 80 (pad). */
export const OG_TEXT_WIDTH = 760;
/** Longest domain drawn on the card, ellipsis included (U01-3). */
export const OG_DOMAIN_MAX = 24;

/** Escapes the five XML metacharacters, in entity-safe order. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** U01-3: a long domain was the one unbounded value on the card's leader line. */
export function clampDomain(domain: string, max = OG_DOMAIN_MAX): string {
  const d = domain.trim();
  if (d.length <= max) return d;
  return `${d.slice(0, Math.max(1, max - 1))}…`;
}

/** Largest font size whose text still fits the text column, measured at ~0.55em
 *  per character for the card's sans — a long domain shrinks instead of
 *  spilling across the tile. */
export function headlineFontSize(headline: string, width = OG_TEXT_WIDTH): number {
  for (const size of [56, 46, 38, 30]) {
    if (headline.length * size * 0.55 <= width) return size;
  }
  return 26;
}

export type OgCardLeader = { domain: string; amountUsd: number };
export type OgCard = { symbol: string; name: string; headline: string };

/**
 * `unavailable` marks a card drawn without a database read: the card then says
 * the standings are unavailable rather than claiming an element nobody verified
 * is unclaimed — the same rule lib/liveState.ts enforces on the board (R02-4).
 */
export function ogCard(input: {
  symbol: string;
  name: string;
  leader?: OgCardLeader | null;
  unavailable?: boolean;
}): OgCard {
  const headline =
    input.leader && !input.unavailable
      ? `#1 ${clampDomain(input.leader.domain)} $${input.leader.amountUsd}`
      : input.unavailable
        ? "Live standings unavailable"
        : `Unclaimed · from $${MIN_STAKE}`;
  return { symbol: input.symbol, name: input.name, headline };
}

/** Static SVG rendering of the same card — the fallback when the PNG renderer
 *  fails (R01-2). Interpolated values are escaped first (R01-8). */
export function renderOgCardSvg(card: OgCard): string {
  const symbol = escapeXml(card.symbol);
  const name = escapeXml(card.name);
  const headline = escapeXml(card.headline);
  const size = headlineFontSize(card.headline);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_CARD.width}" height="${OG_CARD.height}"><rect width="${OG_CARD.width}" height="${OG_CARD.height}" fill="#05070A"/><rect x="80" y="120" width="220" height="240" rx="24" fill="#fff"/><text x="190" y="220" font-family="Arial" font-size="72" font-weight="bold" text-anchor="middle" fill="#111">${symbol}</text><text x="190" y="260" font-family="Arial" font-size="28" text-anchor="middle" fill="#555">${name}</text><text x="360" y="220" font-family="Arial" font-size="${size}" font-weight="bold" fill="#fff">${headline}</text><text x="360" y="280" font-family="Arial" font-size="32" fill="#FFC93C">${OG_SITE}</text></svg>`;
}
