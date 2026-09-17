/* The legal corpus: the whole of what the four published documents say, as data.
 *
 * The route renders it, the sitemap lists its slugs, the footer links them, the
 * checkout modal quotes the consent statement out of `lib/legal.ts`, and the FAQ
 * may summarise it but never contradict it.
 *
 * Three rules the prose follows:
 *  - No sentence may claim something the code does not do.
 *  - Only one contact point is published anywhere: the mailbox in `lib/legal.ts`.
 *    No other operator detail is named here, and nothing is claimed about a
 *    company, address or jurisdiction that this deployment does not hold.
 *  - Any number printed here is imported from the module that owns it, so the
 *    copy and the product cannot drift apart.
 *
 * The documents are not versioned and carry no change log: the words on these
 * pages are the words that apply. `lib/legalContent.test.ts` digests each page so
 * that editing one is a deliberate act, and `lib/consent.ts` hashes the sentence
 * the checkout shows so a payment still records which wording it was made under.
 *
 * They are also deliberately short: one section per question a reader actually
 * asks, and no sentence that repeats one already made. Cutting a paragraph here
 * means folding its content into a neighbour, never dropping a commitment — the
 * dates, the floor, the refund position and the processor list are the parts a
 * buyer or a regulator would be entitled to hold this site to.
 */

import { ANALYTICS_EVENTS } from "./analytics";
import { SERVICE_TERM, SUPPORT_EMAIL, type LegalSlug } from "./legal";

export type LegalSection = {
  h: string;
  ps?: string[];
  bullets?: string[];
  table?: { label: string; value: string }[];
};

export type LegalPage = { title: string; desc: string; sections: LegalSection[] };

/** The one sentence that says what holding an element is not. The FAQ imports it
 * rather than paraphrasing, so the two surfaces cannot drift. */
export const OWNERSHIP_SENTENCE =
  "Holding an element is the top advertisement on that element and nothing else: not equity or ownership in this site, not a security or an investment, not a claim on revenue, not a patent, trademark or domain right, not a licence, and not a transferable asset. It is a rank that lasts until someone stakes more, and it can be taken at any moment for a dollar over whatever the holder has staked there.";

/** The one sentence that says why a rank can move. Same treatment as
 * `OWNERSHIP_SENTENCE`: quoted, not paraphrased. */
export const STAKE_SENTENCE =
  "Because a stake is always public and the top amount always beatable, an element that is held today can be taken tomorrow: nothing here is a permanent claim to a tile.";

/** The three groups of collected data, rendered as three sections of the privacy
 * page. Retention lives with each item, so a reader gets the purpose and the
 * window in one line. */
export const PRIVACY_COLLECTED: { h: string; bullets: string[] }[] = [
  {
    h: "The listing you bought",
    bullets: [
      "Your email address, so the receipt can reach you and a holder can be told when someone outbids them. Kept until the listing ends — do not stake with an address you would mind losing access to.",
      "The listing itself: the title, the one-line pitch, the domain shown on the row, and the destination a click is sent to. Public by design — it is the product — and kept while the listing is on the board.",
      "Clicks, counted into a total on the row, with no IP address or user agent stored next to one and no per-visitor history to build a profile from.",
    ],
  },
  {
    h: "Payment facts shared by the payment partner",
    bullets: [
      "The payment reference, the amount, the currency, the card brand and the last four digits, the outcome and the time of the charge. Kept with the payment as the record of a sale — it is what answers \"what is this charge?\" and what a dispute is decided on.",
      "A withdrawal, reversal or refund is recorded against the same row rather than deleting it, which is why the row survives after a listing is replaced.",
    ],
  },
  {
    h: "Safety, abuse and operations",
    bullets: [
      "The site's own security check records the hash of an address for a short window, never the address itself, so repeated checkout attempts can be rate-limited without keeping a list of who visited.",
      "Reports you send, and the mail log used to send them: the address a message was sent to and whether it went out. Kept for 30 days after sending, then dropped.",
      "The operator's audit trail — a listing removed, a report actioned, a stake reversed — kept as long as needed to explain a decision if it is challenged, and deliberately free of unnecessary personal data.",
    ],
  },
];

