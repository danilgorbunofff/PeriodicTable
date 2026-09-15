# 16 — Legal, privacy, tax

| Field | Value |
| --- | --- |
| Phase · batch | 16 · 4 |
| Status | draft — findings registered, no fixes (read-only pass) |
| Date reviewed | 2026-09-15 |
| Commit reviewed | `9681bdcbff2435ef258224c52000e0f8d6089f5c`; live build (§5.1) |
| Reviewer | review agent |

| Probe not run | Why | Residue |
| --- | --- | --- |
| Stripe dashboard: Tax / Managed Payments registration state, statement descriptor, receipt settings | no dashboard access from this checkout | U16-1 |
| Resend dashboard: verified sending domain, whether `abuse@`/`payments@`/`hello@` receive inbound mail | no dashboard access; no `RESEND_API_KEY` here | U16-2 |
| Neon + Vercel + Cloudflare: project region, role set, DPAs on file | no console access | U16-3 |
| Production row counts for a retention baseline (`Payment.email`, `ClickEvent`, `EmailLog`, `AuditLog`) | no `.env`/`DATABASE_URL` in this worktree (rules: do not create one) | U16-4 |
| A real refund driven end-to-end to re-observe the reversal | read-only default; batch 1 already owns the copy contradiction (R05-6) and the reversal itself (U05-1 residue) | none new — cites 05 §7 R05-6 |

Three legal pages exist (`about`, `rules`, `contact`), are served, are internally consistent with the corrected refunds copy, and their bidding arithmetic is literally the code's arithmetic (§5.3). What is missing is not grammar: it is the privacy document (no `/legal/privacy` — 404 in production, §5.1), the operator (no entity, no address, no jurisdiction anywhere on the site), the tax position (nothing in the software decides, collects, displays or records tax), the consent record (a checkbox is checked and forgotten), and the production data inventory the About page describes in a paragraph that is wrong in both directions (§5.2). 14 findings, all `open`; five UNKNOWN rows name the provider-dashboard step that settles each. Nine decisions are the operator's alone and are listed in §9 — they are the deliverable's second half, not a footnote.

## 1. Scope

Owns matrix cells **S1 L8=16** (arrival: the legal corpus a first visitor can reach) and **S12 L7=18** (after: what a complaint, a refund or a regulator finds). Also the legal half of **S6 L8=16** (the consent taken at checkout) and **S9 L8=16** (the receipt as a document).

Files opened: `app/legal/[slug]/page.tsx` (whole corpus, line-level §5.3), `lib/legalMeta.ts`, `lib/sitemapData.ts`, `app/sitemap.ts`, `app/robots.ts`, `components/Modals.tsx:228-249,455-491`, `components/FooterBar.tsx:17-21`, `emails/receipt.tsx`, `emails/outbid.tsx`, `lib/email.ts`, `lib/analytics.ts`, `app/layout.tsx:25-31`, `lib/stripe.ts`, `lib/screenshots.ts`, `lib/startups.ts:43`, `lib/rateStore.ts`, `lib/pricing.ts`, `lib/abuse.ts:50-51`, `app/api/checkout/route.ts:130-131`, `prisma/schema.prisma`, `prisma/launch-seed.ts`, `next.config.mjs` (CSP), `.env.example` (names only).

Not this doc: retention as a schema question belongs to `12`; secret handling to `14`; the seed-or-not launch decision to `19`; the accessibility of the legal pages to `05`; the refunds copy contradiction is **settled** — 05 §7 R05-6 — and is cited, not re-reported.

## 2. Actors

- **Buyer** — stakes $5–$500 at 18+ attestation, receives a receipt, may later want a charge reversed (§5.4, §5.6).
- **Listed company's rights holder** — trademark, right of publicity, or a real complaint; needs an address that can be served (§5.7).
- **Visitor who never pays** — still gets a Google request from every tile (§5.5).
- **The operator as a legal person** — the entity that is the data controller, the tax registrant, the contracting party and the respondent in a dispute. Today this actor appears nowhere on the site (§5.8).
- **A regulator or platform (Visa/Mastercard, Stripe risk)** — reads the site to decide whether the product is what it says it is (§5.9).
- **The operator under stress** — no runbook tells them how to answer any of the above (`17`).

## 3. Intended behaviour

### 3.1 The corpus as shipped

Three statically-generated documents by `generateStaticParams` (`app/legal/[slug]/page.tsx:130`, slugs `about|rules|contact` at `:9,51,101`), served from one component with per-page metadata and canonical (`lib/legalMeta.ts:24-35`), each carrying its own `title`, `desc` and one identical `updated` string (`:12,54,104`). Anything else under `/legal/*` falls to `notFound()` (`:143`). The footer links all three (`components/FooterBar.tsx:17-21`), the checkout modal links `rules` once, in the passive sentence under the button (`components/Modals.tsx:490`).

### 3.2 The claims register

Every prose sentence on the three pages, against what the software does. Line numbers are `app/legal/[slug]/page.tsx` unless stated. Verdicts: **True** (software does what the sentence says), **Partly** (true in substance, short of the words), **False** (contradicted), **Exposure** (accurate but legally dependent on a decision nobody has taken).

