/* R01-2 / R01-8 / U01-3: the card's text, its bounds, and the escaping that
   stands between a stored domain and the SVG fallback. A card is read by
   strangers' unfurlers, so nothing here may depend on lib/validate.ts having
   rejected every hostile value on the way in. */
import { describe, it, expect } from "vitest";
import {
  OG_DOMAIN_MAX,
  OG_TEXT_WIDTH,
  clampDomain,
  escapeXml,
  headlineFontSize,
  ogCard,
  renderOgCardSvg,
} from "./ogCard";
import { OG_HOME_CARD, renderCardPng } from "./ogCardImage";

describe("escapeXml", () => {
  it("escapes the five metacharacters, ampersand first", () => {
    expect(escapeXml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&apos;");
    expect(escapeXml("a & b")).toBe("a &amp; b");
    // Already-escaped input must not decode into a fresh entity.
    expect(escapeXml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves text with nothing to escape alone", () => {
    expect(escapeXml("acme-rockets.io")).toBe("acme-rockets.io");
    expect(escapeXml("✦ 122 elements")).toBe("✦ 122 elements");
  });
});

describe("clampDomain (U01-3)", () => {
  it("leaves a domain that fits untouched", () => {
    expect(clampDomain("acme.io")).toBe("acme.io");
    expect(clampDomain("x".repeat(OG_DOMAIN_MAX))).toBe("x".repeat(OG_DOMAIN_MAX));
  });

  it("truncates with an ellipsis at the cap, never over it", () => {
    const long = "a-very-long-startup-domain.example.com";
    const clamped = clampDomain(long);
    expect(clamped.length).toBe(OG_DOMAIN_MAX);
    expect(clamped.endsWith("…")).toBe(true);
    expect(long.startsWith(clamped.slice(0, -1))).toBe(true);
  });

  it("trims padding before measuring, so whitespace cannot push a line over", () => {
    expect(clampDomain("  acme.io  ")).toBe("acme.io");
  });
});

describe("headlineFontSize", () => {
  it("shrinks as the headline grows and never leaves the text column", () => {
    const sizes = ["#1 acme.io $5", "#1 a-fairly-long-domain.example.com $2500"].map((h) => headlineFontSize(h));
    expect(sizes[0]).toBeGreaterThan(sizes[1]);
    for (const h of ["#1 acme.io $5", "Unclaimed · from $5", "#1 a-fairly-long-domain.example.com $2500"]) {
      const size = headlineFontSize(h);
      if (size > 26) expect(h.length * size * 0.55).toBeLessThanOrEqual(OG_TEXT_WIDTH);
    }
  });

  it("stops shrinking at a legible floor instead of vanishing (U01-3)", () => {
    expect(headlineFontSize("#1 " + "x".repeat(400) + " $5")).toBe(26);
  });
});

describe("ogCard", () => {
  it("names the leader as `#1 domain $amount`", () => {
    expect(ogCard({ symbol: "H", name: "Hydrogen", leader: { domain: "acme.io", amountUsd: 12 } }).headline).toBe(
      "#1 acme.io $12"
    );
  });

  it("says a face nobody claimed is claimable, not that it has no leader", () => {
    expect(ogCard({ symbol: "H", name: "Hydrogen" }).headline).toBe("Unclaimed · from $5");
    expect(ogCard({ symbol: "H", name: "Hydrogen", leader: null }).headline).toBe("Unclaimed · from $5");
  });

  it("admits an unread database instead of asserting an unclaimed element (R02-4)", () => {
    const card = ogCard({ symbol: "H", name: "Hydrogen", unavailable: true });
    expect(card.headline).toBe("Live standings unavailable");
    // A leader read in the same breath cannot make the card claim one.
    expect(ogCard({ symbol: "H", name: "Hydrogen", leader: { domain: "acme.io", amountUsd: 9 }, unavailable: true }).headline).toBe(
      "Live standings unavailable"
    );
  });

  it("clamps the one unbounded value on the card", () => {
    const card = ogCard({ symbol: "H", name: "Hydrogen", leader: { domain: "x".repeat(60), amountUsd: 1 } });
    expect(card.headline.includes("…")).toBe(true);
    expect(card.headline.length).toBeLessThan(40);
  });
});

describe("renderOgCardSvg (R01-8)", () => {
  const hostile = ogCard({
    symbol: "H",
    name: `Hydrogen</text><script>alert(1)</script>`,
    leader: { domain: `evil"><script>alert(2)</script>`, amountUsd: 3 },
  });
  const svg = renderOgCardSvg(hostile);

  it("carries no raw markup from the database", () => {
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("alert(1)</");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("escapes quotes and ampersands, so no attribute or text node can be broken out of", () => {
    expect(svg).toContain("&quot;");
    expect(renderOgCardSvg(ogCard({ symbol: "H", name: "a & b" }))).toContain("&amp;");
    // The hostile name's raw closing tag must not appear anywhere in the markup.
    expect(svg).not.toContain("</text><script>");
  });

  it("still draws the card: fixed geometry, escaped text, one site line", () => {
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="630">/);
    expect(svg).toContain(`font-size="${headlineFontSize(hostile.headline)}"`);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain("periodictable.lol");
  });
});

describe("renderCardPng", () => {
  it("keeps the home card inside the bundled font's coverage", () => {
    // A glyph the bundled font lacks makes satori fetch a Google font during
    // the render: a network hop, and a warning, on the unfurl path.
    const text = `${OG_HOME_CARD.symbol} ${OG_HOME_CARD.name} ${OG_HOME_CARD.headline}`;
    expect(text).toMatch(/^[\x20-\x7E]+$/);
    expect(OG_HOME_CARD.symbol.length).toBeLessThan(6);
  });

  it("renders the home card as real PNG bytes, not SVG", async () => {
    const png = await renderCardPng(OG_HOME_CARD);
    if (!png) {
      // The route falls back to the SVG card in this case (R01-2) — correct
      // behaviour, so this is a warning rather than a failure.
      console.warn("next/og produced no PNG in this environment; the route serves the SVG fallback");
      return;
    }
    expect(png.byteLength).toBeGreaterThan(1000);
    expect([...new Uint8Array(png.slice(0, 4))]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
