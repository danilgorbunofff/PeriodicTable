/* The legal corpus (R16-1 … R16-14).
 *
 * This module is the whole of what the four documents say, as data: the route
 * (`app/legal/[slug]/page.tsx`) renders it, the sitemap lists its slugs, the
 * footer links them, and the checkout modal quotes the consent sentence out of
 * it. Copy lived inline in the route component before, which is why so much of
 * doc 16 had to be verified by reading the served HTML: nothing could be
 * imported and asserted against.
 *
 * It is deliberately dependency-free — no `node:crypto`, no `next` — because
 * both a server component and the client checkout modal import it. The version
 * stamps live here as hand-maintained revisions; the copy lock that fails when
 * the text changes without a bump is in `lib/legalContent.test.ts`.
 *
 * Two rules the prose below follows, because doc 16's findings were all one of
 * them being broken:
 *  - No sentence may claim something the code does not do (§5.4/§5.5 are the
 *    inventory; anything not in them is not said).
 *  - Anything the software cannot know — entity, address, jurisdiction, tax
 *    registration, refund window, retention maxima — is an operator value
 *    (`lib/operator.ts`) that renders as an explicit blank rather than as a
 *    plausible-sounding guess.
 */

import { LEGAL_REVISIONS, LEGAL_REVISION_LOG, SERVICE_TERM, type LegalSlug } from "./legal";
import { ANALYTICS_EVENTS } from "./analytics";

/* The corpus is deliberately independent of the environment: the operator's
 * identity and the card-statement descriptor are deployment configuration, and
 * they are injected at render time (`app/legal/[slug]/page.tsx` fills the
 * "Operator" section, the receipt prints the descriptor) rather than baked into
 * this text. That keeps `legalCanonicalText` — and the copy lock built on it —
 * a pure function of the words, not of whoever is running the suite. */

export type LegalSection = {
  h: string;
  ps: string[];
  /** Rendered after the paragraphs, bulleted. */
  bullets?: string[];
  /** Rendered after the bullets as a definition-ish list of labelled lines. */
  table?: { label: string; text: string }[];
};

export type LegalPage = {
  title: string;
  desc: string;
  sections: LegalSection[];
};

/** What "own" means, in one sentence (R16-10). Imported by the documents so the
 * vocabulary is defined once and quoted in both the About page and the rules. */
export const OWNERSHIP_SENTENCE =
  "\u201cOwn\u201d, \u201cown the element\u201d and \u201ccrown\u201d mean the top of that element's list until someone outbids you — a ranking on an advertising board, and nothing else: no property right in the element, in the site, or in any interest that can be sold, redeemed or inherited.";

/** What a stake buys (R16-10): the mechanical truth `lib/pricing.ts` enforces. */
export const STAKE_SENTENCE =
  "A stake is a one-time payment for a ranked advertising slot on one element. Rank is the total you have staked there; it is not equity, not a wager, and not a security — it cannot be transferred, sold or cashed out, and the slot ends when someone outbids you.";

/** §5.4 rows, as the privacy page states them: what is collected, why, and how
 * long it lives. Each row names the actual column(s) and the writer, because
 * "we may collect" copy is exactly what R16-2 was. */
export const PRIVACY_COLLECTED: { h: string; bullets: string[] }[] = [
  {
    h: "Identifying and listing data",
    bullets: [
      "The email you give at checkout (`Payment.email`) — used to send the receipt, the outbid notice, and to answer you about your own stake. No newsletter, no marketing list. Kept while the stake exists and afterwards as accounting evidence.",
      "The listing itself (`Startup.title`, `pitch`, `url`, `domain`, `logoUrl`) — the words and destination you chose to publish, which is why they are public. Kept while the listing is live.",
      "Waitlist entries (`WaitlistEntry.email`) when payments are gated — used once, to tell you when checkout opens. Kept until that notice is sent, then as an audit row (`AuditLog`).",
      "The manage link's email (`ManageToken.email`) — the address the management link was issued to. Kept for the life of the token.",
    ],
  },
  {
    h: "Payment data",
    bullets: [
      "Card details never reach us: they are entered on Stripe's own page. We store the amount, the currency Stripe reports, the status, the timestamps and Stripe's own session/charge reference (`Payment.providerRef`, `providerAmount`, `providerCurrency`, `status`, `paidAt`, `refundedAt`).",
      "We do not receive or store your billing address, your card number, or a city or country for the transaction — see \u201cWhat we publish\u201d below, which used to claim otherwise.",
      "Kept: as long as the listing exists, then as long as tax and dispute handling requires. We do not delete payment rows automatically, because a deleted row cannot answer a chargeback or an audit.",
    ],
  },
  {
    h: "Technical and abuse data",
    bullets: [
      "Clicks on a listing (`ClickEvent.ipHash`, `userAgent`) — the IP is stored as a salted SHA-256 hash, never in the clear, so it can count unique clicks and stop click fraud without identifying you. Kept with the stake it belongs to.",
      "Reports you file (`Report.reason`, `ipHash`) — the reason you typed and the same hashed IP, so a repeat reporter or an abuse wave is visible. Kept until the report is closed, then as evidence of the takedown decision.",
      "Mail we send (`EmailLog.to`, `subject`, `type`) and operator actions (`AuditLog.action`, `detail`, `actorRef`) — kept deliberately and indefinitely: they are the record of what was sent to whom and what was changed after a complaint. Our erasure sweep can remove a person from them on request (below).",
      "Rate-limit counters in Upstash Redis — when it is configured, a key derived from the request, with Redis' own expiry (minutes). Nothing durable.",
    ],
  },
];

