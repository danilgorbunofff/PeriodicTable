import { memo } from "react";
import { FAMILY_FILL } from "../lib/familyFill";
import type { ElementNode } from "../lib/elements";
import { cameraInteract } from "../lib/cameraInteract";

export type TileClaim = {
  price: number;
  logoUrl?: string;
  contested?: boolean;
  selected?: boolean;
};

/** Flat porcelain tile — MVP forbids metal/glass/cosmic shaders (REVIEW P0, Phase 4 demoted).
 * Premium signal = tiny ELITE / EXOTIC caption only. */
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
  const bg = claimed ? FAMILY_FILL[el.family] ?? "#fff" : "#fff";
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
      className="tile-lift group relative rounded-lg border border-hairline shadow-[0_2px_7px_rgba(31,43,62,.12)] hover:shadow-lg cursor-pointer flex flex-col items-center justify-center leading-none"
      style={{ background: bg, width: 48, height: 52 }}
    >
      <span className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 hidden group-hover:block whitespace-nowrap bg-ink text-white text-[10px] font-bold rounded-full px-2 py-0.5 z-[var(--z-tooltip)]">
        {el.symbol} {el.name} · {claimed ? `#1 $${price}` : "Unclaimed · $5"}
      </span>
      <span className="text-[8px] font-bold text-mutedink">{el.id > 0 ? el.id : "✦"}</span>
      <span className="font-display text-[14px] font-bold text-ink">{el.symbol}</span>
      {claimed && claim?.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={claim.logoUrl} alt="" draggable={false} className="mt-0.5 h-[18px] w-[18px] rounded-[5px]" />
      ) : (
        <span className="mt-0.5 text-[7px] font-extrabold text-moneyink">${price}</span>
      )}
      {claim?.contested && (
        <span className="absolute top-0.5 right-1 text-[10px]">👑</span>
      )}
      {el.tier === "EXOTIC" && (
        <span className="text-[6px] font-bold tracking-widest text-mutedink">
          EXOTIC
        </span>
      )}
      {el.tier === "CULTURAL_ELITE" && (
        <span className="text-[6px] font-bold tracking-widest text-mutedink">
          ELITE
        </span>
      )}
    </button>
  );
}

export const Tile = memo(TileInner);
