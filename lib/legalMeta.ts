import type { Metadata } from "next";
import { siteOrigin } from "./siteUrl";

const SITE_NAME = "periodictable.lol";

export type LegalPageCopy = { title: string; desc: string };

/**
 * Metadata for a legal document (R02-7).
 *
 * All three slugs are statically generated and shared one document identity
 * before this: `/legal/rules` served the root layout's title and description,
 * so a search result or a pasted link for the rules advertised the board's
 * marketing copy and nothing said which page it was.
 *
 * Built off the same copy the page body renders, so a title cannot describe a
 * page that says something else. `metadataBase` comes from the root layout;
 * the canonical is absolute here so it survives a route rendered outside it.
 */
export function legalMetadata(slug: string, page: LegalPageCopy, env: Record<string, string | undefined> = process.env): Metadata {
  const canonical = `${siteOrigin(env)}/legal/${slug}`;
  const title = `${page.title} · ${SITE_NAME}`;
  return {
    title,
    description: page.desc,
    alternates: { canonical },
    openGraph: { type: "article", siteName: SITE_NAME, url: canonical, title, description: page.desc },
    twitter: { card: "summary_large_image", title, description: page.desc },
  };
}
