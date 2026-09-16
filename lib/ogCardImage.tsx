// JSX here compiles to the classic runtime wherever Next's bundler is not the
// one doing the transform (vitest, `tsc`), so React has to be in scope by name:
// without it the render throws "React is not defined" and every card silently
// falls back to SVG.
import React, { type ReactElement } from "react";
import { ImageResponse } from "next/og";
import { OG_CARD, OG_SITE, headlineFontSize, type OgCard } from "./ogCard";
import { describeError, logWarn } from "./log";

/** The card as satori sees it. Inline flex-only styles: next/og renders without
 *  a CSS engine, and the geometry mirrors lib/ogCard.ts:renderOgCardSvg. */
function cardNode(card: OgCard): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        backgroundColor: "#05070A",
        padding: 80,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: 220,
          height: 240,
          backgroundColor: "#ffffff",
          borderRadius: 24,
        }}
      >
        <div style={{ display: "flex", fontSize: 72, fontWeight: 700, color: "#111111" }}>{card.symbol}</div>
        <div style={{ display: "flex", fontSize: 28, color: "#555555" }}>{card.name}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", marginLeft: 60 }}>
        <div style={{ display: "flex", fontSize: headlineFontSize(card.headline), fontWeight: 700, color: "#ffffff" }}>
          {card.headline}
        </div>
        <div style={{ display: "flex", fontSize: 32, color: "#FFC93C", marginTop: 16 }}>{OG_SITE}</div>
      </div>
    </div>
  );
}

/**
 * PNG bytes, or null when the renderer fails (R01-2). The body is read here
 * rather than streamed so a satori failure can answer with the static SVG card
 * instead of a 500 that the unfurler then caches.
 */
export async function renderCardPng(card: OgCard): Promise<ArrayBuffer | null> {
  try {
    return await new ImageResponse(cardNode(card), { ...OG_CARD }).arrayBuffer();
  } catch (e) {
    // The SVG fallback is silent by design, so the reason it was needed has to
    // be logged: otherwise a broken renderer looks like a working card route.
    logWarn("og", "png-render-failed", { error: describeError(e) });
    return null;
  }
}

/** The card `/` advertises as its og:image (R01-1): fixed copy and no database
 *  read, so a share of the product's own URL can never 500. Plain ASCII, like
 *  every other fixed string on a card: a glyph outside the bundled font makes
 *  satori fetch a Google font mid-render, which is a network hop (and a warning)
 *  an unfurl must not depend on. */
export const OG_HOME_CARD: OgCard = {
  symbol: "122",
  name: "elements",
  headline: "Put your startup on the table.",
};
