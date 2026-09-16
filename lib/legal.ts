/* The legal corpus' browser-facing half (R16-1, R16-6, R16-11).
 *
 * The four documents themselves are prose and live in `lib/legalDocs.ts`, which
 * only the legal route and the test suite import. What is here is the handful of
 * facts a *client* component legitimately needs — the slugs, each document's
 * revision, the nav links, and the sentence the checkout checkbox affirms — kept
 * in a module small enough that importing it does not pull the whole corpus into
 * a browser bundle.
 *
 * The split exists for one reason: the version a payer agreed to has to be the
 * version the document printed, and the words recorded have to be the words
 * shown. Both are only true if there is exactly one definition of each, shared
 * by the server that records it, the page that prints it, and the modal that
 * displays it.
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
 * The revision of each document, as it appears in the printed stamp, the
 * revision log and the consent record. Bump it whenever the copy changes: the
 * digest in `lib/legalContent.test.ts` fails the suite if you don't, and the
 * checkout refuses an attestation that quotes an older revision (R16-7).
 */
export const LEGAL_REVISIONS: Record<LegalSlug, string> = {
  about: "2026-09-16",
  rules: "2026-09-16",
  contact: "2026-09-16",
  privacy: "2026-09-16",
};

/** The revision a stake is bought under — the value printed next to the
 * checkbox, sent with the payment, stored on it and printed on the receipt. */
export const CONSENT_VERSION = LEGAL_REVISIONS.rules;

/** Dated revision log per document — the only announcement surface there was
 * (§5.7 found none). A material change is a new entry here plus a bumped
 * `LEGAL_REVISIONS` value, which the checkout's version check then enforces. */
export const LEGAL_REVISION_LOG: Record<LegalSlug, { version: string; note: string }[]> = {
  about: [
    { version: "2026-09-16", note: "The data paragraph was corrected: it described a city/country we never collect, and listed one processor out of seven. The independence clause now says the seeded demo listings were never paid for, so neither their stake nor their city is real." },
  ],
  rules: [
    { version: "2026-09-16", note: "Revised the same day to publish a minimum service term (R20-15): the board is committed to run at least until 9 September 2027, a later date is published here rather than assumed, a stop gets 30 days' notice on this page and by mail to every current holder with the checkout switched off, and the stakes already taken are not refunded. The same section states the permanence the design always assumed and no page said (R20-14): a stake never expires, and an outbid holder's value does not expire with it." },
    { version: "2026-09-16", note: "Named the seller and the statement descriptor, published the tax position, defined what a stake buys, and versioned the document." },
  ],
  contact: [
    { version: "2026-09-16", note: "Revised the same day to publish hi@periodictable.lol, the address this site's own mail is sent from: the sender header, the receipts and the outbid notices all used it while no page named it, so a reply had nowhere to land (R19-7)." },
    { version: "2026-09-16", note: "Replaced the copyright/DMCA heading with the process that actually runs, and said what a billing request must contain." },
  ],
  privacy: [
    { version: "2026-09-16", note: "First published. Every category, processor and retention period was taken from the schema and the writers, not from intent. Revised the same day to describe the analytics consent gate (R18-13): the switch used to be the same thing as the collection, and it now says the script loads only after a notice is accepted, so a visitor who never answers makes no request to Plausible." },
  ],
};

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

/** The mailboxes the product publishes (R19-7). They are constants because the
 * receipt has to name the same billing address the contact page does — a
 * mismatch there is how a payer ends up disputing a charge instead of asking
 * about it. `hi` is the odd one out and is listed here on purpose: it is the
 * address outbound mail is sent from, and until phase 19 it was published
 * nowhere, so a recipient reading the `From:` line had no page telling them
 * what it was. The legal corpus now names it and `/faq` repeats it. */
export const SUPPORT = {
  billing: "payments@periodictable.lol",
  abuse: "abuse@periodictable.lol",
  privacy: "privacy@periodictable.lol",
  hello: "hello@periodictable.lol",
  hi: "hi@periodictable.lol",
} as const;

/** The receipt's tax line (R16-4). The checkout adds no tax — prices are the
 * full amount charged — so this is a statement of fact, not a preference.
 *
 * The invariant behind it: if tax collection is ever enabled (Stripe's
 * `automatic_tax`, a rate table, anything that adds to the total), this line and
 * the receipt's amount are both wrong until `Payment` grows tax columns and the
 * checkout writes them. Nothing else in the receipt may claim a tax figure the
 * database does not have. */
export const RECEIPT_TAX_LINE = "No tax was added to this charge.";

/** Everything the receipt says about the transaction as a legal document
 * (R16-4, R16-5, R16-7, R16-11): who sold it, what the card statement shows,
 * the tax position and registration, which revision of the rules the payer
 * accepted and when, the payment reference, and where to write before
 * disputing. Assembled by `receiptLegal()` in `lib/operator.ts`, which is where
 * the deployment's configured values enter; every field is nullable because a
 * receipt must omit an unknown value rather than print a blank as a fact. */
export type ReceiptLegal = {
  /** "Legal entity, established in X" — omitted when the operator is unset. */
  seller: string | null;
  /** What the card statement shows. Omitted when unset or not a descriptor
   * Stripe would accept, since printing a value the processor rewrites is
   * worse than printing nothing. */
  descriptor: string | null;
  taxLine: string;
  taxId: string | null;
  rulesVersion: string;
  rulesUrl: string;
  /** The day consent was recorded, or null for a payment that predates the
   * record (R16-6) — in which case the receipt does not claim one. */
  rulesAcceptedAt: string | null;
  reference: string | null;
  billing: string;
};

/** The sentence the buyer affirms at checkout. Rendered verbatim — with the
 * `CONSENT_LINK_TEXT` words linked — and hashed into `lib/consent.ts`, so the
 * words shown and the words recorded cannot drift (R16-6, R16-7). */
export const CONSENT_STATEMENT =
  "I am 18+ and I own or may promote this URL. I accept the rules & terms — including that a top-up is final (no refunds or withdrawals) and that I am buying advertising, not a bet or an investment.";

/** The linked words inside `CONSENT_STATEMENT`, and where they point. */
export const CONSENT_LINK_TEXT = "rules & terms";
export const CONSENT_LINK_HREF = "/legal/rules";
