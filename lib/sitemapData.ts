/**
 * Sitemap entries with a truthful `lastModified` (R01-5).
 *
 * All 123 URLs used to carry `new Date()` — the render time — so a crawler saw
 * every page as changed on every fetch and learned to discount `lastmod`. A
 * stake is the only thing that changes a face, so each element carries its own
 * newest stake write and the board carries the newest write overall. With no
 * stake at all the key is omitted rather than faked.
 */
import type { MetadataRoute } from "next";

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
  ];
}