/** Every organisation that touches the data described above.
 * `lib/legalContent.test.ts` checks that each name is on the page that says
 * whether it is a controller or a processor, so the list cannot go stale
 * silently. */
export const PRIVACY_PROCESSORS: { name: string; role: string; text: string }[] = [
  {
    name: "Stripe",
    role: "processor, and seller of record for the charge",
    text: "Payments, receipts and reversals. Stripe is the merchant of record: it sees your email address, the charge and your payment instrument, decides the tax position and remits the tax. We see the amount and the reference it gives us.",
  },
  {
    name: "Resend",
    role: "processor",
    text: "Sends transactional email from our own domain — the receipt, an outbid notice, a confirmation link, a report notification — processing the recipient address and the message body to deliver it.",
  },
  {
    name: "Neon",
    role: "processor",
    text: "Hosts the database that holds every row described above.",
  },
  {
    name: "Vercel",
    role: "processor",
    text: "Hosts the site and runs the scheduled jobs, so it processes requests — including IP addresses in its own logs — on our behalf.",
  },
  {
    name: "Cloudflare",
    role: "processor",
    text: "Turnstile, the anti-bot check on checkout when it is enabled: it sees the checkout request and a browser fingerprint, and it is mounted nowhere else.",
  },
  {
    name: "Google",
    role: "processor, for site icons only",
    text: "Its favicon service was once called by the browser directly on every page carrying a listing. Not any more: our own server fetches the icon and serves it from this site through a proxy, so Google sees our request rather than the browser speaking for a visitor.",
  },
  {
    name: "Microlink",
    role: "processor, for listing screenshots only",
    text: "Turns a listed page into the preview image stored with that listing, called once per listing by our servers and never by the browser, so a visitor's IP address never reaches a third party.",
  },
  {
    name: "Plausible",
    role: "processor, for analytics only",
    text: "Product analytics for the operator, off in production unless the operator switches it on: cookieless and IP-anonymising, reporting counts rather than people, holding one device's history for 24 hours at most, and not loaded unless a visitor says yes.",
  },
];

/** The one-line tax position. Deliberately short: it states who charges, who is
 * the seller of record and that prices are tax-inclusive, which is the part a
 * buyer can check against their receipt. */
export const TAX_SENTENCE =
  "Prices are shown in US dollars and include any sales tax, VAT or similar tax that applies to your purchase where it applies. Stripe is the merchant of record for the charge: it determines and remits that tax, and it is the seller that appears on your card statement.";

/** Where a charge appears. The descriptor *value* is deployment configuration and
 * is printed on the receipt, which is where a payer can compare it against a
 * statement; this sentence states the mechanism, so it cannot go stale while the
 * payment account's descriptor changes. */
export const DESCRIPTOR_SENTENCE =
  "The charge appears on your card or bank statement under the exact descriptor printed in your receipt email — if you do not recognise it, that email is what identifies it. Write to the mailbox on the contact page before opening a dispute, quoting the payment reference on the receipt.";

