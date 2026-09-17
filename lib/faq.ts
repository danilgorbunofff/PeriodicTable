/* R19-4: where the FAQ is, what it is called, and when it was last written.
 *
 * Deliberately *not* an entry in `LEGAL_LINKS` (R19-4's first instinct) and not
 * a fifth `LEGAL_SLUGS` document: the corpus is exactly four documents, pinned
 * by `lib/legalContent.test.ts` and by the footer pill's one-line sizing, and a
 * page whose answers change without a revision bump would make the corpus's own
 * copy lock weaker rather than stronger. So the FAQ is a static route with its
 * own copy, its own date, and this module holding the three facts a client
 * component may need.
 */

export const FAQ_PATH = "/faq";

export const FAQ_LABEL = "Questions & answers";

/** The one-word form, for the places the four legal labels already fill. */
export const FAQ_SHORT = "FAQ";

/** Printed on the page and used as the sitemap's `lastModified` (R01-5): for a
 * static page the honest stamp is the date the words changed. */
export const FAQ_REVISED = "2026-09-18";