| # | Line | Claim (opening words) | What the software does | Verdict |
| --- | --- | --- | --- | --- |
| A1 | `:17` | "advertising leaderboard … **anyone** can stake money to claim an element … top spender holds it … displayed publicly" | Checkout → settle → `rankStakes`/`recompute` → board, element page, profile, `/api/board`. Real, with two gates the sentence omits: 18+ (`:59`, not verified) and the waitlist gate (`:82`) | Partly |
| A2 | `:18` | "stakes are cumulative … the top-ranked listing **owns** the element until someone outbids them" | Accurate as ranking — `lib/pricing.ts:14-17` sums prior stakes, `recompute` sets `currentLeaderId`. "Owns" conveys a property right that never exists and that the next outbid ends | Partly |
| A3 | `:24` | "independent creative project … not affiliated with, endorsed by, or connected to IUPAC … names used referentially … trademarks belong to their owners" | Consistent with the product: the only other IUPAC mentions are a data-source caption (`app/elements/[sym]/page.tsx:95,155`, `components/Modals.tsx:39`), no IUPAC marks, no affiliation claim | True |
| A4 | `:25` | "a listing … does not mean the listed company … is even aware … **every link is submitted by whoever paid for it** … paid advertising — nothing more" | Checkout always writes a `Payment` before a stake exists. The launch seeder does not: `prisma/launch-seed.ts:101-115` creates `Stake` + `ActivityLog` rows for stripe.com/coinbase.com/nvidia.com/anthropic.com/cloudflare.com/huggingface.co/adyen.com/supabase.com/squareup.com and more, with invented amounts and cities and **no** `Payment` — presented by `lib/pricing.ts` exactly like paid listings (R16-9) | False today |
| A5 | `:31` | "point to third-party websites we do not own/operate/vet … not responsible for their content … we display the destination domain on every row before you click" | Domain is shown on rank rows and tiles; the click goes through `/go/[stakeId]` (`app/go/[stakeId]/route.ts`), which logs and redirects | True |
| A6 | `:32` | "we do not pre-moderate … **we remove** listings that violate our rules" | Report button → `app/api/report/route.ts` → `Report` row → operator queue; the operator action is `moderate` → `HIDDEN`/`UNLISTED` (`app/api/admin/startups/[domain]/moderate/route.ts`), and hidden money **stays in pool totals** and financial history is never deleted (`lib/moderation.ts`, cited `doc/PROD-READINESS-CHECKLIST.md` §J6). Concealment, not removal | Partly |
| A7 | `:38` | "as is" … "figures … may lag or be incorrect during outages" | Matches the failure-honesty pattern (`lib/liveState.ts:39`; checklist §grid/stats honesty `:209-216`) | True |
| A8 | `:39` | "not liable for any indirect, incidental, or consequential damages … including any dealings between you and listed businesses" | No cap, no carve-out for the liabilities that cannot be excluded (death/personal injury, fraud, consumer guarantees), no governing law to test it against. Only the saving phrase "to the maximum extent permitted by law" | Exposure |
| A9 | `:45` | "we keep **the minimum data** … payment status, a display name, the link you list, and **the city/country your payment provider associates with the transaction** … we do not sell personal data … favicon previews from a public favicon service" | See §5.2/§5.4/§5.5: the real set adds email (3 tables), click log (IP hash + UA per redirect), audit log, mail log with recipients, payment references and amounts; **no** city/country is collected from any provider anywhere in the repo — `ActivityLog.city` is written only by the three seeders (`prisma/seed.ts:103`, `prisma/fill-table.ts:186`, `prisma/launch-seed.ts:113`) and is **published** on the feed (`app/api/activity/route.ts:40,68`, `lib/activityFace.ts:52` renders `"somewhere"` when absent); six processors unnamed; "do not sell" holds by inspection (no ad/analytics SDK enabled in production, §5.1) | False |
| A10 | `:46` | "questions about your data can go to the contact channels" | Contact page offers `hello@`, `payments@`, `abuse@` — no data-rights address, no request procedure, no named controller | Partly |
| A11 | `:59` | "at least 18 … able to form a binding contract … may not stake on behalf of someone else's payment instrument" | Enforced as one boolean: `components/Modals.tsx:470-473` copy, `:485` submit disabled until ticked, `app/api/checkout/route.ts:130-131`, `lib/abuse.ts:50-51`. No age evidence, no cardholder check, **nothing about the attestation is stored** | Exposure |
| A12 | `:60` | "one listing per payment per element; you may hold several elements at once" | `Payment` carries one `startupId`+`elementId`; `Stake` unique on `(elementId,startupId)`; several elements per startup allowed | True |
| A13 | `:66` | "Floor: $5 … all amounts in US dollars, whole numbers" | `lib/pricing.ts:7` `MIN_STAKE = 5`; whole-dollar validation at `:21,44,54,70`; currency USD on the session | True |
| A14 | `:67` | "Takeover: … current #1's total plus $1 … outbidding by more than $1 is always allowed" | `lib/pricing.ts:9-10` `takeLeadPrice = leaderTotal + 1`; TAKE path allows any amount ≥ that (`:92`) | True |
| A15 | `:68` | "Reclaim: … (current #1 total + $1) minus what you already staked, never less than $1 … stake is cumulative equity — never expires, never reset" | `lib/pricing.ts:14-17` `Math.max(1, leaderTotal + 1 - userTotal)`; `Stake` has no TTL (only pre-payment `Reservation` does). "Equity" is marketing, not a legal interest | True (wording excepted) |
| A16 | `:74` | "links must be lawful and safe … prohibited: malware, phishing, … hate …, impersonation" | Policy exists; enforcement is a human reading the report queue. `lib/validate.ts` checks shape, not content | Partly |
| A17 | `:75` | "we may remove **or hide** … without refund … refuse or remove listings for trademark or right-of-publicity complaints from the actual rights holder" | Hide/unlist exists; "without refund" matches R05-6's corrected final-stakes copy and the reversal semantics (`lib/stripe.ts:325-329`) | True |
| A18 | `:81` | "processed securely by our payment partner (Stripe). We never see or store your full card details. One-time charge in USD; no subscriptions, no recurring billing" | Hosted Checkout, `customer_email` set (`lib/stripe.ts:91`), no PAN fields in the schema, no subscription objects. **Unstated:** Stripe Managed Payments makes Stripe the merchant of record (`lib/stripe.ts:40,47,55`), so the counterparty on the receipt is not the operator | Partly |
| A19 | `:82` | "during launch, checkout may be gated to a waitlist — expected, not an error" | Waitlist modal + `paymentsLiveServer` gating (`components/Modals.tsx:300-317`) | True |
| A20 | `:88` | "all stakes are final … delivered immediately (listing appears as soon as payment settles) … no discretionary refunds, withdrawals, or cancellations — including if you are later outbid or change your mind" | Matches the reversal code and R05-6's corrected copy. But this is the sentence an EU/UK buyer's 14-day withdrawal right meets, and the digital-content exception requires an express consent + acknowledgment of loss that **is not captured** (R16-6, R16-7) | Exposure |
| A21 | `:89` | "contact us before disputing … if refunded (by us, or by your card issuer after a dispute) the stake is reversed … chargebacks filed without contacting us may result in permanent removal of all your listings" | Reversal is real and automatic: `lib/stripe.ts:325-329` (`charge.refunded`, `charge.dispute.created`, `charge.dispute.funds_withdrawn`) → `lib/recompute.ts:116,165` (`kind:"refund"`). The multi-listing removal threat has **no tool** behind it (one listing at a time, by hand — `17`) | Partly |
| A22 | `:90` | "you are responsible for any taxes arising from your purchase under your local law" | Under the merchant-of-record model the seller/registrant is Stripe on the operator's behalf; this sentence tells the buyer to self-assess a tax the platform may already have collected, and no tax line exists on the receipt at all (§5.6) | Exposure |
| A23 | `:96` | "the version on this page is the one that applies; material changes will be announced on the site before they take effect" | No version identity (one hard-coded date string, `:12,54,104`), no announcement surface anywhere in `components/`, no notice pattern (§5.7) | False |
| A24 | `:109` | "fastest path: the report button (⚑) on any rank row — straight to our moderation queue, no account needed" | `components/ReportListingButton.tsx` on rank rows → `app/api/report/route.ts` → `Report`; intake mail per R05-7 (settled, cited) | True |
| A25 | `:110` | "email abuse@ … with (1)–(4) … valid reports actioned within 72 hours; reported listings can be hidden pending review" | Intake is real (R05-7, settled). "72 hours" is a promise with no metric, no owner and no notification; the heading says DMCA but the DMCA's own machinery (designated agent, address, counter-notice, perjury statement) is absent (R16-8) | Partly |
| A26 | `:116` | "email payments@ with the receipt … always include the email you paid with — we can only discuss billing details with the payer" | Receipt exists but has no reference number and no tax line (§5.6); there is no payer-authenticated view (`/manage` is backend-only — checklist `:42,181`), and no procedure for verifying "the payer" | Partly |
| A27 | `:122` | "hello@ … we usually reply within 2–3 business days" | No ticketing, no metric, no rotation; whether the mailbox even receives mail is a Resend/Cloudflare-console question (U16-2) | Unverifiable |
| A28 | `:123` | "operated as an independent project; postal address available on request for legal correspondence" | No entity, no address, no channel through which to request it, no agent for service. The one thing a rights holder or a court needs | False |
| M1 | `:12,54,104` | `updated: "Last updated: September 2026"` ×3 | One hard-coded string shared by three documents; a copy change ships under an unchanged date | False |

