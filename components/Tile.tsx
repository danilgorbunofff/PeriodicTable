import { memo } from "react";
import { FAMILY_FILL } from "../lib/familyFill";
import { EXOTIC_STYLES } from "../lib/exoticStyle";
import type { ElementNode } from "../lib/elements";
import { cameraInteract } from "../lib/cameraInteract";
import { getExoticTheme, isExoticSymbol } from "../lib/exoticThemes";
import { ExoticGlyph } from "./ExoticGlyph";

export type TileClaim = {
  price: number;
  logoUrl?: string;
  contested?: boolean;
  selected?: boolean;
};

/** Flat porcelain tile for standard elements. Exotic tiles always use their
 *  themed face + glyph (lib/exoticThemes.ts); claimed exotics additionally
 *  get a unique animated FX treatment per symbol (lib/exoticStyle.ts) —
 *  transparent glow/beam/shine/star layers composed over the themed face.
 *  Unclaimed exotics stay unanimated apart from the ambient sheen. */
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
  const exoticFx = claimed && el.tier === "EXOTIC" ? EXOTIC_STYLES[el.symbol] : undefined;
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
      {exoticFx && (
        <>
          <span className="exotic-glow" style={{ "--exotic-glow": exoticFx.glow } as React.CSSProperties} />
          {exoticFx.beam && (
            <span
              className="exotic-beam"
              style={{ "--exotic-beam-a": exoticFx.beam[0], "--exotic-beam-b": exoticFx.beam[1] } as React.CSSProperties}
            />
          )}
          {exoticFx.shine && <span className="exotic-shine" />}
          {exoticFx.stars && (
            <span className="exotic-stars">
              {[
                { l: "18%", t: "22%" },
                { l: "70%", t: "18%", d: "-0.8s" },
                { l: "42%", t: "62%" },
                { l: "82%", t: "58%", d: "-1.3s" },
                { l: "28%", t: "80%", d: "-0.4s" },
                { l: "62%", t: "84%" },
              ].map((s, i) => (
                <span key={i} style={{ left: s.l, top: s.t, animationDelay: s.d ?? "0s" }} />
              ))}
            </span>
          )}
        </>
      )}
      <span className={`pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 hidden group-hover:block whitespace-nowrap bg-ink text-white text-[10px] font-bold rounded-full px-2 py-0.5 z-[var(--z-tooltip)]`}>
        {el.symbol} {el.name} · {claimed ? `#1 $${price}` : "Unclaimed · $5"}
      </span>
      {exoticTheme && isExoticSymbol(el.symbol) ? (
        <>
          <span className="exotic-tile__number">{el.id > 0 ? el.id : "✦"}</span>
          <span className="exotic-tile__symbol">{el.symbol}</span>
          <ExoticGlyph symbol={el.symbol} />
          {!claimed && <span className="exotic-tile__price">${price}</span>}
          {claimed && (
            <>
              <span className="exotic-tile__leader exotic-tile__leader--fallback" aria-hidden="true">#1</span>
              {claim?.logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={claim.logoUrl}
                  alt=""
                  draggable={false}
                  className="exotic-tile__leader"
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
              )}
            </>
          )}
        </>
      ) : (
        <>
          <span className="text-[8px] font-bold text-ink">{el.id > 0 ? el.id : "✦"}</span>
          <span className="font-display text-[14px] font-bold text-ink">{el.symbol}</span>
          {claimed && claim?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={claim.logoUrl} alt="" draggable={false} className="mt-0.5 h-[18px] w-[18px] rounded-[5px]" />
          ) : (
            <span className="mt-0.5 text-[7px] font-extrabold text-ink">${price}</span>
          )}
        </>
      )}
    </button>
  );
}

export const Tile = memo(TileInner);