/** §5.5 rows: every processor that is actually in the data path. The privacy
 * page renders this list verbatim, so adding a processor means editing one
 * array and the copy-lock digest. */
export const PRIVACY_PROCESSORS: { name: string; text: string }[] = [
  {
    name: "Stripe",
    text: "Payments, receipts and refunds — and, under Stripe's managed-payments terms, the merchant of record for the charge. Stripe sees your email, the charge and your payment instrument; we see the amount and Stripe's reference. `lib/stripe.ts`.",
  },
  {
    name: "Resend",
    text: "Sends our transactional email (receipt, outbid notice, waitlist confirmation, report notification) from `hi@periodictable.lol`. It processes the recipient address and the message body. `lib/email.ts`.",
  },
  {
    name: "Neon",
    text: "Hosts the Postgres database that holds every row listed above. `DATABASE_URL`.",
  },
  {
    name: "Vercel",
    text: "Hosts the site and runs the scheduled jobs, so it processes requests (including IP addresses in its own logs) on our behalf. `vercel.json`.",
  },
  {
    name: "Cloudflare",
    text: "Turnstile, the anti-bot check at checkout when it is enabled — it sees the checkout request and a browser fingerprint. It is never loaded on a page that is not checkout. `components/TurnstileWidget.tsx`.",
  },
  {
    name: "Google",
    text: "Its favicon service used to be called by your browser directly, on every page with a listing. It is not any more: our own server fetches the icon and serves it from this site (`/api/favicon`, R16-3), so what Google sees is our request, not yours.",
  },
  {
    name: "Microlink",
    text: "Turns a listed page into the screenshot we store as that listing's preview (`Startup.previewImgUrl`). Our servers call it, once per listing, never your browser. `lib/screenshots.ts`.",
  },
  {
    name: "Plausible",
    text: "Cookieless, aggregate page analytics. Disabled twice over: the operator has not set `NEXT_PUBLIC_PLAUSIBLE_DOMAIN`, and if it were set the script would only be injected after you accepted the notice — today it is off, so no analytics script is served and no request reaches them.",
  },
];

/** The one-line tax position (R16-4). Deliberately short: it states who charges,
 * who is the merchant of record, and that prices are tax-inclusive, which is the
 * part a buyer can check against their receipt. The registration question behind
 * it is an operator decision (D2). */
export const TAX_SENTENCE =
  "Prices are shown in US dollars and include any sales tax, VAT or similar tax that applies to your purchase where it applies. Stripe is the merchant of record for the charge: it determines and remits that tax, and it is the seller that appears on your card statement.";

/** Where a charge appears (R16-5). The *value* is deployment configuration and
 * is printed on the receipt, which is where a payer can compare it against a
 * statement; the documents state the mechanism, so the text here cannot go
 * stale while the payment account's descriptor changes. */
export const DESCRIPTOR_SENTENCE =
  "The charge appears on your card or bank statement under the exact descriptor printed in your receipt email \u2014 if you do not recognise it, that email is what identifies it. Write to the billing address on the contact page before opening a dispute, quoting the payment reference on the receipt.";

