/**
 * Sitemap entries with a truthful `lastModified` (R01-5), including the legal
 * documents (R16-13).
 *
 * All 123 URLs used to carry `new Date()` — the render time — so a crawler saw
 * every page as changed on every fetch and learned to discount `lastmod`. A
 * stake is the only thing that changes a face, so each element carries its own
 * newest stake write and the board carries the newest write overall. With no
 * stake at all the key is omitted rather than faked.
 *
 * The four legal documents were missing from the sitemap entirely, which is how
 * §5.7 of the legal review found that nothing announced a change to them. They
 * are listed last, and their `lastModified` is the day the published words last
 * changed: a legal change *is* a write to that URL, which is the one page type
 * where the honest stamp is a release date rather than a database row. That date
 * is internal — `LEGAL_UPDATED` — because the documents themselves are not
 * versioned and print no stamp.
 *
 * R19-4 adds `/faq` for the same reason and by the same rule: it is a static
 * page whose only write is an edit to its words, and its stamp is a release
 * date kept internally in `FAQ_REVISED` rather than printed on the page. It
 * sorts after the corpus so the legal block stays contiguous and index-stable
 * for the tests that read it positionally.
 */
import type { MetadataRoute } from "next";
import { LEGAL_SLUGS, LEGAL_UPDATED } from "./legal";
import { FAQ_PATH, FAQ_REVISED } from "./faq";

export type ElementStamp = { symbol: string; updatedAt: Date | null };

export function buildSitemapEntries(base: string, stamps: ElementStamp[]): MetadataRoute.Sitemap {
  let newest: Date | null = null;
  for (const s of stamps) {
    if (s.updatedAt && (!newest || s.updatedAt > newest)) newest = s.updatedAt;
  }
  return [
    { url: `${base}/`, ...(newest ? { lastModified: newest } : {}) },
    ...stamps.map((s) => ({
      url: `${base}/elements/${encodeURIComponent(s.symbol)}`,
      ...(s.updatedAt ? { lastModified: s.updatedAt } : {}),
    })),
    ...LEGAL_SLUGS.map((slug) => ({
      url: `${base}/legal/${slug}`,
      lastModified: new Date(`${LEGAL_UPDATED}T00:00:00.000Z`),
    })),
    { url: `${base}${FAQ_PATH}`, lastModified: new Date(`${FAQ_REVISED}T00:00:00.000Z`) },
  ];
}
