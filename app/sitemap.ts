import type { MetadataRoute } from "next";
import { ELEMENTS } from "@/lib/elements";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://periodictable.lol";
  return [
    { url: `${base}/`, lastModified: new Date() },
    ...ELEMENTS.map((e) => ({ url: `${base}/elements/${encodeURIComponent(e.symbol)}`, lastModified: new Date() })),
  ];
}