### 3.3 The consent act, as designed

`components/Modals.tsx:470-473`: *"I am 18+ and I own or may promote this URL. No refunds/withdrawals — stake = ad inventory."* — one checkbox, two attestations, and `:490` *"by continuing you agree to the rules & terms"* as a sentence under the button. The server validates a boolean (`lib/abuse.ts:51`), returns a 400 naming the field (`app/api/checkout/route.ts:131`), and **persists nothing about the consent** — no text, no version, no timestamp, no checkbox state, no IP even. `Payment` (schema) has `requestFingerprint` and `idempotencyKey`, neither of which is a consent record.

## 4. The path walked

4.1 `/legal/about` → footer from `/`; read the five sections in place on the live site (probe 5.1.1) and in source (5.3).

4.2 Checkout consent → `/` → click a claimed tile → Stake modal → the checkbox and the sentence under it (source read; no DB in this checkout, so the 400 path is cited from code and `lib/phase4.test.ts:77-80`).

4.3 Card data → followed the session fields to the last one (`lib/stripe.ts` read end-to-end): what is set is `customer_email`, `tax_code`, `metadata`; what is never set is `automatic_tax`, `statement_descriptor`, `receipt_email`, `invoice_creation`, `billing_address_collection`, `tax_id` (probe 5.2).

4.4 Data inventory → schema model by model, then every writer of each PII column (grep for `city`, `email`, `ipHash`, `userAgent`, `actorRef`), then the three seeder files.

4.5 Third-party flow → CSP in `next.config.mjs` → the four endpoints it permits → the code that calls each → which of them a **visitor** causes (favicons: any page load; Microlink: hover/job; Plausible: pageview when enabled; Turnstile: checkout when enabled).

4.6 Takedown → the contact page's DMCA paragraph → what the report button does → what the operator can actually do with a report (`app/api/admin/*`, `lib/moderation.ts`).

## 5. Live evidence

### 5.1 Served legal corpus — 2026-09-15T07:14:30Z UTC, `https://www.periodictable.lol`

| URL | Status | Bytes | Note |
| --- | --- | --- | --- |
| `/legal/rules` | 200 | 21777 | R05-6 copy ships: one "Refunds & disputes", **0** hits for `no refunds` / `do not offer refunds` |
| `/legal/about` | 200 | 20454 | includes the `:45` "Data & cookies" paragraph verbatim |
| `/legal/contact` | 200 | 15955 | `abuse@`, `payments@`, `hello@` as printed |
| `/legal/privacy` | **404** | 9943 | branded not-found; the slug is not in `generateStaticParams` (`:130`) |
| `/` | 200 | 152029 | **0** `plausible.io` tags, **0** `s2/favicons` refs, **0** cookie/consent strings, **0** `Set-Cookie` headers |

The favicon absence on `/` is the interesting one: the logo URLs are stored per listing, so Google is called from a browser as soon as a **staked** listing renders — not from an empty board. Both facts are needed for R16-3.

### 5.2 Field-level probe — `lib/stripe.ts`, 2026-09-15

Grep for `automatic_tax|statement_descriptor|receipt_email|invoice_creation|billing_address_collection|tax_id` across `lib/`, `app/`, `emails/`, `prisma/`: **0 hits**. Set on the session: `customer_email` (`:91`), `tax_code = txcd_10000000` "General – Electronically Supplied Services" (`:99`), `metadata` paymentId/elementSymbol on session *and* intent (`:109-112`). Merchant-of-record comments at `:40,47,55`. Grep for `billing_details|address_city|address_country|shipping|geo` across `app/`, `lib/`, `prisma/`: only unrelated grid-geometry matches — **no address or country is stored anywhere**, which is what makes A9 false in the second direction and is also why the R16-4 tax question is not merely a UI gap.

### 5.3 Sentence-level source map

