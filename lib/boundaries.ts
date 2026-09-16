/**
 * Copy and routes for the surfaces a visitor lands on when the thing they asked
 * for is not there (R02-1, R02-2) or fails to render (R02-3).
 *
 * A 404 used to be Next's stock black-on-white page: no wordmark, no legal nav,
 * no way back into the product. The copy lives here rather than inline because a
 * boundary is the one screen nobody looks at until it is the only thing on
 * screen — so the phrases the review pins ("could not be found"), the legal
 * links and the retry label are assertable in lib/boundaries.test.ts.
 */

import { LEGAL_LINKS } from "./legal";

/** The same four documents the legal pages link to each other, and the same
 *  ones components/FooterBar.tsx lists. Defined in lib/legal.ts and re-exported
 *  here so the 404 and the error boundaries cannot drift from the footer — or
 *  omit a document, which is how `/legal/privacy` used to be unreachable. */
export { LEGAL_LINKS };

export const HOME_LINK = "← Back to the table";

/** `notFound()` from a route, and every unmatched URL, render here. */
export const NOT_FOUND = {
  eyebrow: "404",
  // The acceptance check greps a served 404 body for this phrase (02 §8).
  heading: "That page could not be found.",
  body:
    "The link may be old, or the address may have a typo. Nothing is served here — and no element, stake or price is ever hidden behind a broken link.",
} as const;

/** Route-level boundary: the page threw while rendering, the shell survived. */
export const ROUTE_ERROR = {
  eyebrow: "Something broke",
  heading: "This page could not be drawn.",
  body:
    "Part of the app failed while rendering this page, not while saving anything — the table is still intact. Trying again is safe; if it keeps happening, the contact page has our address.",
  retry: "Try again",
} as const;

/** Root boundary: it replaces the root layout, so it carries its own <html>. */
export const GLOBAL_ERROR = {
  eyebrow: "Something broke",
  heading: "periodictable.lol could not load.",
  body:
    "The app failed before this page could render. Nothing about your account or a payment changed here. Reloading is safe; if it keeps happening, the contact page has our address.",
  retry: "Reload the app",
} as const;
