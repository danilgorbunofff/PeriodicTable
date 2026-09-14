/* Phase 1 acceptance (doc/review/01-discovery-and-unfurl.md §8): the board
   unfurls, every entity self-canonicalises, and the surface a crawler reads
   (robots, sitemap, tile hrefs) points at the same host. The tags are asserted
   against the object the layout ships; the wiring that can only be seen in the
   rendered route is locked by reading the source, the way lib/a11y.test.ts does
   for the grid. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { homeMetadata } from "./shareMeta";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const ORIGIN = "https://www.periodictable.lol";

describe("home share metadata (R01-1)", () => {
  const meta = homeMetadata({ NEXT_PUBLIC_APP_URL: ORIGIN });

  it("publishes the full OpenGraph set, not just a title", () => {
    const og = meta.openGraph as Record<string, unknown>;
    for (const key of ["type", "siteName", "title", "description", "url", "images"]) {
      expect(og[key], `og:${key}`).toBeTruthy();
    }
    expect(og.type).toBe("website");
  });

  it("advertises an absolute og:image at the card route, with its real size", () => {
    const [image] = meta.openGraph!.images as { url: string; width: number; height: number; alt: string }[];
    expect(image.url).toBe(`${ORIGIN}/og/home`);
    expect(image.url.startsWith("https://")).toBe(true);
    expect([image.width, image.height]).toEqual([1200, 630]);
    expect(image.alt).toBeTruthy();
  });

  it("unfurls large on X instead of as a thumbnail", () => {
    expect(meta.twitter).toMatchObject({ card: "summary_large_image", images: [`${ORIGIN}/og/home`] });
  });

  it("canonicalises the board, so ?el= deep links fold into it (R01-4)", () => {
    expect(meta.alternates).toEqual({ canonical: "/" });
    expect(meta.metadataBase?.toString()).toBe(`${ORIGIN}/`);
  });

  it("follows the configured host rather than a hardcoded one", () => {
    const preview = homeMetadata({ NEXT_PUBLIC_APP_URL: "https://ptl-git-main.vercel.app" });
    expect((preview.openGraph!.images as { url: string }[])[0].url).toBe("https://ptl-git-main.vercel.app/og/home");
  });
});

describe("card routes (R01-2)", () => {
  const route = src("app/og/[sym]/route.tsx");
  const home = src("app/og/home/route.tsx");

  it("answers the per-element card as PNG, the format unfurlers accept", () => {
    expect(route).toMatch(/"Content-Type": "image\/png"/);
    expect(route).toMatch(/renderCardPng\(card\)/);
  });

  it("keeps the SVG card as a fallback instead of answering 500", () => {
    expect(route).toMatch(/renderOgCardSvg\(card\)/);
    expect(route).toMatch(/"Content-Type": "image\/svg\+xml"/);
    expect(route).not.toMatch(/status: 500/);
  });

  it("marks a card drawn without a database read, and retries only connect errors", () => {
    expect(route).toMatch(/unavailable: true/);
    expect(route).toMatch(/COLD_START_CODES/);
    expect(route).toMatch(/catch \{/);
  });

  it("still 404s an unknown symbol rather than unfurling an error card", () => {
    expect(route).toMatch(/status: 404/);
  });

  it("serves the home card without touching the database", () => {
    expect(home).toMatch(/OG_HOME_CARD/);
    expect(home).not.toMatch(/prisma/);
    expect(home).toMatch(/"Content-Type": "image\/png"/);
  });
});

describe("crawl surface (R01-3, R01-5, R01-6, R01-7)", () => {
  it("robots.txt announces the sitemap at the same origin as every canonical", () => {
    const robots = src("app/robots.ts");
    expect(robots).toMatch(/sitemap: `\$\{siteOrigin\(\)\}\/sitemap\.xml`/);
  });

  it("the sitemap derives lastmod from stakes and refuses to guess the host", () => {
    const sitemap = src("app/sitemap.ts");
    expect(sitemap).toMatch(/export default async function sitemap/);
    expect(sitemap).toMatch(/groupBy/);
    expect(sitemap).toMatch(/buildSitemapEntries\(siteOriginStrict\(\)/);
    // No render-time stamp and no inline entry: every lastmod comes from the
    // stake stamps handed to buildSitemapEntries.
    expect(sitemap).not.toMatch(/new Date\(\)/);
    expect(sitemap).not.toMatch(/lastModified:/);
    expect(sitemap).toMatch(/revalidate/);
  });

  it("tiles are real links to element pages, so crawlers have a path in", () => {
    const tile = src("components/Tile.tsx");
    expect(tile).toMatch(/href=\{`\/elements\/\$\{el\.symbol\}`\}/);
    expect(tile).toMatch(/event\.preventDefault\(\)/);
    expect(tile).toMatch(/draggable=\{false\}/);
    // Left clicks still open the modal the board expects.
    expect(tile).toMatch(/onSelect\?\.\(el\)/);
    // Roving focus follows the element that is now an anchor.
    expect(src("components/PeriodicGrid.tsx")).toMatch(/querySelector<HTMLElement>\(`\[data-el-id="\$\{id\}"\] a`\)/);
  });

  it("the element page owns its canonical and card, overriding the layout's", () => {
    const page = src("app/elements/[sym]/page.tsx");
    expect(page).toMatch(/alternates: \{ canonical: `\/elements\/\$\{encodeURIComponent\(el\.symbol\)\}` \}/);
    expect(page).toMatch(/\/og\/\$\{encodeURIComponent\(el\.symbol\)\}/);
  });

  it("a startup profile canonicalises itself, never the board", () => {
    expect(src("app/s/[domain]/page.tsx")).toMatch(
      /alternates: \{ canonical: `\/s\/\$\{encodeURIComponent\(domain\)\}` \}/
    );
  });

  it("the layout reads the same origin helper, so tags and sitemap cannot disagree", () => {
    const layout = src("app/layout.tsx");
    expect(layout).toMatch(/export const metadata: Metadata = homeMetadata\(\)/);
    expect(layout).not.toMatch(/periodictable\.lol/);
  });
});
