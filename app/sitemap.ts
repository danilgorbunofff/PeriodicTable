import type { MetadataRoute } from "next";
import { ELEMENTS } from "@/lib/elements";
import { prisma } from "@/lib/prisma";
import { siteOriginStrict } from "@/lib/siteUrl";
import { buildSitemapEntries, type ElementStamp } from "@/lib/sitemapData";

/**
 * Sitemap policy (Phase 4, P2-13; lastmod R01-5): static routes + all 122
 * element pages. Startup profiles (/s/[domain]) are intentionally EXCLUDED —
 * unbounded, user-generated, and frequently churned; they stay discoverable via
 * element pages and the board. Internal surfaces (/pay/*, /api/*) are
 * disallowed in robots.ts. Revisit if profiles need indexation post-launch.
 *
 * `lastModified` is the newest write to a face (Stake.updatedAt), never the
 * render time: a crawler that sees a fresh timestamp on every fetch learns to
 * ignore the field. Regenerated hourly so a new stake lands within the hour
 * without turning every request into a database read.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemapEntries(siteOriginStrict(), await elementStamps());
}

/** Newest stake write per element, in table order. A database that cannot be
 *  read yields no stamps at all: an omitted `lastmod` is honest, a faked one is
 *  not. */
async function elementStamps(): Promise<ElementStamp[]> {
  try {
    const [groups, elements] = await Promise.all([
      prisma.stake.groupBy({ by: ["elementId"], _max: { updatedAt: true } }),
      prisma.element.findMany({ select: { id: true, symbol: true } }),
    ]);
    const byElementId = new Map(groups.map((g) => [g.elementId, g._max.updatedAt ?? null]));
    const bySymbol = new Map(elements.map((e) => [e.symbol, byElementId.get(e.id) ?? null]));
    return ELEMENTS.map((e) => ({ symbol: e.symbol, updatedAt: bySymbol.get(e.symbol) ?? null }));
  } catch {
    return ELEMENTS.map((e) => ({ symbol: e.symbol, updatedAt: null }));
  }
}