export const LEGAL_PAGES: Record<LegalSlug, LegalPage> = {
  about: {
    title: "About & disclaimer",
    desc: "What periodictable.lol is, how holding an element works, who runs it, and the disclaimers behind every listing on the table.",
    sections: [
      {
        h: "What this is",
        ps: [
          "periodictable.lol is an advertising leaderboard on a live periodic table. Anyone can pay to hold an element and put a link on it: the top spender on an element holds it, and their listing appears on the table, the element's own page and the leaderboards.",
          OWNERSHIP_SENTENCE,
        ],
      },
      {
        h: "How a seat is won",
        ps: [
          "An empty element costs $5. After that the price is set by whoever holds it: to take an element you have to beat the current holder's total by $1. One holder per element, one listing per payment, and what you have already staked on an element counts towards your next stake there — a discount that never expires, not a balance that can be withdrawn. Your row shows the domain you name and the destination you choose, and the rank moves when someone outbids you.",
          STAKE_SENTENCE,
        ],
      },
      {
        h: "Launch inventory, and no endorsement",
        ps: [
          "A handful of seats were opened by the operator before launch, naming real companies and linking to their sites, so a visitor does not meet an empty table. Those seats were not paid for and not approved by the company named on them, which may not know the seat exists. Any of them can be taken for a dollar over what it holds, and any inventory seat nobody has paid for is released by the operator.",
          "This site is an independent project, not affiliated with, endorsed by, sponsored by or connected to the companies listed on it, or to IUPAC or any other scientific body. Element names, symbols and atomic numbers describe the layout of a table; trademarks, logos and brand names belong to their owners.",
          "On the icons: listing icons are fetched by our server, never by the browser — they are served from this domain, so no icon service learns which pages a visitor reads, and screenshots are captured the same way. What is collected, and by whom, is on the privacy page.",
        ],
      },
      {
        h: "Third-party links",
        ps: [
          "Listings point to websites we do not own, operate or vet. We are not responsible for their content, products, safety, privacy practices or accuracy, and following a link is at your own risk — the destination domain is printed on the row before it is clicked.",
          "Nothing is reviewed before it appears, but reports are acted on: every row opens the listing's own page, and that page reports it. Rules & payments sets out what may be listed, and what happens when it may not be.",
        ],
      },
      {
        h: "Who runs this",
        ps: [
          `This site is run by one person. The only way to reach them is the mailbox on the contact page (${SUPPORT_EMAIL}); no company, telephone number or postal address is published, and that is a decision rather than an omission.`,
        ],
      },
    ],
  },
  rules: {
    title: "Rules & payments",
    desc: "The $5 floor, how to take an element, what may be listed, how payment and tax work, why every stake is final, and how long the board runs.",
    sections: [
      {
        h: "Who can participate, and what a stake buys",
        ps: [
          "You must be 18 or over, or the age of majority where you live, and able to enter into a binding contract. Pay only with a payment instrument you are authorised to use: staking with someone else's card without their permission breaches these rules. The checkout asks you to confirm this and records that you did.",
          "One listing per payment, per element. You may hold as many elements as you like, and you may stake on an element you already hold to push its price up.",
          STAKE_SENTENCE,
          OWNERSHIP_SENTENCE,
        ],
      },
      {
        h: "Price, payment and tax",
        ps: [
          "The floor is $5 — the minimum first stake on an empty element, and the minimum for joining an element that already has a holder. To take an element from someone else your total there must reach their total plus $1. Amounts are in whole US dollars, and outbidding by more than a dollar is always allowed. What you have already staked on an element counts towards your next stake there and never expires: a discount on that element, not equity, and it cannot be sold, transferred or withdrawn.",
          "Payments are handled by our payment partner, which is also the seller of record — this site is the advertising publisher. Card details are entered on their page and never reach this site, and a stake is a one-time charge with no subscription. During launch, checkout can be gated behind a waitlist: a waitlist shown at the payment step is expected and not an error.",
          TAX_SENTENCE,
          DESCRIPTOR_SENTENCE,
        ],
      },
      {
        h: "Finality: no refunds",
        ps: [
          "Every stake is final. A stake buys advertising that is delivered as soon as the payment settles — the listing appears on the table and in the leaderboards — and it is bought for one named element, so it cannot be given back once delivered. Paying is your express request that performance begin immediately rather than at the end of any cooling-off period.",
        ],
        bullets: [
          "No refunds, cancellations, withdrawals, exchanges, credits or transfers — and no refund for part of a period, or for a listing you stop using.",
          "No refund because you were outbid, because the rank changed or because you changed your mind.",
          "No refund for a listing hidden or removed for breaking these rules, for a credible complaint from a rights holder, for legal risk, or because the product changed, a feature was removed, the board was redrawn or the site was down.",
          "A reversal or dispute outcome that returns the money reverses the stake with it: the listing falls back to the previous holder and the rank it bought is lost.",
          "Where the law gives you a right that cannot be waived, that right is unaffected by this section. Everything else in it stands.",
        ],
      },
      {
        h: "Disputes: write before you charge back",
        ps: [
          "If something is wrong with a charge, write to us first: the receipt carries the reference, the amount and the descriptor, a person reads that mailbox, and almost every dispute starts as a charge nobody recognised, which one reply settles. Opening a chargeback or a payment dispute without writing to us first breaches these rules — your listings can be removed permanently, further stakes can be refused, and the fees and costs a dispute causes may be recovered from you.",
        ],
      },
      {
        h: "What may be listed, and what we remove",
        ps: [
          "Links must be lawful and safe for a general audience. Prohibited: malware, phishing, deceptive or fraudulent offers, illegal goods or services, sexually explicit content, hate or harassment, impersonation, and anything that infringes someone else's rights or breaks the law that applies to it. You confirm you have the right to publish what you submit and to promote the destination you name, and you keep whatever rights you had in it.",
          "Listings are not reviewed before they appear, but any listing can be hidden or removed at any time — for breaking these rules, for a credible complaint from a rights holder, for legal risk or for abuse of the board — without refund, as the finality section says. Repeated abuse ends access to the site.",
        ],
      },
      {
        h: "Availability",
        ps: [
          "The site is provided as is and as available, without warranties of any kind, express or implied, including availability, accuracy or fitness for a particular purpose. Nothing is promised about uptime, traffic, clicks or sales: a listing buys a rank on a board, not an audience.",
          "Figures on the table and in the leaderboards are informational and may lag during outages or maintenance, and elements, prices, features and the way a board is drawn can change: a price shown applies to the moment of payment rather than to the next one. Checkout can be switched off, gated or limited at any time — for a payment problem, a legal issue or a launch decision — and where that matters to holders it is announced on this page and by email.",
        ],
      },
      {
        h: "Liability and indemnity",
        ps: [
          "Nothing here excludes or limits liability that cannot lawfully be excluded: liability for fraud or wilful misconduct, for death or personal injury caused by negligence, or the statutory rights of a consumer. Subject to that, no indirect or consequential loss, lost profit, revenue, data or goodwill is recoverable, and total liability for any claim connected to this site or to a stake is limited to the amount paid to us in the twelve months before the event the claim is about.",
          "You are responsible for what you list. If a claim is made against us because of your listing, its content or the site it links to — including a complaint from a rights holder or a regulator — you indemnify us for the loss and reasonable costs that follow, and will take part in defending it if we ask.",
        ],
      },
      {
        h: "How long the board runs",
        ps: [
          "A stake does not run down. A holder stays ahead on an element until someone outbids them, and being outbid burns nothing: what was staked stays as a discount on that element that never expires, as the price section says.",
          `The board is committed to run at least until ${SERVICE_TERM.until}. That is a floor, not a deadline: if the commitment is extended, the later date is published in this section and on the questions page, and until then the date here is the one that applies.`,
          `If the site ever does stop, this page says so and every current holder is emailed at least ${SERVICE_TERM.noticeDays} days beforehand. No further stakes are taken from the day that notice is published — checkout is switched off rather than left running into a wind-down — and stakes already taken are not refunded, which is the finality rule above applied to the worst case. The listing is removed with the board rather than refunded.`,
          "This section is a commitment about a date and about notice. It is not a warranty that the service will run for any particular period beyond the date it names, and it does not turn a stake into a security, a share or a claim on revenue.",
        ],
      },
      {
        h: "The last few clauses",
        ps: [
          "These documents, the pages they link to and the wording shown at checkout are the whole agreement about a stake. Nothing said elsewhere — a post, an email, a reply — adds a term to it.",
          "If a clause here turns out to be unenforceable, the rest of it stands and the clause is read as narrowly as it must be to be enforceable; not enforcing a clause once does not give it up, and headings are for reading, not for interpreting. These documents and any dispute connected to them or to a stake are governed by the law of the place where the operator does business, and the courts there hear the dispute — except where the law gives a consumer the right to bring a claim where they live.",
          "The words on this page are the words that apply: there is no change log to check them against. The rules the checkout quotes are these rules, and the wording accepted is recorded with the payment it was made under.",
        ],
      },
    ],
  },
  contact: {
    title: "Contact",
    desc: "One mailbox for everything: a payment question, a listing report, a rights complaint, or a privacy request.",
    sections: [
      {
        h: "One mailbox",
        ps: [
          `Everything goes to ${SUPPORT_EMAIL}: there is no telephone number, no postal address and no ticket system, and a person reads that mailbox. A reply within a few business days is the aim — if a week passes, send the message again. Any mail this site sent you can be replied to, and the reply arrives in the same inbox.`,
          `Access, correction and deletion requests go to the same address: the privacy page says what can be deleted, and what has to be kept to answer a chargeback or a tax question.`,
        ],
      },
      {
        h: "A payment question",
        ps: [
          "Include the payment reference from your receipt email (or the date, the amount and the last four digits of the card) and the address you paid with: those facts are what let us find the payment, and nobody other than the payer can be given details of a charge. Write before opening a chargeback — a dispute filed without a message first breaches the rules and ends access to the site.",
          DESCRIPTOR_SENTENCE,
        ],
      },
      {
        h: "Report a listing, or complain about one",
        ps: [
          "Fastest path: open the listing from its row on the table and use the report button (⚑) on that page. It reaches the moderation queue with the listing attached and needs no account.",
          `A rights complaint — copyright or trademark — is a report with a little more in it, sent to ${SUPPORT_EMAIL}: the element and the listing domain, the address of the material you say is infringed, how to reach you, and a statement that you believe in good faith that the use is unlawful and that you are entitled to act for the rights holder. A complete complaint is actioned within 72 hours, the listing can be hidden while it is reviewed, and you are told what was done.`,
          "This site is not a service provider with a designated copyright agent: the listings here are submitted by the advertisers themselves, and a complaint is handled the same way a report is.",
        ],
      },
    ],
  },
  privacy: {
    title: "Privacy & data",
    desc: "Every category of data periodictable.lol collects, why, which companies process it, how long it is kept, and how to have it deleted.",
    sections: [
      {
        h: "Who is responsible, and who this is for",
        ps: [
          `The person who runs this site is the data controller for everything described here, and the only contact point published is the mailbox on the contact page (${SUPPORT_EMAIL}) — no company, postal address or telephone number is published anywhere, deliberately. One thing does not depend on that: the payment partner is the merchant of record for every charge, so the transaction, its records and the tax position are theirs, and what is held here is the minimum described below.`,
          `This service is for adults: the rules require you to be 18 or over, or the age of majority where you live, and the checkout asks you to confirm it. A stake made by a child is reversed and the payment returned on request — write to ${SUPPORT_EMAIL}.`,
        ],
      },
      {
        h: "What is collected, and why",
        ps: [
          "Nothing below is inferred or enriched. There is no advertising network, no cross-site tracking and no data broker, and personal data is not sold or rented to anyone.",
        ],
      },
      ...PRIVACY_COLLECTED.map(
        (group): LegalSection => ({ h: group.h, bullets: group.bullets }),
      ),
      {
        h: "What is published",
        ps: [
          "Published, and public the moment a stake settles: the element, the title and pitch, the domain on the row, the destination of the link, the total staked on that element, and how many times the row has been clicked.",
          "Never published: an email address, a payment reference, card details, a report, or the hash behind a rate limit. Row-level click logs are visible to the operator and are not published, and the totals carry no identity — no per-visitor history, and one click cannot be tied to another.",
        ],
      },
      {
        h: "Cookies and analytics",
        ps: [
          "No page of this site sets a cookie of its own, and there is no advertising or profiling cookie anywhere — including behind analytics, which is off in production unless the operator switches it on.",
          `The events: ${ANALYTICS_EVENTS.join(", ")}, plus an aggregate pageview count. They record that something happened and the shape of the page — not who did it. No analytics script is loaded before consent, and it does not load until you say yes. A visitor who never answers makes no request to Plausible at all, because the gate is the script rather than a flag inside it.`,
          "When analytics is on it is Plausible: cookieless, IP-anonymising, limited to the events above, and the switch is held in the deployment configuration and never changes at runtime. Analytics is off in production, and that is not a figure of speech: NEXT_PUBLIC_PLAUSIBLE_DOMAIN is left unset in the deployment, so no request reaches Plausible from this site.",
        ],
      },
      {
        h: "What your browser talks to",
        ps: [
          "On a normal page view: none. Every icon is fetched by our own server, at the proxy route /api/favicon, and served from this domain, so the icon service sees our request rather than the browser's and learns nothing about which pages are read. Listing screenshots are captured by our servers the same way, so a third party is not reached while a page is browsed.",
          "Three exceptions, all on a step a visitor chooses to take: checkout mounts the payment partner's form, so Stripe sees that page and, when the anti-bot check is enabled, Cloudflare too; and analytics, if it is enabled and consented to, as above. Nothing else is fetched — no font service, no tag manager, no chat widget, no tracking pixel and no advertising script is loaded by this site, on any page.",
        ],
      },
      {
        h: "Companies that process data for us",
        ps: [
          "Each of these acts on instruction, and none of them may use the data for advertising of its own. This list is the whole set: nothing is added to it without appearing here.",
        ],
        bullets: PRIVACY_PROCESSORS.map((p) => `${p.name} — ${p.role}. ${p.text}`),
      },
      {
        h: "Retention, and deletion",
        ps: [
          "Payment rows are kept while the listing exists and afterwards for as long as tax, accounting and dispute handling require, because a deleted row cannot answer a chargeback. Reports and their mail log are kept for 30 days after sending. Rate-limit hashes expire on a short window and are never joined to anything else.",
          "A deletion request is honoured by taking the row off the board and dropping the personal part of every row that can be dropped without breaking one of those obligations — an email address attached to a payment that is later disputed is kept until the dispute window passes, and then it goes. Every deployment also runs a scheduled erasure sweep: finished rows older than the retention window are deleted by a job, not by hand.",
          "In the UK, the EEA or Switzerland you also have the right to object to processing, to ask for a portable copy of what is held and to complain to your national supervisory authority; the controller is not established there, so a request goes to the mailbox above and is answered within 30 days.",
        ],
      },
      {
        h: "Security",
        ps: [
          "Passwords are not used and not stored: there is no account to log into, and card details never reach this site — they are entered into the payment partner's own form, and only their reference and the outcome come back.",
          "Transport is encrypted end to end and the database is not reachable from the open internet. No system is perfect: if a breach ever affects personal data, affected people are told without undue delay, with what is known and what to do about it.",
        ],
      },
    ],
  },
};

/** Renders a slug's sections as published. The About page used to take an
 * operator block appended here; nothing is appended now. */
export function legalSections(slug: LegalSlug): LegalSection[] {
  return LEGAL_PAGES[slug].sections;
}

/** The canonical text of a page: title, description, headings, paragraphs, bullets
 * and table rows, in render order. `lib/legalContent.test.ts` digests this string,
 * so a change to any published word fails a test and has to be re-approved
 * deliberately. No version stamp and no change log is part of the text. */
export function legalCanonicalText(slug: LegalSlug): string {
  const page = LEGAL_PAGES[slug];
  const lines: string[] = [page.title, page.desc];
  for (const section of legalSections(slug)) {
    lines.push(section.h);
    for (const p of section.ps ?? []) lines.push(p);
    for (const b of section.bullets ?? []) lines.push(b);
    for (const row of section.table ?? []) lines.push(`${row.label}: ${row.value}`);
  }
  return lines.join("\n");
}
