/* R01-5: `lastModified` has to mean something. The acceptance check is that two
   generations over unchanged data agree — the old `new Date()` per entry could
   not pass it, which is exactly why crawlers discount `lastmod`. */
import { describe, it, expect } from "vitest";
import { ELEMENTS } from "./elements";
import { LEGAL_SLUGS, LEGAL_UPDATED } from "./legal";
import { FAQ_PATH, FAQ_REVISED } from "./faq";
import { buildSitemapEntries, type ElementStamp } from "./sitemapData";

const at = (iso: string) => new Date(iso);
const stamps: ElementStamp[] = [
  { symbol: "H", updatedAt: at("2026-09-01T10:00:00.000Z") },
  { symbol: "He", updatedAt: at("2026-09-03T10:00:00.000Z") },
  { symbol: "Li", updatedAt: null },
];

describe("buildSitemapEntries", () => {
  it("gives each element its own newest write, not the render time", () => {
    const entries = buildSitemapEntries("https://www.periodictable.lol", stamps);
    expect(entries[1]).toEqual({
      url: "https://www.periodictable.lol/elements/H",
      lastModified: at("2026-09-01T10:00:00.000Z"),
    });
    expect(entries[2].lastModified).toEqual(at("2026-09-03T10:00:00.000Z"));
  });

  it("stamps the board with the newest write overall", () => {
    expect(buildSitemapEntries("https://www.periodictable.lol", stamps)[0]).toEqual({
      url: "https://www.periodictable.lol/",
      lastModified: at("2026-09-03T10:00:00.000Z"),
    });
  });

  it("omits the key where there is nothing to report rather than inventing a time", () => {
    const entries = buildSitemapEntries("https://www.periodictable.lol", stamps);
    expect("lastModified" in entries[3]).toBe(false);

    const cold = buildSitemapEntries("https://www.periodictable.lol", [
      { symbol: "H", updatedAt: null },
      { symbol: "He", updatedAt: null },
    ]);
    // Stakes and elements only: the legal entries and `/faq` always carry a
    // release date, which is a real write to that URL rather than a render-time
    // stamp, so only the head of the list can be undated.
    expect(cold.slice(0, 3).some((e) => "lastModified" in e)).toBe(false);
  });

  it("is byte-identical across two generations over unchanged data", () => {
    const first = buildSitemapEntries("https://www.periodictable.lol", stamps);
    const second = buildSitemapEntries("https://www.periodictable.lol", stamps);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("covers the board, every element and every legal document under the origin it is handed", () => {
    const entries = buildSitemapEntries(
      "https://ptl-git-main.vercel.app",
      ELEMENTS.map((e) => ({ symbol: e.symbol, updatedAt: null }))
    );
    expect(entries).toHaveLength(ELEMENTS.length + 1 + LEGAL_SLUGS.length + 1);
    const urls = entries.map((e) => e.url);
    expect(urls[0]).toBe("https://ptl-git-main.vercel.app/");
    expect(new Set(urls).size).toBe(urls.length);
    for (const e of ELEMENTS) {
      expect(urls).toContain(`https://ptl-git-main.vercel.app/elements/${encodeURIComponent(e.symbol)}`);
    }
  });

  it("lists every legal document, dated by the day its words last changed (R16-13)", () => {
    const base = "https://www.periodictable.lol";
    const entries = buildSitemapEntries(base, []);
    expect(entries).toHaveLength(1 + LEGAL_SLUGS.length + 1);
    for (const slug of LEGAL_SLUGS) {
      const entry = entries.find((e) => e.url === `${base}/legal/${slug}`);
      expect(entry, `/legal/${slug} missing from the sitemap`).toBeDefined();
      // One date for the whole corpus: the documents are not versioned, so
      // there is no per-document revision to read, only the day the block was
      // last written — which is what a crawler is being told about that URL.
      expect(entry?.lastModified).toEqual(new Date(`${LEGAL_UPDATED}T00:00:00.000Z`));
    }
    expect(entries[0].url).toBe(`${base}/`);
    expect(entries[1].url).toBe(`${base}/legal/about`);
    // The corpus stays a contiguous, index-stable block; the FAQ is appended
    // after it for the same reason it is in the sitemap at all (R19-4): it is a
    // static page whose only write is an edit to its words.
    expect(entries.at(-1)).toEqual({
      url: `${base}${FAQ_PATH}`,
      lastModified: new Date(`${FAQ_REVISED}T00:00:00.000Z`),
    });
  });
});
