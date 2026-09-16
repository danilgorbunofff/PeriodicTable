import { memo } from "react";
import { FAMILY_FILL } from "../lib/familyFill";
import type { ElementNode } from "../lib/elements";
import { cameraInteract } from "../lib/cameraInteract";
import { getExoticTheme } from "../lib/exoticThemes";
import { tileFace } from "../lib/tileFace";

export type TileClaim = {
  price: number;
  logoUrl?: string;
  selected?: boolean;
  /** R16-9: a seeded placeholder rather than a customer. The face carries a
   *  `demo` badge, because the tile otherwise asserts that the named company
   *  bought this seat — the same claim the About page makes for every listing. */
  demo?: boolean;
};

/** Flat porcelain tile for standard elements. Exotic tiles share the exact same
 *  structure and logic — only their ambient background coloring differs
 *  (themed .exotic-tile face from lib/exoticThemes.ts + app/globals.css). */
function TileInner({
  el,
  claim,
  onSelect,
  tabIndex,
  pricesKnown = false,
}: {
  el: ElementNode;
  claim?: TileClaim;
  onSelect?: (el: ElementNode) => void;
  /** Roving tabindex from PeriodicGrid (one tab stop for the whole table). */
  tabIndex?: number;
  /** False until the live table has answered, which is what a crawler and a
   *  JS-less visitor see. The face then states no price and no holder: the
   *  title, the tooltip and the visible value all come from lib/tileFace.ts,
   *  which is where the "unclaimed $5 ×122" document used to come from (R02-4). */
  pricesKnown?: boolean;
}) {
  const face = tileFace(el, claim, pricesKnown);
  const claimed = face.claimed;
  const exoticTheme = getExoticTheme(el.symbol);
  const bg = exoticTheme ? undefined : claimed ? FAMILY_FILL[el.family] ?? "#fff" : "#fff";

  return (
    <a
      href={`/elements/${el.symbol}`}
      draggable={false}
      onClick={(event) => {
        // A real link first (R01-3): crawlers, cmd-click, middle-click and "open
        // in new tab" all reach the element page. A plain left click keeps the
        // modal the rest of the board assumes.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (cameraInteract.dragging) return;
        onSelect?.(el);
      }}
      onKeyDown={(event) => {
        // Space does not activate a link; the tile was a button before, so keep
        // the key working (Enter is native).
        if (event.key !== " ") return;
        event.preventDefault();
        onSelect?.(el);
      }}
      tabIndex={tabIndex}
      title={face.title}
      aria-label={`${el.symbol} ${el.name}${face.ariaLabelSuffix}`}
      className={`tile-lift group relative rounded-lg border cursor-pointer flex flex-col items-center justify-center leading-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
        exoticTheme
          ? `exotic-tile ${exoticTheme.className}`
          : "border-hairline shadow-[0_2px_7px_rgba(31,43,62,.12)] hover:shadow-lg"
      }`}
      style={{ background: bg, width: 48, height: 52 }}
    >
      <span className={`pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 hidden group-hover:block whitespace-nowrap bg-ink text-white text-[10px] font-bold rounded-full px-2 py-0.5 z-[var(--z-tooltip)]`}>
        {face.title}
      </span>
      <>
        <span className={exoticTheme ? "text-[8px] font-bold text-[#d5e7f7] [text-shadow:0_1px_3px_rgba(0,3,12,0.78)]" : "text-[8px] font-bold text-ink"}>{el.id > 0 ? el.id : "✦"}</span>
        <span className={exoticTheme ? "font-display text-[14px] font-bold text-[#f7fbff] [text-shadow:0_1px_3px_rgba(0,3,12,0.78)]" : "font-display text-[14px] font-bold text-ink"}>{el.symbol}</span>
        {face.priced && claim?.demo ? (
          // The badge sits on the face itself, not in the hover tooltip: a label
          // a reader has to hover to find is not a label on a table of 118
          // tiles. Size is fixed at 7px so it cannot change the tile's box.
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute right-[3px] top-[2px] rounded-[3px] px-[2px] text-[7px] font-bold uppercase leading-[9px] tracking-wide ${exoticTheme ? "bg-[#0b1220] text-[#d5e7f7]" : "bg-ink/85 text-white"}`}
          >
            demo
          </span>
        ) : null}
        {face.priced && claim?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={claim.logoUrl}
            alt=""
            draggable={false}
            className="mt-0.5 h-[18px] w-[18px] rounded-[5px]"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        ) : face.priceText ? (
          <span className={`mt-0.5 h-[18px] flex items-center justify-center text-[11px] font-extrabold ${exoticTheme ? "text-[#f7fbff] [text-shadow:0_1px_3px_rgba(0,3,12,0.78)]" : "text-ink"}`}>{face.priceText}</span>
        ) : (
          // Neutral face: the price's box, holding nothing. The tile keeps its
          // height, so a tile does not resize when the live prices arrive.
          <span aria-hidden="true" className="mt-0.5 h-[18px] w-[18px]" />
        )}
      </>
    </a>
  );
}

export const Tile = memo(TileInner);
