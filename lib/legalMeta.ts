import type { Metadata } from "next";
import { siteOrigin } from "./siteUrl";
import { twitterSite } from "./shareMeta";

const SITE_NAME = "periodictable.lol";

export type LegalPageCopy = { title: string; desc: string };

/**
 * Metadata for a static document that carries its own copy and its own path
 * (R02-7, extended in R19-4).
 *
 * All three legal slugs are statically generated and shared one document
 * identity before this: `/legal/rules` served the root layout's title and
 * description, so a search result or a pasted link for the rules advertised the
 * board's marketing copy and nothing said which page it was.
 *
 * Built off the same copy the page body renders, so a title cannot describe a
 * page that says something else. `metadataBase` comes from the root layout;
 * the canonical is absolute here so it survives a route rendered outside it.
 *
 * The path is a parameter because `/faq` is the same kind of page — one
 * document, its own words, a stable URL — and giving it a second, subtly
 * different metadata builder is how two pages end up advertising each other.
 */
export function staticDocMetadata(path: string, page: LegalPageCopy, env: Record<string, string | undefined> = process.env): Metadata {
  const canonical = `${siteOrigin(env)}${path}`;
  const title = `${page.title} · ${SITE_NAME}`;
  return {
    title,
    description: page.desc,
    alternates: { canonical },
    openGraph: { type: "article", siteName: SITE_NAME, url: canonical, title, description: page.desc },
    twitter: { card: "summary_large_image", ...twitterSite(env), title, description: page.desc },
  };
}

/** The legal corpus's own entry point: its canonical is always `/legal/<slug>`. */
export function legalMetadata(slug: string, page: LegalPageCopy, env: Record<string, string | undefined> = process.env): Metadata {
  return staticDocMetadata(`/legal/${slug}`, page, env);
}