export const LEGAL_PAGES: Record<LegalSlug, LegalPage> = {
  about: {
    title: "About & disclaimer",
    desc: "What periodictable.lol is, how claiming an element works, and the disclaimers behind every paid listing on the table.",
    sections: [
      {
        h: "What this is",
        ps: [
          "periodictable.lol is an advertising leaderboard built on a live periodic table. Anyone can stake money to claim an element and put a startup's link on it: the current top spender on an element holds it, and their listing is displayed publicly on the table and in the leaderboards.",
          "Stakes are cumulative — your rank on an element is the total amount you have staked there, and the top-ranked listing holds the element until someone outbids them.",
          OWNERSHIP_SENTENCE,
        ],
      },
      {
        h: "Independence & no endorsement",
        ps: [
          "This site is an independent creative project. It is not affiliated with, endorsed by, or connected to IUPAC or any scientific body. Element names, symbols, and atomic numbers are used referentially to describe the layout of the table; all trademarks, logos, and brand names shown in listings belong to their respective owners.",
          "A listing on the table does not mean the listed company participates in, endorses, or is even aware of this site. Every link is submitted by whoever paid for it, with one exception: the operator's own launch inventory. A handful of seats were opened before launch, naming real companies and linking to their sites, so a stranger does not meet an empty table. Those seats were not paid for, not submitted, and not approved by the company named on them — the company is there because the seat exists, not because it agreed to anything, and it may not know the seat exists. A seat is a place on a leaderboard, not ownership, sponsorship, endorsement or awareness: any seat can be taken for a dollar over whatever it holds, and the operator releases any inventory seat nobody has paid for.",
          STAKE_SENTENCE,
        ],
      },
      {
        h: "Third-party links & content",
        ps: [
          "Listings point to third-party websites that we do not own, operate, or vet. We are not responsible for the content, products, safety, privacy practices, or accuracy of any linked site. Visiting a linked site is at your own risk — we display the destination domain on every row before you click.",
          "We do not pre-moderate listings, but we act on reports: any listing can be reported directly from its rank row, and we remove listings that violate our rules (see Rules & payments).",
        ],
      },
      {
        h: "No warranty & liability",
        ps: [
          "The site and all content are provided \"as is\" and \"as available\" without warranties of any kind, express or implied, including availability, accuracy, or fitness for a particular purpose. Figures shown on the table and leaderboards are informational and may lag or be incorrect during outages or maintenance.",
          "Nothing in these documents excludes or limits liability that cannot lawfully be excluded — including, for consumers, your statutory rights — and nothing here caps the operator's liability for fraud, wilful misconduct, or death or personal injury caused by negligence. Subject to that, we are not liable for indirect or consequential damages arising from your use of the site, including dealings between you and listed businesses or other users.",
        ],
      },
      {
        h: "Data, cookies and third parties",
        ps: [
          "We keep the minimum needed to run the leaderboard: the email and listing you give us, payment facts from Stripe, salted-hash click counts, your reports, our mail log, and our operator audit trail. The full inventory, with the purpose and the retention period of each item and every company we send it to, is on the Privacy page.",
          "We do not collect your city or country from your payment provider, and we do not show one. The city on a feed row was only ever written by the launch inventory, and it writes none now.",
          "No page of this site sets a cookie, and no third-party script or image is loaded by your browser on a normal page view: listing icons are fetched by our server and served from this domain, and analytics is off unless the operator turns it on. What is loaded, and when, is listed on the Privacy page.",
        ],
      },
      {
        h: "Operator",
        ps: [],
      },
      {
        h: "Changes",
        ps: [
          `These documents are versioned. This page is version ${LEGAL_REVISIONS.about}; the revision log below records what changed and when, and checkout quotes the version of the rules you accept.`,
        ],
      },
    ],
  },
  rules: {
    title: "Rules & payments",
    desc: "The $5 floor, takeover and reclaim maths, what may be listed, how Stripe payments and taxes work, why stakes are final, and how long the board is promised to run.",
    sections: [
      {
        h: "Who can participate",
        ps: [
          "You must be at least 18 years old (or the age of majority where you live) and able to form a binding contract. You may not stake on behalf of someone else's payment instrument without their permission. This is not for children, and payment is the age check: the checkout asks you to affirm it and records that you did.",
          "One listing per payment per element; you may hold several elements at once.",
        ],
      },
      {
        h: "What a stake is",
        ps: [STAKE_SENTENCE, OWNERSHIP_SENTENCE],
      },
      {
        h: "Bidding rules",
        ps: [
          "Floor: $5 — the minimum first stake on any unclaimed element, and the minimum for any new join on an already-claimed element. All amounts are in US dollars, whole numbers.",
          "Takeover: to become the top holder of an element that already has a #1, your total stake on that element must reach the current #1's total plus $1. You can stake any amount above the floor — outbidding by more than $1 is always allowed.",
          "Reclaim: if you previously staked on an element and were overtaken, the price to get back to #1 is (current #1 total + $1) minus what you already staked there, never less than $1. What you already staked there counts towards that total and never expires — it is a discount on your next stake on that element, not equity that can be sold, transferred or withdrawn.",
        ],
      },
      {
        h: "What you may list",
        ps: [
          "Links must be lawful and safe for a general audience. Prohibited: malware, phishing, scam or deceptive schemes, illegal goods or services, sexually explicit content, hate or harassment, content impersonating others, or anything that violates applicable law.",
          "We may remove or hide any listing that violates these rules or receives valid legal complaints, without refund (see below). We may also refuse or remove listings for trademark or right-of-publicity complaints from the actual rights holder.",
        ],
      },
      {
        h: "Payments, seller and taxes",
        ps: [
          "Payments are processed securely by Stripe, our payment partner. We never see or store your full card details. A stake is a one-time charge in USD; there are no subscriptions and no recurring billing.",
          TAX_SENTENCE,
          DESCRIPTOR_SENTENCE,
          "The seller of record for the charge is the payment partner named above; the operator of this site is the advertising publisher. Your receipt email repeats the payment reference, the amount and this descriptor, so a charge can be identified without contacting us.",
          "During launch, checkout may be gated to a waitlist — if the payment step shows a waitlist, that is expected and not an error.",
        ],
      },
      {
        h: "Refunds & disputes",
        ps: [
          "All stakes are final, and the checkout makes you acknowledge that before paying. A stake buys advertising inventory that is delivered immediately (your listing appears on the table and in leaderboards as soon as the payment settles), and it is bought for a named element, so we do not offer discretionary refunds, withdrawals, or cancellations — including if you are later outbid or if you change your mind. Nothing here removes a right to a refund that the law gives you and that cannot be waived; where a withdrawal right exists, asking for a slot in a live, ranked list before it is filled is the buyer's express request to begin performance immediately.",
          "If something went wrong with a payment, contact us before disputing the charge — the receipt carries the reference we need. If a payment is refunded (by us, or by your card issuer after a dispute), the stake behind it is reversed with it: the listing falls back to the previous holder and any leaderboard position it bought is lost. Chargebacks filed without first contacting us may result in the permanent removal of all your listings.",
          "You are responsible for any taxes arising from your purchase under your local law, other than the taxes the merchant of record collects and remits above.",
        ],
      },
      {
        h: "How long the board stays up",
        ps: [
          "Stakes in this game do not expire. A holder stays ahead on an element until someone outbids them, and being outbid consumes nothing: what was staked stays as a discount on that element that never expires, exactly as the Reclaim rule above says. Nobody's stake is running down while the board is up.",
          `The board itself is committed to run at least until ${SERVICE_TERM.until}. That is a minimum, not a deadline: if we extend it, the new date is published on this page and on the questions page, and until then the date here is the one that applies.`,
          `If the site ever does stop, we will say so on this page and by email to every current holder at least ${SERVICE_TERM.noticeDays} days beforehand. No further stakes are taken from the day that notice is published — the checkout is switched off rather than left running into a wind-down — and stakes already taken are not refunded, which is the same all-stakes-final rule as above, applied to the worst case. Listings and rankings go offline with the board.`,
          "The documents also say the site is provided as is and as available, so this section is a commitment about a date and about notice; it is not a warranty that the service will run for any particular period beyond the date it names, and it does not turn a stake into a security, a share or a claim on revenue.",
        ],
      },
      {
        h: "Changes",
        ps: [
          `We may update these rules as the product evolves. The version on this page is the one that applies; the revision log below is the announcement, and a material change gets a new version that checkout quotes before the next payment. This page is version ${LEGAL_REVISIONS.rules}.`,
        ],
      },
    ],
  },
  contact: {
    title: "Contact",
    desc: "Report a listing, file a copyright or trademark complaint, dispute a charge, or reach the team behind periodictable.lol.",
    sections: [
      {
        h: "Abuse, takedowns & rights complaints",
        ps: [
          "Fastest path: use the report button (⚑) on any rank row — it goes straight to our moderation queue with the listing attached, no account needed.",
          "We are not a service provider with a designated copyright agent; we are a small site whose listings are submitted by the advertisers themselves, and we act on complaints the same way we act on reports. Email abuse@periodictable.lol (or use the report button) with: (1) the element and listing domain, (2) the URL of the content you believe is infringed or unlawful, (3) your contact details, and (4) a statement of your good-faith belief and your authority to act for the rights holder.",
          "A complete complaint is actioned within 72 hours: the listing can be hidden pending review, and we tell you what we did. The promise is kept where it can be checked — the operator's own status report shows the age of the oldest open report, so a queue that is falling behind is visible rather than remembered.",
        ],
      },
      {
        h: "Payment & billing issues",
        ps: [
          "For a failed, duplicated, or incorrect charge, email payments@periodictable.lol. Include the payment reference from your receipt email (or the date, amount and last four digits of the card), and the email address you paid with. We can only discuss billing details with the payer, and those four facts are what let us confirm you are the payer without asking for anything sensitive.",
          DESCRIPTOR_SENTENCE,
        ],
      },
      {
        h: "Everything else",
        ps: [
          "Anything that does not fit the headings above goes to hi@periodictable.lol. That is also the address this site's own mail is sent from — receipts, outbid notices, confirmation links — so replying to one of those reaches a person rather than a no-reply box (R19-7).",
          "Press, partnerships, and general questions: hello@periodictable.lol. These are plain mailboxes with no ticket system behind them: we aim to reply within 2–3 business days, and if a week passes, send it again rather than assuming it arrived.",
          "Privacy requests (access, correction, deletion) go to privacy@periodictable.lol; the Privacy page describes what we can do and how long it takes.",
          "Postal address for legal correspondence, service of process and complaints: see the operator details on the About page.",
        ],
      },
    ],
  },
  privacy: {
    title: "Privacy & data",
    desc: "Every category of data periodictable.lol collects, why, which companies process it, how long it is kept, and how to have it deleted.",
    sections: [
      {
        h: "Who is responsible",
        ps: [
          "The operator of periodictable.lol is the data controller for everything described here. The operator's identity, address and jurisdiction, and the law that governs these documents, are stated on the About page and configured in the deployment — where a value has not been supplied it is shown as unpublished rather than guessed.",
          "Privacy requests, including deletion: privacy@periodictable.lol. We answer within 30 days, and we can ask you to prove you control the email address a record belongs to.",
        ],
      },
      {
        h: "What we collect, why, and for how long",
        ps: [
          "Nothing below is inferred or enriched. There is no advertising network, no cross-site tracking, no data broker, and we do not sell or rent personal data to anyone.",
        ],
        bullets: PRIVACY_COLLECTED.flatMap((c) => c.bullets),
      },
      {
        h: "What we publish",
        ps: [
          "The table, the leaderboards, the element pages and the live feed are public by design. Published: your listing's title, pitch, destination URL, domain and icon; the element it holds; the amount and the time of the stake; aggregate click counts; and the element's running totals.",
          "Never published: your email address, your payment reference, your card details, your reports, or the hashed IP behind a click. Row-level click logs are visible only to the operator.",
          "The city on a feed row was only ever written by the launch inventory for its own rows, and it writes none now. We never receive a city or a country from Stripe, and no real settlement writes one — if a city appears on a row, it is a bug; tell us and we will fix it.",
        ],
      },
      {
        h: "Cookies, storage and analytics",
        ps: [
          "This site sets no cookies of its own and uses no local storage to track you. Session state that the product needs (which modal is open, which element you clicked) lives in memory and is gone when you close the tab.",
          "Analytics is off in production, and while it is off you are not asked to consent to anything, because there is nothing to consent to: no banner, no script, no request to Plausible. If the operator enables it, it is cookieless and aggregate — no personal identifiers, no cross-site profile — and it still does not load until you say yes: that switch displays a notice, the script is injected only after you accept it, and declining is remembered and loads nothing. A visitor who never answers makes no request to Plausible at all. This paragraph and the processor list below are updated in the same revision as the code, because a disclosure that lags a script is not a disclosure.",
          "Our lawful basis for the analytics processing (which today is nothing, because the script is not served) is legitimate interest in knowing which parts of a small public site are used at all; the data is aggregate and cookieless, so there is no personal identifier to consent to. We would rather not lean on that reading with a script running, so it stays off until the operator decides otherwise and writes the decision here.",
          `If it is ever switched on, this is the complete list of what gets counted, and it is generated from the same constant the code sends (${ANALYTICS_EVENTS.map((e) => `\u201c${e}\u201d`).join(", ")}), plus an aggregate pageview count. Nothing else is sent: no form contents, no email address, no element you did not click.`,
        ],
      },
      {
        h: "Requests your browser makes to other companies",
        ps: [
          "On a normal page view: none. Listing icons are fetched by our server from Google's favicon service and served from this domain, so Google sees our request rather than yours, and it does not learn which pages you read. That fetch is the reason a listing icon cannot finger you: the proxy is the only thing that ever talks to the icon service, and it asks for a domain, never for who is reading it.",
          "Three exceptions, all deliberate and all conditional. Checkout, when the anti-bot check is enabled, loads Cloudflare's Turnstile widget — a challenge has to run in your browser to work. Paying takes you to Stripe's own checkout page, which is Stripe's product, under Stripe's privacy notice. And analytics, when the operator has enabled it *and* you accepted its notice, loads one cookieless script from Plausible — that switch is the `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` build variable, it is unset today, nothing loads without the notice, and the section above lists what it would measure. Listing screenshots are captured by our servers, so nothing is loaded from the screenshot provider while you browse.",
        ],
      },
      {
        h: "Companies that process data for us",
        ps: [
          "Each of these is a processor acting on our instructions; none of them is allowed to use the data for their own advertising. This list is the complete set — if a processor is added, it appears here in the same revision as the code.",
        ],
        bullets: PRIVACY_PROCESSORS.map((p) => `${p.name} — ${p.text}`),
      },
      {
        h: "Retention, and how to have data deleted",
        ps: [
          "Listing and profile data lives as long as the listing does. Payment rows are kept while the stake exists and afterwards for as long as tax, accounting and dispute handling require; we do not delete them automatically, because a deleted row cannot answer a chargeback. Click hashes live with the stake. Rate-limit keys expire in minutes. The mail log and the operator audit trail are kept indefinitely and deliberately: they are the record of what was sent and what was changed after a complaint.",
          "You can ask for deletion at any time. The operator runs a documented erasure sweep that scrubs a person out of the mail log, the audit trail, the waitlist, reports and the click log, and reports exactly what it scrubbed and what it deliberately left; payment rows required for tax or an open dispute are the one thing that can be left in place, and you are told when that happens. Records that cannot be erased without breaking the leaderboard's own accounting are de-identified rather than deleted.",
          "If you are in the UK, EEA or Switzerland, you also have the right to object to processing, to ask for a copy of your data in a portable form, and to complain to your national supervisory authority. We are not established in the EU/EEA, so the practical route for those requests is the mailbox above.",
        ],
      },
      {
        h: "Security",
        ps: [
          "IP addresses are stored only as a salted hash, and the salt never leaves the server. Card data never touches us. Operator surfaces are token-gated. Secrets are deployment configuration, not code.",
        ],
      },
      {
        h: "Children",
        ps: [
          "This service is for adults: the rules require you to be 18 or over (or the age of majority where you live), and that is affirmed at checkout. If we learn a payment was made by a child, we reverse the listing and refund on request — write to privacy@periodictable.lol.",
        ],
      },
      {
        h: "Changes",
        ps: [
          `This page is version ${LEGAL_REVISIONS.privacy}. Material changes get a new version, recorded in the revision log, and the checkout quotes the version of the rules in force at the moment you tick the box — so the version you agreed to is the one on your payment record.`,
        ],
      },
    ],
  },
};

/** The sections of a document as they are rendered. The "Operator" section is
 * the one empty placeholder in the static corpus: it is filled here from
 * deployment configuration (R16-11), so the operator's identity and address
 * appear on the page, or appear as explicit blanks. */
export function legalSections(slug: LegalSlug, operatorLines: string[]): LegalSection[] {
  return LEGAL_PAGES[slug].sections.map((s) => (s.h === "Operator" ? { ...s, ps: operatorLines } : s));
}

/** The canonical text of a document — what the copy lock in
 * `lib/legalContent.test.ts` digests, and what the page renders. Pure string
 * assembly, so a test can recompute it without rendering React. */
export function legalCanonicalText(slug: LegalSlug): string {
  const page = LEGAL_PAGES[slug];
  const parts: string[] = [page.title, page.desc, `version ${LEGAL_REVISIONS[slug]}`];
  for (const s of page.sections) {
    parts.push(s.h, ...s.ps, ...(s.bullets ?? []));
  }
  for (const r of LEGAL_REVISION_LOG[slug]) parts.push(r.version, r.note);
  return parts.join("\n");
}
