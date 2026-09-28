/* The legal corpus' browser-facing half.
 *
 * The four documents themselves are prose and live in `lib/legalDocs.ts`, which
 * only the legal route and the test suite import. What is here is the handful of
 * facts a *client* component legitimately needs — the slugs, the one contact
 * mailbox, the nav links, the service term the rules and the price ladder both
 * quote, and the sentence the checkout checkbox affirms — kept in a module small
 * enough that importing it does not pull the whole corpus into a browser bundle.
 *
 * Nothing here is printed as a revision. The documents have no version stamp and
 * no change log; what remains is the *record*: the words shown at checkout are
 * displayed from this module and hashed on the server, and the date below is what
 * a recorded consent is measured against, so a payment can be tied to the wording
 * it was made under without any page telling a visitor which revision they read.
 */

export const LEGAL_SLUGS = ["about", "rules", "contact", "privacy"] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

/**
 * How long the board is promised to run (R20-15, decided 2026-09-16).
 *
 * The register's finding was a one-sided silence: the rules described stakes as
 * permanent and final while nothing anywhere said what happens to them if the
 * service stops. The operator's answer is a floor, not a promise of forever —
 * the board runs at least until this date, an extension is announced here, and a
 * stop gets notice first — and it lives in one constant because three surfaces
 * state it: the rules document, the FAQ and the price ladder on every element
 * page. A date written down three times is a date that disagrees with itself;
 * `lib/postLaunch.test.ts` asserts the three read this one.
 */
export const SERVICE_TERM = {
  /** The date as printed. */
  until: "9 September 2027",
  /** The same date in ISO form, for anything that sorts or diffs. */
  iso: "2027-09-09",
  /** Days of notice promised before the board is switched off. */
  noticeDays: 30,
} as const;

/** The permanence sentence, printed where a buyer is deciding: stakes do not run
 *  down, and the board has a stated floor. Both halves are load-bearing and
 *  neither replaces the other — the design's "a stake never expires" is the
 *  buyer's best fact, and an unbounded promise is one nobody could keep. */
export const SERVICE_TERM_SENTENCE = `Stakes never expire, and the board is committed to run at least until ${SERVICE_TERM.until}.`;

/**
 * The date the published documents last changed.
 *
 * Nothing prints this. It exists for the two places that genuinely need to know
 * the wording moved without publishing a revision log: the sitemap's `lastmod`,
 * and `CONSENT_VERSION`, which is stored on a payment so the checkout can refuse
 * an attestation quoting older words. Bump it whenever a publishable word in
 * `lib/legalDocs.ts` changes — the digest in `lib/legalContent.test.ts` fails the
 * suite if you forget.
 */
export const LEGAL_UPDATED = "2026-09-28";

/** The wording a stake is bought under — stored with a payment, sent by the
 * checkout modal, and compared by the checkout route. Never rendered. */
export const CONSENT_VERSION = LEGAL_UPDATED;

/** Every legal document, in the order the nav lists them. `components/FooterBar.tsx`,
 * the 404/error chrome (`lib/boundaries.ts`) and the document footers all render
 * this list, so a fourth document cannot be reachable from one and missing from
 * the others — which is exactly how the privacy page came to be missing before
 * this pass. `short` is the one-word form the footer pill uses; four full labels
 * do not fit on one line at 320px, and a wrapped pill would sit further up the
 * board than the layout reserves for it. */
export const LEGAL_LINKS = [
  { href: "/legal/about", label: "About & disclaimer", short: "About" },
  { href: "/legal/rules", label: "Rules & payments", short: "Rules" },
  { href: "/legal/privacy", label: "Privacy & data", short: "Privacy" },
  { href: "/legal/contact", label: "Contact", short: "Contact" },
] as const;

/** The only published mailbox. It is a constant because five surfaces have to
 * name the same address: the contact page, the privacy page's controller line,
 * the receipt's billing line, the `From:` header on outbound mail, and the
 * fallback recipient for a report notification. A mismatch between any two of
 * them is how a payer ends up disputing a charge instead of asking about it. */
export const SUPPORT_EMAIL = "info@periodictable.lol";

/** The sentence the buyer affirms at checkout. Rendered verbatim — with the
 * `CONSENT_LINK_TEXT` words linked — and hashed into `lib/consent.ts`, so the
 * words shown and the words recorded cannot drift (R16-6, R16-7). Short on
 * purpose: finality and what a stake buys live in the rules the link points
 * to, so repeating them here doubles the agreement rather than strengthening
 * it. */
export const CONSENT_STATEMENT =
  "I am 18+ and I accept the rules & terms.";

/** The linked words inside `CONSENT_STATEMENT`, and where they point. */
export const CONSENT_LINK_TEXT = "rules & terms";
export const CONSENT_LINK_HREF = "/legal/rules";
