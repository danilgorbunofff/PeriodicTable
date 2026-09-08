import type { MetadataRoute } from "next";

/**
 * Crawl policy (Phase 4, P2-13): public table + element pages are indexable.
 * Internal checkout/dev surfaces are explicitly excluded.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/pay/", "/api/dev/", "/api/jobs/", "/api/manage/"],
    },
  };
}