`app/legal/[slug]/page.tsx`: about `:9-12` (meta), `:17-18` (§3.2 A1–A2), `:24-25` (A3–A4), `:31-32` (A5–A6), `:38-39` (A7–A8), `:43-46` (A9–A10); rules `:51-54` (meta), `:59-60` (A11–A12), `:66-68` (A13–A15), `:74-75` (A16–A17), `:81-82` (A18–A19), `:88-90` (A20–A22), `:96` (A23); contact `:101-104` (meta), `:109-110` (A24–A25), `:116` (A26), `:122-123` (A27–A28); `:130` slugs; `:143` `notFound()`; footer `:159,161,163`.

### 5.4 Real data inventory (schema + writers)

| Data | Column | Written by | Public? | In the `:45` sentence? |
| --- | --- | --- | --- | --- |
| Payer email | `Payment.email` | checkout (`app/api/checkout/route.ts`), settle | no | no |
| Listing email (pitch contact) | `Startup.email` | checkout | no | no |
| Manage-link email | `ManageToken.email` | v2 backend only (checklist `:42`) | no | no |
| Waitlist email | `WaitlistEntry.email` + `AuditLog.detail` | `app/api/waitlist/route.ts:39,45` | no | no |
| Listing text | `Startup.title/pitch/url/domain/logoUrl` | checkout | **yes** | "a display name, the link you list" |
| Money facts | `Payment.providerRef/providerAmount/Currency/status/paidAt/refundedAt` | checkout, webhook | partially (`/api/board` totals) | "payment status via our payment partner" |
| Click log | `ClickEvent.ipHash/userAgent/stakeId` | `/go/[stakeId]` | aggregates only | no |
| Feed rows incl. city | `ActivityLog.domain/elementSymbol/amountUsd/kind/city` | settle **and three seeders** | **yes** (`app/api/activity/route.ts:40,68`) | "the city/country your payment provider associates…" — not collected by any provider call, and published when present |
| Reports | `Report.reason/ipHash` | `app/api/report/route.ts` | no | no |
| Mail log | `EmailLog.to/subject/type` | `lib/email.ts` | no | no |
| Operator audit | `AuditLog.action/detail/actorRef` | `lib/audit.ts:46` callers | no | no |

`lib/clicks.ts:14-16` is `sha256(ip + ":" + CLICK_SALT)` — a pseudonym, not anonymity, and the salt is the one that makes it irreversible. The waitlist audit entry that used to store the **raw** IP is fixed (`app/api/waitlist/route.ts:45` `hashIp(ip)`, pinned by `lib/phase5.test.ts:44-55`, checklist §J) — cited, not re-reported. Retention: `EmailLog` 7 rows and `AuditLog` 25 rows are **kept deliberately** in production (`doc/PROD-READINESS-CHECKLIST.md` §residue `:296-302`), and nothing in the legal copy says how long anything lives (R16-14).

### 5.5 Processors actually in the data path

