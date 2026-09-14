/**
 * What a tile's face is allowed to say (R02-4).
 *
 * The board is a client component, but Next still renders it on the server, and
 * it is what a crawler and a JS-less visitor read. Every one of the 122 tiles
 * used to carry `Unclaimed · $5` in its title, its tooltip and its face before
 * a single byte of evidence arrived — an inventory claim about 122 elements
 * that the document had no way to know. The face is now a function of the data:
 * with no data the tile carries its symbol and its name, and no price at all.
 *
 * The `$5` floor is a fact about the product and still appears where it belongs
 * — as an advertised floor in the hero CTA and the claim modal, in live
 * territory copy, and on a tile the server has actually confirmed is unclaimed.
 */
export const FLOOR_PRICE = 5;

/** Structurally what components/Tile.tsx receives; declared here so this module
 *  does not import a component. */
export type FaceClaim = { price: number; logoUrl?: string };

export type TileFace = {
  /** False until the live table has answered. An unpriced face may state no
   *  price, no "unclaimed", and shows no holder logo. */
  priced: boolean;
  /** True when the live table says someone holds this element. */
  claimed: boolean;
  /** Hover tooltip and native title, the same string in both places. */
  title: string;
  /** Appended to `"{symbol} {name}"` to form the link's accessible name. */
  ariaLabelSuffix: string;
  /** The value drawn under the symbol, or null when nothing may be drawn. */
  priceText: string | null;
};

export function tileFace(
  el: { symbol: string; name: string },
  claim: FaceClaim | undefined,
  pricesKnown: boolean
): TileFace {
  const identified = `${el.symbol} ${el.name}`;
  if (!pricesKnown) {
    return { priced: false, claimed: false, title: identified, ariaLabelSuffix: "", priceText: null };
  }
  const claimed = !!claim;
  // Truthiness rather than `??`: a zero price cannot come from the pricing
  // rules, and "$0" would advertise a free element rather than hide the bug.
  const price = claim?.price || FLOOR_PRICE;
  return {
    priced: true,
    claimed,
    title: claimed ? `${identified} · #1 $${price}` : `${identified} · Unclaimed · $${FLOOR_PRICE}`,
    ariaLabelSuffix: claimed ? `, claimed, leader pays $${price}` : ", unclaimed",
    priceText: `$${price}`,
  };
}
