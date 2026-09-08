import type { MetadataRoute } from "next";
import { ELEMENTS } from "@/lib/elements";

/**
 * Sitemap policy (Phase 4, P2-13): static routes + all 122 element pages.
 * Startup profiles (/s/[domain]) are intentionally EXCLUDED — unbounded,
 * user-generated, and frequently churned; they stay discoverable via element
 * pages and the board. Internal surfaces (/pay/*, /api/*) are disallowed in
 * robots.ts. Revisit if profiles need indexation post-launch.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://periodictable.lol";
  return [
    { url: `${base}/`, lastModified: new Date() },
    ...ELEMENTS.map((e) => ({ url: `${base}/elements/${encodeURIComponent(e.symbol)}`, lastModified: new Date() })),
  ];
}
