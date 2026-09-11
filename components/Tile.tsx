import { memo } from "react";
import { FAMILY_FILL } from "../lib/familyFill";
import type { ElementNode } from "../lib/elements";
import { cameraInteract } from "../lib/cameraInteract";
import { getExoticTheme } from "../lib/exoticThemes";

export type TileClaim = {
  price: number;
  logoUrl?: string;
  selected?: boolean;
};

/** Flat porcelain tile for standard elements. Exotic tiles share the exact same
 *  structure and logic — only their ambient background coloring differs
 *  (themed .exotic-tile face from lib/exoticThemes.ts + app/globals.css). */
function TileInner({
  el,
  claim,
  onSelect,
  tabIndex,
}: {
  el: ElementNode;
  claim?: TileClaim;
  onSelect?: (el: ElementNode) => void;
  /** Roving tabindex from PeriodicGrid (one tab stop for the whole table). */
  tabIndex?: number;
}) {
  const claimed = !!claim;
  const exoticTheme = getExoticTheme(el.symbol);
  const bg = exoticTheme ? undefined : claimed ? FAMILY_FILL[el.family] ?? "#fff" : "#fff";
  const price = claim?.price ?? 5;

  return (
    <button
      onClick={() => {
        if (cameraInteract.dragging) return;
        onSelect?.(el);
      }}
      tabIndex={tabIndex}
      title={`${el.symbol} ${el.name} · ${claimed ? `#1 $${price}` : "Unclaimed · $5"}`}
      aria-label={`${el.symbol} ${el.name}, ${claimed ? `claimed, leader pays $${price}` : "unclaimed"}`}
      className={`tile-lift group relative rounded-lg border cursor-pointer flex flex-col items-center justify-center leading-none ${
        exoticTheme
          ? `exotic-tile ${exoticTheme.className}`
          : "border-hairline shadow-[0_2px_7px_rgba(31,43,62,.12)] hover:shadow-lg"
      }`}
      style={{ background: bg, width: 48, height: 52 }}
    >
      <span className={`pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 hidden group-hover:block whitespace-nowrap bg-ink text-white text-[10px] font-bold rounded-full px-2 py-0.5 z-[var(--z-tooltip)]`}>
        {el.symbol} {el.name} · {claimed ? `#1 $${price}` : "Unclaimed · $5"}
      </span>
      <>
        <span className={exoticTheme ? "text-[8px] font-bold text-[#d5e7f7] [text-shadow:0_1px_3px_rgba(0,3,12,0.78)]" : "text-[8px] font-bold text-ink"}>{el.id > 0 ? el.id : "✦"}</span>
        <span className={exoticTheme ? "font-display text-[14px] font-bold text-[#f7fbff] [text-shadow:0_1px_3px_rgba(0,3,12,0.78)]" : "font-display text-[14px] font-bold text-ink"}>{el.symbol}</span>
        {claimed && claim?.logoUrl ? (
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
        ) : (
          <span className={`mt-0.5 h-[18px] flex items-center justify-center text-[11px] font-extrabold ${exoticTheme ? "text-[#f7fbff] [text-shadow:0_1px_3px_rgba(0,3,12,0.78)]" : "text-ink"}`}>${price}</span>
        )}
      </>
    </button>
  );
}

export const Tile = memo(TileInner);
