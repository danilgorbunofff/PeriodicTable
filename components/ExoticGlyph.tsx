import type { ExoticSymbol } from "../lib/exoticThemes";

export function ExoticGlyph({ symbol }: { symbol: ExoticSymbol }) {
  if (symbol === "Hbar") {
    return (
      <svg className="exotic-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <g className="exotic-glyph__orbit exotic-glyph__orbit--forward">
          <ellipse cx="12" cy="12" rx="9" ry="3.8" />
          <circle className="exotic-glyph__particle exotic-glyph__particle--a" cx="21" cy="12" r="1.25" />
        </g>
        <g className="exotic-glyph__orbit exotic-glyph__orbit--reverse">
          <ellipse cx="12" cy="12" rx="3.8" ry="9" />
          <circle className="exotic-glyph__particle exotic-glyph__particle--b" cx="12" cy="3" r="1.1" />
        </g>
        <circle className="exotic-glyph__core" cx="12" cy="12" r="3.1" />
        <path className="exotic-glyph__spark" d="m12 6 .8 4.1L17 11l-4.2.9L12 16l-.8-4.1L7 11l4.2-.9Z" />
      </svg>
    );
  }

  if (symbol === "Ps") {
    return (
      <svg className="exotic-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="exotic-glyph__ps-ring" cx="12" cy="12" r="8.3" />
        <g className="exotic-glyph__pair">
          <circle className="exotic-glyph__particle exotic-glyph__particle--a" cx="7.5" cy="12" r="3" />
          <circle className="exotic-glyph__particle exotic-glyph__particle--b" cx="16.5" cy="12" r="3" />
          <path className="exotic-glyph__bridge" d="M10.5 12h3" />
        </g>
        <circle className="exotic-glyph__pair-flare" cx="12" cy="12" r="1.5" />
      </svg>
    );
  }

  if (symbol === "Uue") {
    return (
      <svg className="exotic-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="exotic-glyph__shell exotic-glyph__shell--outer" cx="12" cy="12" r="9" />
        <circle className="exotic-glyph__shell exotic-glyph__shell--inner" cx="12" cy="12" r="6.3" />
        <g className="exotic-glyph__nucleus">
          <circle className="exotic-glyph__particle exotic-glyph__particle--a" cx="9.4" cy="10" r="2.4" />
          <circle className="exotic-glyph__particle exotic-glyph__particle--b" cx="14.4" cy="10.2" r="2.3" />
          <circle className="exotic-glyph__particle exotic-glyph__particle--c" cx="12" cy="14.3" r="2.5" />
        </g>
        <circle className="exotic-glyph__electron" cx="20.4" cy="9" r="1" />
      </svg>
    );
  }

  return (
    <svg className="exotic-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <ellipse className="exotic-glyph__lens exotic-glyph__lens--outer" cx="12" cy="12" rx="10" ry="5.6" />
      <ellipse className="exotic-glyph__lens exotic-glyph__lens--inner" cx="12" cy="12" rx="7.3" ry="3.1" />
      <circle className="exotic-glyph__void" cx="12" cy="12" r="4.1" />
      <path className="exotic-glyph__lens-flare" d="M2 12h5.2M16.8 12H22" />
      <circle className="exotic-glyph__particle exotic-glyph__particle--a" cx="19.7" cy="8.2" r="1" />
    </svg>
  );
}
