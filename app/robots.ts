import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/siteUrl";

/**
 * Crawl policy (Phase 4, P2-13; sitemap directive R01-6): public table + element
 * pages are indexable. Internal checkout/dev surfaces are explicitly excluded,
 * and the sitemap is announced here because one nobody is told about is only
 * found by accident. The origin comes from lib/siteUrl.ts so this file and
 * sitemap.xml can never disagree about the host.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/pay/", "/api/dev/", "/api/jobs/", "/api/manage/"],
    },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