| Processor | Reached via | When | Disclosed at `:45`? |
| --- | --- | --- | --- |
| Stripe | `lib/stripe.ts` (Managed Payments = merchant of record) | checkout, settlement, reversal | yes ("our payment partner") |
| Resend | `lib/email.ts:59` sender `periodictable.lol <hi@periodictable.lol>` | receipt, outbid, report, waitlist | no |
| Neon | `DATABASE_URL` (all rows above) | always | no |
| Vercel | `vercel.json` (host + cron) | always | no |
| Cloudflare | Turnstile widget (`components/Modals.tsx:474-481`) + CSP `frame-src` | checkout when enabled | no |
| Google | `lib/startups.ts:43` + `lib/screenshots.ts:10-11` → `https://www.google.com/s2/favicons?domain=…`, served as `<img>` on tiles/avatars | **every page view with a staked listing** | "a public favicon service" (unnamed, and not described as the visitor's browser calling it) |
| Microlink | `lib/screenshots.ts:18` + `:17-36` (`embed=screenshot.url` streams the PNG to the browser) | hover preview / screenshot job | no |
| Upstash | `lib/rateStore.ts:32-69` (REST), warns when unset `:63-73`, fails open `:85-90` | when configured | no |
| Plausible | `app/layout.tsx:29-31` script tag when `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` set; events `lib/analytics.ts:5-13` | **not in production today** (§5.1: 0 tags) | no |

`next.config.mjs:7,14-16` is the proof-of-intent for four of these: `script-src … https://plausible.io https://challenges.cloudflare.com`, `img-src … https://*.microlink.io https://www.google.com`, `connect-src 'self' https://plausible.io`, `frame-src https://challenges.cloudflare.com`.

### 5.6 The receipt as a document

`emails/receipt.tsx` contains the amount, a view link (`:30`), the unsubscribe link (`:33`) and the tagline "it's an ad buy, not a bet" — and **no** tax line, **no** billing address, **no** payment reference, **no** seller identity, **no** terms link (grep for `tax|rules|legal|refund|terms` → 0 hits). `lib/email.ts:45-53` sets RFC 8058 `List-Unsubscribe` on it; the report mail (`:151-164`) sets none (correct — transactional to the operator).

### 5.7 Nothing can be announced, nothing can be served

No announcement surface exists: grep for `announce|changelog|release note|banner` across `app/` and `components/` returns only the checkout modal's aria-live comment (`components/Modals.tsx:325-329`) and a toast id. `app/sitemap.ts` + `lib/sitemapData.ts:17-27` emit **only** `/` and `/elements/:sym` — the three legal pages are not in the sitemap, though `app/robots.ts` allows crawling them (R16-13). Contact channels are printed as addresses with no mailbox behind them verifiable from here (U16-2) and no route for legal service.

### 5.8 The operator is absent

Grep across `app/`, `components/`, `emails/`, `lib/` for an entity name, a company number, a VAT/tax id, a physical address or a "registered in" string: **0 hits** outside the disclaiming `:123` line. `package.json` name/author, `README.md` and `.env.example` likewise carry no operator identity.

### 5.9 Framing audit — the words that decide the exposure

| Word | Where | What the software does | What a reader (or a regulator) may hear |
| --- | --- | --- | --- |
| "stake" | `:17,18,59,66-68,81,88,89`; `components/Modals.tsx:472,490` | A one-time card charge that buys a ranked ad slot | A wager or an investment |
| "own" / "owns the element" | `:18`; checkout tags | Top-of-list position, lost on the next outbid | A property right in an element or in the site |
| "cumulative equity" | `:68` | Running total of that buyer's spend on that element | An equity interest, redeemable |
| "take the crown" / "crown" | board tab and `lib` copy | #1 rank | A prize won |
| "outbid" | `:67,88` | Pay ≥ leader+1 | An auction with a winner's prize |
| "it's an ad buy, not a bet" | `emails/receipt.tsx`; `components/Modals.tsx:490` | The product's own legal characterisation | The operator knows the distinction and chose the other words everywhere else |

The rebuttal material for a lottery/prize-competition reading exists and is strong — no chance element (rank is pure price, `lib/pricing.ts`), immediate and specific delivery (an ad slot on a named element), no prize fund and no jackpot, no free draw — but it appears **nowhere** in the legal copy, and the About page's own "advertising leaderboard … nothing more" (`:17,25`) is the only place the characterisation is stated. §9 D9 is the decision.

## 6. Failure and edge matrix

| # | Situation | What happens today | Owner | Finding |
| --- | --- | --- | --- | --- |
| E1 | A buyer asks for a copy of their data | No procedure, no mailbox named for it, no per-person export tool (`/api/admin/*` has no payments read route in the operator's hands as a document) | operator, ad hoc | R16-1, R16-12 |
| E2 | A buyer invokes a 14-day withdrawal right (EU/UK) | No waiver text was presented or recorded; the operator would argue "final" with no evidence of consent | operator, ad hoc | R16-6, R16-7 |
| E3 | A rights holder serves a trademark complaint | The site prints `abuse@` and promises 72 h; no agent, no address, no counter-notice | operator, ad hoc | R16-8, R16-12 |
| E4 | A tax authority asks where the VAT on a $5 stake went | Nothing in the software can answer: no registration, no tax column, no receipt line, and Stripe needs the operator's registration facts to have made the filing decision at all | operator | R16-4, U16-1 |
| E5 | A cardholder disputes "PERIODICTB.LOL" (or whatever the descriptor is) | Contact-before-dispute is promised; the operator cannot look up the payer by email without a DB session and has no evidence pack | operator | R16-5 |
| E6 | A GDPR-style erasure request | Nothing to run: no delete path for `Payment`/`EmailLog`/`AuditLog`, relations are `Restrict` (checklist §J6 hard-delete analysis) | operator + `12` | R16-14 |
| E7 | A visitor in a consent-jurisdiction loads a page with a staked listing | Google receives the visitor's IP from our page with no disclosure and no consent (and Plausible, when enabled, gets a pageview) | — | R16-3 |
| E8 | The seeder runs and the operator forgets `--fresh` | The board sells ad space to real brands for free and asserts amounts/cities they never paid | operator + `19` | R16-9 |
| E9 | Material rules change | No surface to announce it, no version identity for what a buyer accepted | — | R16-11, R16-12 |

## 7. Findings

### R16-1 — There is no privacy policy, and the only data statement is one paragraph on the About page · P0 · privacy

- Evidence: `/legal/privacy` → **404** (§5.1), `generateStaticParams` lists exactly `about|rules|contact` (`app/legal/[slug]/page.tsx:130`), grep for `privacy` across `app/legal/` finds only the footer link and the word inside the About prose. Meanwhile the product collects a payer email, a listing email, a waitlist email, a click log keyed by IP hash, report notes, and keeps mail-log and audit rows (§5.4) — with the retry mail path settled in R05-7.
- Reproduction: `curl.exe -s -o NUL -w "%{http_code}" https://www.periodictable.lol/legal/privacy` → `404`.
- Proposed fix: a `/legal/privacy` slug in `PAGES` whose content is generated from §5.4/§5.5 (data categories, purposes, processors by name, retention, rights, contact), added to the footer and to `lib/sitemapData.ts`.
- **Status.** open

### R16-2 — The "Data & cookies" paragraph is wrong in both directions · P1 · privacy

- Evidence: `app/legal/[slug]/page.tsx:45` claims payment status, a display name, the link, and **"the city/country your payment provider associates with the transaction"**; no address/country/city is ever read from Stripe (`automatic_tax`, `billing_address_collection`, `billing_details`, `address_city`, `address_country` → 0 hits, §5.2), and the only writers of `ActivityLog.city` are the three seeders (`prisma/seed.ts:103`, `prisma/fill-table.ts:186`, `prisma/launch-seed.ts:113`) — which the feed then publishes (`app/api/activity/route.ts:40,68`). Missing from the sentence: `Payment.email`, `Startup.email`, `WaitlistEntry.email`, `ClickEvent.ipHash/userAgent`, `Report.ipHash`, `EmailLog.to`, `AuditLog.detail` (§5.4), and six of the eight processors (§5.5, including Google and Microlink, which the sentence's own "favicon previews" half acknowledges without naming or describing the direction of travel).
- Reproduction: `curl.exe -s https://www.periodictable.lol/legal/about | Select-String "minimum data"`; then `Select-String -Path lib\stripe.ts,app\api\ -Pattern "address|city|country"` → nothing on the payment path.
- Proposed fix: replace the paragraph with the §5.4 table in prose, name every processor, and delete the city/country clause (or start collecting and publishing it deliberately).
- **Status.** open

### R16-3 — Pages call Google (and can call Microlink, Turnstile, Plausible) from the visitor's browser with no disclosure and no consent mechanism · P1 · privacy

- Evidence: `lib/startups.ts:43` builds each `logoUrl` as `https://www.google.com/s2/favicons?domain=…` (`lib/screenshots.ts:10-11` is the helper), and `components/Avatar.tsx`/tiles render it as `<img>` — so a page view with a staked listing sends the visitor's IP and the listing domain to Google; `lib/screenshots.ts:18,17-36` streams Microlink's PNG on hover; `app/layout.tsx:29-31` injects the Plausible script when `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is set (`.env.example:35-36`, `lib/analytics.ts:5-13` seven funnel events) with no banner, no gate, and no consent flag anywhere in the repo; the CSP permits all four (`next.config.mjs:7,14-16`). Production today: 0 plausible tags, 0 consent strings, 0 `Set-Cookie` (§5.1) — so the finding is the *design*, not today's traffic: enabling analytics is one env var, and the already-shipped Google request needs no switch at all.
- Reproduction: `curl.exe -s https://www.periodictable.lol/elements/C | Select-String "s2/favicons"` on a staked element; and `Select-String -Path next.config.mjs -Pattern "script-src|img-src|connect-src|frame-src"`.
- Proposed fix: either proxy/strip the favicon fetch (or vendor the 118 logos once — the table is closed), disable hover previews until a disclosed screen exists, and gate analytics behind an explicit choice with the event list in the privacy page; or disclose all four, and choose the lawful basis (legitimate interest for a self-hosted, cookie-less analytics reading is defensible; Google IP leakage needs the disclosure at minimum).
- **Status.** open

### R16-4 — Nothing in the product decides, collects, displays or records tax · P1 · legal

- Evidence: no tax rate, tax line, VAT id or invoice in the repo; the only tax-adjacent strings are `tax_code = txcd_10000000` on the Stripe session (`lib/stripe.ts:99`) and the buyer-side sentence at `:90`. `Payment` has no tax column (schema); the receipt has no tax line (§5.6); there is no `automatic_tax` and no `invoice_creation` (§5.2). Stripe Managed Payments puts Stripe in the merchant-of-record seat (`lib/stripe.ts:40,47,55`) — which means the tax outcome is *decided in the dashboard from registration facts only the operator can supply*, which is exactly why this is both a finding and U16-1.
- Reproduction: `Select-String -Path lib\stripe.ts,emails\receipt.tsx -Pattern "tax"` → one `tax_code` line, nothing else.
- Proposed fix: decide the position in §9 D2, then make the software tell the truth about it: if prices are tax-inclusive, say so on the checkout and the rules page; if the MoR handles filing, say so; put the tax line and the seller identity on the receipt.
- **Status.** open

### R16-5 — The statement descriptor is unset, unpublished and unverifiable; the contact-before-dispute promise has no tooling behind it · P1 · legal

- Evidence: `statement_descriptor` appears nowhere (`lib/stripe.ts`, grep §5.2); what a buyer sees on their statement is therefore the platform/Managed-Payments default, which the site never tells them (`:89` asks them to contact us *before* disputing, which presupposes they can recognise the charge). On the operator side there is no payment-lookup tool by email, and `/manage` is backend-only (checklist `:42,181`), so a "we can only discuss billing details with the payer" process (`:116`) has no procedure — `17` §7 R17-… owns the missing tooling.
- Reproduction: Stripe dashboard → Settings → Public details → Statement descriptor (U16-1); `Select-String -Path lib\stripe.ts -Pattern "statement"` → nothing.
- Proposed fix: set the descriptor to the domain, print it on the receipt and in the refunds paragraph, and give the operator a documented lookup (even a copy-paste `psql`/Stripe search) for a payer email.
- **Status.** open

### R16-6 — The age limit and the no-refund acknowledgment are taken as a checkbox and never recorded · P1 · legal

- Evidence: `components/Modals.tsx:470-473` is the only place 18+ is asserted, `:485` gates the submit, `app/api/checkout/route.ts:130-131` and `lib/abuse.ts:50-51` validate a boolean, and `Payment` stores no consent, no version, no text and no timestamp (§3.3) — nothing in `prisma/schema.prisma` or the checkout route records that the attestation was made. Nothing verifies age (no cardholder name check, no KYC — deliberately), and nothing states the consequence of a false attestation beyond the general rules.
- Reproduction: `Select-String -Path app\api\checkout\route.ts,lib\abuse.ts,prisma\schema.prisma -Pattern "attest"` → boolean validation only.
- Proposed fix: store the consent (text hash + timestamp + version) on `Payment` at checkout creation — the cheapest possible evidence for a chargeback or a minor-reversal before any policy decision; state the consequence in `:59`.
- **Status.** open

### R16-7 — Terms are accepted by a sentence, not an act, and the version cannot be identified · P1 · legal

- Evidence: `components/Modals.tsx:490` — "by continuing you agree to the rules & terms" under the button; the linked page carries one hard-coded `updated: "Last updated: September 2026"` string shared by three documents (`:12,54,104`, M1) and no version id; the receipt does not link or restate it (§5.6). So for any past purchase the operator cannot say which text applied, and for an EU/UK withdrawal-right waiver there is no express consent or acknowledgment of loss at all (`:88`).
- Reproduction: `Select-String -Path components\Modals.tsx -Pattern "agree to"; Select-String -Path app\legal\[slug]\page.tsx -Pattern "Last updated"` → one string, three uses.
- Proposed fix: a real version stamp (date + short hash) rendered on each document, linked from the checkout checkbox itself rather than a passive line, and a stored acceptance (R16-6's record can carry it).
- **Status.** open

### R16-8 — The takedown path is not DMCA-shaped · P1 · legal

- Evidence: `:107-110` — heading "Abuse, takedowns & DMCA", four email requirements, no designated agent, no postal address (the only address anywhere is "on request", `:123`), no counter-notice procedure, no statement about repeat infringers, no perjury clause. For a site that sells link placements, the safe harbour and the rights-holder's path both depend on an agent that can be found and served.
- Reproduction: `curl.exe -s https://www.periodictable.lol/legal/contact | Select-String "DMCA|counter|agent"` → one heading, no agent, no counter-notice.
- Proposed fix: either publish a real agent (name/role + address) and the counter-notice route, or stop invoking the DMCA and describe a plain abuse process.
- **Status.** open

### R16-9 — The launch seeder sells ad space to real companies it never charged, and the About page says that cannot happen · P1 · legal + content

- Evidence: `prisma/launch-seed.ts` header (`:1-10`) documents the deliberate use of real domains, and `:101-115` creates `Stake` rows with `amountUsd` and `ActivityLog` rows with `kind:"stake"`, an invented `city` and a back-dated `createdAt` — for stripe.com, coinbase.com, nvidia.com, anthropic.com, cloudflare.com, huggingface.co, adyen.com, supabase.com, squareup.com and others — **without any `Payment` row**; `lib/pricing.ts` ranks by stake amount, so they are indistinguishable from paid listings on the board, element pages and feed. `:25` states "every link is submitted by whoever paid for it". `--fresh` exists to wipe them (`:80-88`) and the checklist treats residue as an explicit operator decision (checklist `:15`, §residue `:296-302`).
- Reproduction: `Select-String -Path prisma\launch-seed.ts -Pattern "prisma.payment"` → nothing; `Select-String -Path prisma\launch-seed.ts -Pattern "amountUsd|city"` → both in the created rows.
- Proposed fix: decide in `19` (seed at all?) — if yes, mark seeded rows as illustrative in the UI and the API, and say so on the About page; if no, run `--fresh` before announce and never again.
- **Status.** open

### R16-10 — "Own an element", "cumulative equity" and "take the crown" imply a legal interest the product never conveys · P2 · legal + content

- Evidence: `:18` "owns the element", `:68` "cumulative equity", board crown tab and `it's an ad buy, not a bet` (`components/Modals.tsx:490`, back of the receipt) — see §5.9. The mechanical truth is a ranked ad slot that ends on the next outbid (`lib/pricing.ts:9-10`).
- Reproduction: `Select-String -Path app\legal\[slug]\page.tsx -Pattern "owns the element|cumulative equity"`.
- Proposed fix: pick one vocabulary and use it in both places; if "own" stays as marketing, one sentence must define it as "top of this list until outbid, nothing else".
- **Status.** open

### R16-11 — No governing law, no venue, no liability carve-out, no operator identity · P2 · legal

- Evidence: `:39` disclaims with "to the maximum extent permitted by law" and stops; there is no choice-of-law clause, no venue, no liability cap, no non-excludable carve-out, and no entity name, company number, registered address or country anywhere on the site (§5.8) — `:123` offers a postal address "on request" without a channel.
- Reproduction: `Select-String -Path app\legal\[slug]\page.tsx -Pattern "law|jurisdiction|court|address"` → one address sentence.
- Proposed fix: §9 D1 decides the jurisdiction; the document then names the operator, the law, the venue and the carve-out (and, for EU/UK buyers, the ODR/consumer-protection platform facts).
- **Status.** open

### R16-12 — Four promises with no surface, no metric and no notification · P2 · content

- Evidence: "actioned within 72 hours" (`:110`) — the report queue has no age metric and no alert (`app/api/admin/reports/route.ts`, `take: 50`); "material changes will be announced on the site" (`:96`) — no announcement surface exists (§5.7); "usually reply within 2–3 business days" (`:122`) — no ticket system, no inbound verification (U16-2); "we can only discuss billing details with the payer" (`:116`) — no verification procedure (R16-5). R05-7 (settled) made the intake *arrive*; these are the promises about what happens after it does.
- Reproduction: `Select-String -Path app\api\admin\reports -Pattern "age|createdAt"` (filtering only) and §5.7's grep.
- Proposed fix: either instrument the promise (a queue-age number the operator sees, a notice surface cheap enough to actually use) or soften the string — `17` §7 lists the runbooks that would make them keepable.
- **Status.** open

### R16-13 — The legal pages are absent from `sitemap.xml` · P3 · legal

- Evidence: `lib/sitemapData.ts:17-27` emits `/` and `/elements/:sym` only; `app/sitemap.ts:12-15` documents the policy as "static routes + all 122 element pages"; `app/robots.ts` allows crawling. So the documents a buyer (or a rights holder) most needs to find are the only public pages with no discovery path beyond the footer.
- Reproduction: `curl.exe -s https://www.periodictable.lol/sitemap.xml | Select-String "legal"` → nothing.
- Proposed fix: append the three legal URLs (stable, non-churning) with no `lastModified` rather than a faked one — the file already refuses to fake timestamps.
- **Status.** open

### R16-14 — Retention is undisclosed, indefinite where it exists, and has no deletion path · P3 · privacy

- Evidence: `EmailLog` and `AuditLog` rows are deliberately kept in production (`doc/PROD-READINESS-CHECKLIST.md` §residue `:296-302`) and carry recipient addresses and event details; `Payment`/`Startup` relations are all `Restrict` with no cascades (checklist §J6); nothing in the legal copy states a retention period and no admin route deletes anything (`app/api/admin/*`: reports, startups/moderate, outbox/retry, stats). Schema-level retention design belongs to `12`; the disclosure gap is here.
- Reproduction: `Select-String -Path prisma\schema.prisma -Pattern "onDelete"` → `Restrict` throughout; `Get-ChildItem app\api\admin -Recurse` → four routes, none destructive.
- Proposed fix: state a retention period per category on the privacy page and enforce the shortest one that still satisfies accounting/audit needs.
- **Status.** open

## 8. Acceptance criteria

Batch-4 rule: an item is accepted only with a checkable artefact. Nothing in §7 is fixed, so the boxes below are the *exit conditions* for the operator's fix pass.

- [ ] `/legal/privacy` returns 200 in production and its categories, purposes, processors and retention periods match §5.4/§5.5 row for row — settles R16-1, R16-2, R16-14.
- [ ] The About "Data & cookies" paragraph either loses the city/country clause or the product starts collecting and disclosing it — settles R16-2.
- [ ] A disclosure of client-side third-party requests exists, and either a consent gate or a no-third-party-call default — settles R16-3.
- [ ] A written tax position exists, is visible at checkout, and the receipt carries the tax line and the seller identity — settles R16-4, U16-1.
- [ ] The statement descriptor is set and published, and one documented lookup answers "who is this charge from" — settles R16-5.
- [ ] The consent text, version and timestamp are stored with the payment — settles R16-6, R16-7.
- [ ] Contact page names an agent (or explicitly drops the DMCA frame) — settles R16-8.
- [ ] The launch board contains only rows the seed policy allows, and the About claim matches whatever that is — settles R16-9.
- [ ] `:18`/`:68` vocabulary is either defined or replaced; one sentence states what "own" means — settles R16-10.
- [ ] An operator identity line (entity, address, jurisdiction) and a governing-law clause exist, or §9 D1 records the deliberate absence and the reason — settles R16-11.
- [ ] Each of the four promises has a surface that shows it being kept, or the string is gone — settles R16-12.
- [ ] `sitemap.xml` lists the legal documents — settles R16-13.
- [ ] The nine operator decisions in §9 are recorded, each with a date, in `FINDINGS.md`'s resolution column — the batch's real exit.

## 9. Open questions — decisions only the operator can make

Each is a legal question the software cannot answer and this review will not guess. They are listed once here and repeated in the batch summary.

- **D1 Jurisdiction and legal form.** Which law governs, which courts, and does the operator trade as an individual or through an entity? Determines `:39`'s enforceability, the address requirement (`:123`), the EU/UK consumer rules that apply, and whether an imprint is mandatory (Germany, among others, requires one). *Evidence for the decision:* §5.8 (no identity anywhere), R16-11.
- **D2 Tax registration and display.** Is the operator registered anywhere for VAT/sales tax, is Stripe Managed Payments' merchant-of-record filing accepted as the whole answer, are displayed prices tax-inclusive or plus tax, and does the receipt need a tax line/tax id? *Evidence:* R16-4, §5.2 (nothing is collected), §5.6 (no line on the receipt), U16-1.
- **D3 Refund window.** Confirm "final, no discretionary refunds" as the policy — which then requires the withdrawal-right waiver wording and the carve-out — or grant a window; also the standing chargeback posture. *Evidence:* R16-6, R16-7, `:88-89`, batch 1's corrected copy (R05-6, cited not re-reported).
- **D4 Age limit.** Keep 18+ with attestation only, or change the limit; and if 18+ stays, what the operator will do when a charge is disputed by a parent — the answer determines what R16-6 must record. *Evidence:* `:59`, §3.3.
- **D5 Seeded listings at launch.** Publish demo listings for real brands (marked as such) or start empty; the choice changes what `:25` may say. *Evidence:* R16-9; decision shared with `19`.
- **D6 Analytics.** Enable Plausible (and then the consent/notice decision), keep it off, or self-host; and whether hover previews (Microlink) and Google favicons stay as-is, get proxied, or get disclosed. *Evidence:* R16-3, §5.5.
- **D7 Service of process and statement descriptor.** Which address (or agent) can be served, which descriptor a buyer sees, and which mailbox is the legal one. *Evidence:* R16-5, R16-8, R16-11.
- **D8 Retention and erasure.** How long emails, click hashes, audit rows, mail logs and payment records live, and what happens when someone asks for deletion. *Evidence:* R16-14, §5.4; schema side in `12`.
- **D9 Lottery/prize framing.** Whether to keep "stake/crown/own" and rely on the "paid advertising" characterisation, or to spend one copy pass on vocabulary and one memo on the question — §5.9 is the material a lawyer would need. *Evidence:* §5.9, R16-10.

## 10. Cross-references

- `05` §7 **R05-6** — the refunds copy now describes the reversal; cited, and §3.2 A20 evaluates the *legal sufficiency* of that wording rather than re-reporting the contradiction. `05` §7 **R05-7** — report/waitlist mail exists with `REPORT_NOTIFY_EMAIL`/`WAITLIST_EMAIL` (`README.md:41`, `.env.example:18`); this doc reviews the 72-hour promise *above* it (A25, R16-12) as settled.
- `01`–`04` — arrival and checkout surfaces; the consent act is re-read here only for what it legally proves (§3.3).
- `11` — the receipt and the intake mails as documents; `10` owns deliverability.
- `12` — retention, deletion and PII shape as schema concerns; R16-14 is the disclosure half.
- `14` — `ADMIN_TOKEN`, `CLICK_SALT`, webhook secret handling; no secret is printed in this doc.
- `07`/`08` — Managed Payments (merchant of record) and the reversal ledger; A18/A21 cite them.
- `13` — cron and the outbox as the mechanism behind the intake promises.
- `17` — the operator's side of R16-5 (payer lookup), R16-8 (takedown execution) and R16-12 (queue age); the dispute-evidence runbook.
- `19` — D5 (seed or not) and launch-day copy.
- `doc/PROD-READINESS-CHECKLIST.md` — cited by section: §J (report → hide round-trip, raw-IP fix), §residue (`:296-302`, retention evidence), `:15` (demo seeder and `db:clear-demo`), `:42,181` (`/manage` backend-only, `REFUNDED` never written), `:156,198` (alerting channel).

## 11. Change log

- 2026-09-15 — authored 2026-09-15 against 9681dcb. Read-only pass: no application code, config, test, migration or legal page changed. Live probes at 2026-09-15T07:14:30Z UTC (§5.1) and the home-page probe (§5.1 row 5). 14 findings (R16-1…R16-14) registered with evidence; 5 UNKNOWN rows (§12); §9 lists nine decisions for the operator.

## 12. UNKNOWN log

| ID | Unknown | What settles it |
| --- | --- | --- |
| U16-1 | Whether the Stripe account has a tax registration and how Managed Payments files; whether a statement descriptor is configured; whether Stripe acts as merchant of record for this account as `lib/stripe.ts:40,47,55` assumes | Stripe dashboard → **Settings → Tax**: registration list and "Stripe manages tax filing" state; **Settings → Payments → Statement descriptor**; **Settings → Emails → Receipts** — record the three readings with a date |
| U16-2 | Whether `abuse@`, `payments@`, `hello@` actually receive mail (inbound routing, not just a verified sending domain) | Resend dashboard → Domains (verified records, reply-to) **and** the Cloudflare Email Routing / mailbox rules for `periodictable.lol` — paste the routing table into the finding |
| U16-3 | Which region and role the Neon database and the Vercel deployment use, and whether a DPA exists for each processor | Neon console → Project settings → Region/roles; Vercel → Project settings → Functions region; the processors' DPA acceptance pages in the operator's accounts |
| U16-4 | The production retention baseline: how many `Payment.email`, `ClickEvent`, `EmailLog.to`, `AuditLog` rows exist today and their age spread | With `DATABASE_URL` set, one read: `psql "$DATABASE_URL" -c "select (select count(*) from \"Payment\"), (select count(*) from \"ClickEvent\"), (select count(*) from \"EmailLog\"), (select count(*) from \"AuditLog\"), (select min(created_at) from \"ClickEvent\");"` — no `.env` exists in this worktree, so it was not run |
| U16-5 | Whether the plan's video/oversight of the product's "bid" vocabulary has been seen by counsel (there is no memo in `doc/`) | A dated counsel note in `doc/`, or the operator's recorded decision in D9 |
