/**
 * What a shared link to the board shows (R01-1, R01-4).
 *
 * `app/page.tsx` is a client component and cannot export metadata, so the home
 * card's tags live in the root layout. They are declared here rather than
 * inline so the acceptance checks in lib/shareMeta.test.ts can read the object
 * the app actually ships: a link that unfurls as a bare URL is invisible in dev
 * and only shows up in someone else's timeline.
 */
import type { Metadata } from "next";
import { OG_CARD } from "./ogCard";
import { siteOrigin } from "./siteUrl";

const DESCRIPTION = "Every element is an open leaderboard, ranked by total stake.";
const CARD_TITLE = "periodictable.lol — put your startup on the table";
const IMAGE_ALT = "periodictable.lol — put your startup on the table";

export function homeMetadata(env: Record<string, string | undefined> = process.env): Metadata {
  const origin = siteOrigin(env);
  return {
    // Absolute here, so the tags carry one host even where metadataBase cannot
    // resolve (robots, sitemap and canonicals read the same helper).
    metadataBase: new URL(origin),
    title: "periodictable.lol — Put your startup on the table. Literally.",
    description: DESCRIPTION,
    // The board is `/`; `/?el=H` is the same document, so it folds here (R01-4).
    // Routes that own their identity set their own canonical.
    alternates: { canonical: "/" },
    openGraph: {
      type: "website",
      siteName: "periodictable.lol",
      url: "/",
      // Declared, not inherited: the document title carries SEO copy and may
      // later gain a `%s` template, which a card must never render.
      title: CARD_TITLE,
      description: DESCRIPTION,
      images: [{ url: `${origin}/og/home`, width: OG_CARD.width, height: OG_CARD.height, alt: IMAGE_ALT }],
    },
    twitter: {
      card: "summary_large_image",
      ...twitterSite(env),
      title: CARD_TITLE,
      description: DESCRIPTION,
      images: [`${origin}/og/home`],
    },
  };
}

/**
 * The `twitter:site` tag for a card, or nothing at all (R19-9).
 *
 * A share credits an account only if one exists. `NEXT_PUBLIC_TWITTER_HANDLE` is
 * the single place a handle is configured: set it at T-0 in Vercel and every
 * card credits the account that posted the link; leave it unset and the tag is
 * omitted rather than rendered empty or pointed at a handle nobody owns (which
 * would credit a stranger on every share). Element pages and the legal shell
 * spread this too, so one variable names the channel everywhere.
 */
export function twitterSite(
  env: Record<string, string | undefined> = process.env
): { site: string } | Record<string, never> {
  const handle = env.NEXT_PUBLIC_TWITTER_HANDLE?.trim();
  if (!handle) return {};
  return { site: handle.startsWith("@") ? handle : `@${handle}` };
}
