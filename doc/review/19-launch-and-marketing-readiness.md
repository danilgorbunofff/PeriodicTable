# Phase 19 — Launch and marketing readiness

| | |
| --- | --- |
| Phase | 19 |
| Batch | 5 |
| Status | draft — first pass |
| Date reviewed | 2026-09-15 |
| Commit reviewed | `9681bdcbff2435ef258224c52000e0f8d6089f5c` |
| Reviewer | review agent |

**Required-but-not-run probes.**

| Probe | Why not run | Cleanup |
| --- | --- | --- |
| Per-platform unfurl render (X, LinkedIn, Slack, Discord, iMessage, WhatsApp, Telegram) | Needs a post or a preview submission from a real account; no product account exists (R19-9) and the render is U01-1 | Delete the post |
| Search Console: verify `www`, submit the sitemap, read Pages | Operator's Google account — still U01-2; and no verification token is served, so the method in use is U19-4 | None |
| Support inbox send-and-read (`abuse@`, `payments@`, `hello@`) | No mail credentials or Resend/DNS console here (R19-7, U19-2) | None |
| The announcement itself | This doc plans operator actions; it does not take them (Q2) | n/a |
| Plausible funnel or realtime read | Nothing to read: no script is served (§5.6, R19-1) | None |
| `npx vitest run` baseline | This worktree cannot load the runner config (`Cannot find module 'vitest/config'` from the npx cache), so the documented ~470 passed / 71 skipped / 6 line-ending failures could not be reproduced here (§5.12) | None |
| Local `next dev -p 3221` | No `.env` here and none may be created, so every page would render its unconfigured branch — evidence would describe a product nobody can visit. Live production substituted (§5.1) | Stop the server; none was started |

## 1. Scope

`01-discovery-and-unfurl.md` owns the **mechanics** of unfurl: metadata, card assets, canonicals, `robots.txt`, sitemap generation, tile links. This phase owns **launch-day sufficiency** — whether the product survives the three minutes after it is announced. A stranger clicks a link: is there a card; does the landing page say what this is; is the offer's price legible; are the rules reachable from the place the buyer is standing; can a human be reached; and does the operator hold a script that names, per line, an owner and a stop condition.

In scope: unfurl quality **as launched**, the landing story, the first impression of a zero-stake board, the seed-or-not provenance decision, pricing clarity, FAQ existence, legal-link reachability, support inboxes, product social accounts, Search Console and sitemap submission, UTM discipline, and the T-0 operating plan with a rollback trigger. Out of scope: card construction (01 §7), price arithmetic and the reclaim ladder (04 §7), legal copy (16), and the money path itself (06/07/08, not yet authored) — this doc only checks what the buyer was told before they paid.

**This doc is read-only.** Nothing is seeded, announced, submitted, deployed or configured by the review. §8 and §9 are plans; the operator executes them, and §11 records what actually happened.

## 2. Actors

- **The operator** — one human with the Stripe, Neon, Vercel, Resend, Cloudflare and registrar consoles, running §8 tonight under time pressure. Every line of §8 carries them as owner; §9 is their decision list.
- **The first visitor** — arrives from a share with ~30 seconds of patience (§4). They never see the review; they see §5.5.
- **The buyer** — solves Turnstile, picks an amount, lands on Stripe; needs the price ladder, the refund rule and "is this a bet" answered *before* the redirect (`components/Modals.tsx:490`).
- **The holder** — after a settled payment: a receipt, a rank, the knowledge that a rival can outbid them, and someone to mail.
- **The support reader** — whoever answers `abuse@`, `payments@`, `hello@`, against published response times.
- **The moderator** — report triage under `ops/takedown.md`, cadence deferred to 20.
- **Card consumers and crawlers** — Twitterbot, facebookexternalhit, Discordbot, LinkedInBot, Slackbot, WhatsApp, TelegramBot (§5.2), and Google.

## 3. Intended behaviour

The product's own launch set makes three claims this doc tests against production.

1. **The announce has something to show.** `doc/phase-5-launch/README.md:4` — "Goal: launch with a table that already looks alive, every dollar flow proven on prod, and a one-flag rollback." The seed that produces "alive" is four unchecked boxes (`doc/phase-5-launch/01-seed-instrument.md:6-9`) with the acceptance bar "Fresh visitor sees ≥6 colored tiles incl. 1 exotic + 1 elite + full activity feed" (`:17`). Production today is the opposite of that (§5.5), and the ledger's own position is that this is fine: "the site is empty and ready to announce" (`doc/PROD-READINESS-CHECKLIST.md:272`).
2. **The launch is measured.** Plausible pageviews plus seven named custom events and a funnel dashboard (`01-seed-instrument.md:12-13`), acceptance "Events fire in staging (Plausible debug) for all 7 actions" (`:18`). Delivery depends on one variable (`app/layout.tsx:25-31`), and today it is absent (§5.6).
3. **Day-1 operations have a script.** The gate (`doc/phase-5-launch/02-launch-gate-runbook.md:6-11`), the deploy order and the kill switch (`ops/rollback.md:3-42`) exist and are specific: one flag flips checkout to the waitlist, webhook stays live, ~2 minutes, immediate lever is a Stripe key roll. The script is good; four lines of it are stale (§5.10, R19-8).

## 4. The path, walked

What actually happens tonight if the site is announced as it stands, in order, with what can be proven from here.

- **T-60m, pre-flight.** `node scripts/check-prod-env.mjs` + `npm run audit:prod` (`ops/rollback.md:34`) — the only step-0 either runbook has, and the launch-day doc's own deploy order does not include it (`02-launch-gate-runbook.md:14`).
- **T-30m, the seed decision.** Either `tsx prisma/launch-seed.ts` runs (8–12 real startups, a contested `C` ladder at $50/$24/$9, a 6-row 72-hour activity backlog, no notification email) or the board is announced empty. The undo exists and is safe — `scripts/clear-demo-data.ts` is dry-run by default and provenance-guarded — so the decision is reversible, but it is recorded nowhere (R19-2, Q1).
- **T-0, announce.** There is no product-owned social account anywhere in the repo (§5.9) and no `twitter:site` on the card metadata (`lib/shareMeta.ts:39`), so the post comes from a human account with no attribution link: zero `utm_` strings exist in the repository. The doc the runbook points at for the post, `03-launch-post.md`, does not exist (§5.10).
- **T+0–3, first click.** The bytes are right: `/` 200 / 152029 B with title, description, 9 `og:*` tags, `og:image` `/og/home`, one canonical (§5.4); `/og/home` 200 `image/png` 22345 B; all eight card-consumer and crawler user agents get byte-identical documents (§5.2). What the visitor then reads: hero "Put your startup on the table. Literally." with CTA "Claim an element · from $5"; three stat tiles rendering `—`; the activity strip "No stakes yet — the first claim lands here."; the Table Order panel with a header and a caption and **nothing between them** (§5.5).
- **T+3, "what is this?"** The footer carries `/legal/about`, `/legal/rules`, `/legal/contact` (`components/FooterBar.tsx:17,19,21`, rendered at `app/page.tsx:435`). The help modal — the only "how it works" surface — ends in plain text, `About & disclaimer · Rules & payments` (`components/Modals.tsx:41`), with no links. The element page, where a buyer actually chooses a symbol, has zero `/legal/` links (§5.7). There is no FAQ at any URL, and none is reserved: `/faq` 404s and the token `FAQ` appears exactly once in the repository, in the plan that asked for it (`00-REVIEW-PLAN.md:152`).
- **T+5, someone pays $5.** Out of scope to judge the money path; in scope is what they were told: "stake from $5", "Top up anytime — past stake still counts", "Outbid? Pay only the difference back to #1" (`components/Modals.tsx:20-22`), and a board captioned "total staked across every element" (`components/WorldOrder.tsx:125`) that on day 1 totals `$0`. No page states the ladder, the $1 take floor or what an outbid holder keeps (R19-6).
- **T+10, someone asks a question that isn't FAQ-shaped.** It lands at an address published with an SLA (~72 hours for abuse, 2–3 business days for hello, `app/legal/[slug]/page.tsx:110,122`). Nothing here proves a mailbox, an alias or a human exists behind any of them, and the sender address differs by surface (`HANDOFF.md:603` `info@` vs `lib/email.ts:59` `hi@` vs `app/api/report/route.ts:65` `abuse@`) — so a reply may arrive from an address the recipient never wrote to (R19-7).
- **T+1h, the operator looks at the dashboard.** There is none. No pageview and none of the seven events can fire, because `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is not reaching the served HTML (§5.6, R19-1). Launch day — the one day that cannot be re-measured — produces no data.
- **T+1d, the operator reads Google.** Unknowable from inside the repo (U01-2, U19-4). What can be said: `robots.txt` declares the sitemap, the sitemap builds 123 URLs with no `lastmod` while the board is empty, and the served HTML carries no verification token, so ownership must be DNS-verified and nothing records whether it is (§5.8, §5.9).

## 5. Live evidence

All readings **2026-09-15**, against `https://www.periodictable.lol`. Three full probe sets agree (07:13:03Z, 07:30:05Z, 09:27:09Z); sizes and counts below are from the second, the string counts from a saved body of the same document.

**5.1 Route census, 07:30:05Z.**

```
GET /                      -> 200 152029    GET /legal/about  -> 200 20454
GET /legal/rules           -> 200 21777     GET /legal/contact -> 200 15955
GET /robots.txt -> 200 155   GET /sitemap.xml -> 200 8206   GET /og/home -> 200 22345
GET /elements/C -> 200 13128 GET /api/stats -> 200 99
GET /api/board?tab=crowns -> 200 2          GET /api/activity -> 200 2
GET /faq -> 404 14319        GET /pricing -> 404 14319
```

`/api/stats` body: `{"elementsTotal":122,"claimedElements":0,"unclaimedElements":122,"stakeCount":0,"totalStakedUsd":0}`. Crown board `[]`, activity `[]`. The three sets agree byte-for-byte on every counter above.

**5.2 Crawler parity.** Eight user agents — `Twitterbot`, `facebookexternalhit`, `Discordbot`, `LinkedInBot`, `Slackbot-LinkExpanding`, `WhatsApp`, `TelegramBot` and a `curl/8` control — each returned **identical 152029 bytes** with one `og:image`. There is no cloaking and no bot-specific branch; what the operator sees in a browser is what every card consumer is given.

**5.3 Card asset and headers.** `/og/home` → 200, `Content-Type: image/png`, `Content-Length: 22345`, `X-Content-Type-Options: nosniff`, and `Cache-Control: s-maxage=86400, stale-while-revalidate=604800` — a bad card would be cached at the edge for a day. The home CSP is already shaped for both third parties: `script-src 'self' 'unsafe-inline' https://plausible.io https://challenges.cloudflare.com`, `connect-src 'self' https://plausible.io`, `frame-src https://challenges.cloudflare.com`, with `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'` and HSTS `max-age=63072000; includeSubDomains`. (The Turnstile entries are load-bearing, not dead — see 20 §7 R20-2.)

**5.4 Served copy.** `<title>` `periodictable.lol — Put your startup on the table. Literally.`; description "Every element is an open leaderboard, ranked by total stake."; `og:title` "periodictable.lol — put your startup on the table" (lowercase variant of the title — cosmetic, noted, not raised); `og:description` = the description; `og:url` `https://www.periodictable.lol`; `og:site_name`, `og:type website`, `twitter:card summary_large_image`. Marker census on the saved body: `og:image` ×1, `og:url` ×1, `rel="canonical"` ×1, `href="/elements/` ×122, `href="/legal/about"` ×1, `href="/legal/rules"` ×1, `href="/legal/contact"` ×1, `Claim an element` ×1, `from $5` ×1. Visible text length 2841 characters. Element page `/elements/C`: self-canonical, `og:title` "Carbon (C)", `href="/legal/` **×0**.

**5.5 The empty state, as rendered.** The hero's three stat tiles read `—` (`components/StatsCard.tsx:22-29` — `UNKNOWN` is chosen deliberately so the card never claims "we counted, and there are none", `:5-21`). The activity panel has an honest empty header: `No stakes yet — the first claim lands here.` (`lib/activityFace.ts:47`). The **Table Order panel does not**: `components/WorldOrder.tsx` renders an error line (`:74-76`), five skeleton rows while data is missing (`:77-79`), the rows (`:80`), and the caption (`:125`) — with no zero-row branch at all, so an empty board is a titled panel over blank space. The same product already writes the missing line for a single element: "no bids yet · $5 to be the first" and "No bids yet — $5 puts your logo here until someone outbids you." (`components/TerritoryView.tsx:98,159-161`).

**5.6 Analytics.** Zero occurrences of the string `plausible` in the served home document. The tag is conditional on one variable — `app/layout.tsx:25` reads `NEXT_PUBLIC_PLAUSIBLE_DOMAIN`, `:29-31` renders the script only if it is truthy — and the event helper is a silent no-op without it (`lib/analytics.ts:17-28`); `.env.example:35-36` states the contract: "Without domain, pageviews/events are no-ops." `lib/phase5.test.ts:32` pins the no-op so it cannot regress silently. The ledger's inventory lists the variable as present but **optional** (`doc/PROD-READINESS-CHECKLIST.md:437`); `vercel env ls` can only prove presence for a Sensitive value, so the served HTML is the evidence: the launch is unmeasured.

**5.7 Legal reachability.** Three links on the landing page (footer, `components/FooterBar.tsx:17,19,21`), one in the checkout modal (`components/Modals.tsx:490` — "Secure payment via Stripe · it's an ad buy, not a bet · … agree to the rules & terms"). The help modal prints `About & disclaimer · Rules & payments` as **plain text**, not links (`components/Modals.tsx:41`). The element detail page links none of the three (§5.4). All three pages return 200 (§5.1), and the contact page carries the three addresses and the postal line (`app/legal/[slug]/page.tsx:110,116,122,123`).

**5.8 Discovery surfaces.** `robots.txt` 155 B: `User-Agent: *`, `Allow: /`, and `Disallow: /pay/ /api/dev/ /api/jobs/ /api/manage/`, then `Sitemap: https://www.periodictable.lol/sitemap.xml` (`app/robots.ts:5-18`). `sitemap.xml` 8206 B, 123 `<loc>`, **0** `lastmod` (`app/sitemap.ts:8-38`) — correct while the DB holds no stakes, per 01 §7 R01-5.

**5.9 Channel and submission markers.** `google-site-verification` ×0 in the served HTML; `utm_` ×0 anywhere in the repository; `FAQ` ×1 in the repository (`doc/review/00-REVIEW-PLAN.md:152`); no product-owned social URL anywhere — the only social URL in the code is generated per user-supplied handle (`lib/validate.ts:114`, `https://x.com/${handle}`); `lib/shareMeta.ts:39` has a `twitter` block with no `site` or `creator`, so a card carries no attribution.
**5.10 The operator's own launch set, checked against reality.** `02-launch-gate-runbook.md:6-12` — all six gate boxes unticked, including `:10` "Legal links + both disclaimers visible; `robots.txt` + sitemap submitted" and `:11` "Rollback rehearsed … deploy <2min". Its deploy order (`:14`) still names "Whop live keys" and "Upstash", while the authoritative runbook names Stripe live keys, Resend, Turnstile and `CRON_SECRET` (`ops/rollback.md:41`) and starts at step 0 with `check-prod-env.mjs` + `audit:prod` (`:34`); it offers "hide stake (`hidden=true` hotfix column)" (`:17`) for a column that has never existed — the field is `moderationState` (`prisma/schema.prisma:75`); and its comms line (`:21`) points at `03-launch-post.md`, which is not in `doc/phase-5-launch/`. `ops/rollback.md` itself is accurate and complete: kill switch `:3-31` (both flags and the fail-closed-by-absence note `:4-12`), the ~2-minute budget and the Stripe key roll as the immediate lever `:13-19`, webhook stays live on purpose `:20-26`, rehearsal split `:27-31`, deploy order `:33-42` (step 0 `:34`, env `:41`, "5. Announce" `:42`), DB incidents and PITR `:44-49`, abuse/refund line `:52-53`.

**5.11 Repo-side facts with no server reading.** `vercel.json` schedules exactly two crons (`/api/jobs/outbox` 04:00, `/api/jobs/screenshot` 04:30); `/api/jobs/reconcile` runs only from the `*/10` GitHub workflow (see 20 §7 R20-7). No error-tracking package is installed (20 §7 R20-6).

**5.12 Probes deliberately not run.** No `next dev` was started: there is no `.env` here, so a local server would render the unconfigured branches and describe a product no visitor can reach; production reads (§5.1-§5.9) are the stronger evidence and are recorded above. `npx vitest run` could not load its config from this worktree (`Cannot find module 'vitest/config'`), so this doc asserts **no** suite result; the review brief's documented baseline is ~470 passed / 71 skipped / 6 failures that are a Windows line-ending artifact in `lib/legalMeta.test.ts` ×5 and `lib/claimFace.test.ts` ×1.

## 6. Failure and edge matrix

| Trigger | Current behaviour | Visitor sees | Operator sees | Acceptable? |
| --- | --- | --- | --- | --- |
| Announce, then open the dashboard | No script served (§5.6) | n/a | No pageviews, no funnel, forever | No — R19-1 |
| Announce with the board empty and no decision recorded | Two docs disagree (§3, §5.10) | Titled panel over blank space (§5.5) | Ambiguity at T-0 | No — R19-2, R19-3 |
| Stranger asks "is this gambling / what if I'm outbid" | No FAQ at any URL (§5.4, §5.9) | Help modal, ends in dead text (§5.7) | Nothing | No — R19-4 |
| Buyer opens the help modal looking for the rules | Plain text, no links (§5.7) | Dead end | Nothing | No — R19-5 |
| Buyer on `/elements/C` wants the rules | 0 `/legal/` links (§5.4) | Must go looking | Nothing | No — R19-5 |
| Buyer wants to know the price ladder before Stripe | Only "from $5" + three modal sentences (§4) | Guesses | Nothing | No — R19-6 |
| Someone mails `hello@` at T+10 | Address published with an SLA (§5.7) | Silence, if no mailbox exists | Nothing | No — R19-7 |
| Operator reads the runbook at T-0 and follows `:17` | Names a column that does not exist (§5.10) | n/a | Wasted minutes under pressure | No — R19-8 |
| Card shared on any platform | Bytes identical for 8 UAs (§5.2); render unknown | Card or text — unverified | Nothing | U01-1 |
| Google crawls the site | robots + sitemap correct (§5.8); submission unknown | n/a | Silence in Search Console | U01-2, U19-4 |
| Chargeback or runaway price during launch | Kill switch ~2 min, key roll immediate (`ops/rollback.md:13-19`) | Waitlist card | Works | Yes |

State as reviewed, commit `9681bdcbff2435ef258224c52000e0f8d6089f5c`.

## 7. Findings

### R19-1 — The launch is unmeasurable: no analytics script reaches the served page

- **Severity.** P1 · **Category.** ops · **Status.** open
- **Evidence.** §5.6 — 0 occurrences of `plausible` in the 152029-byte home document, three probe sets; `app/layout.tsx:25,29-31` (script gated on `NEXT_PUBLIC_PLAUSIBLE_DOMAIN`); `lib/analytics.ts:17-28` (silent no-op); `.env.example:35-36` ("Without domain, pageviews/events are no-ops"); `doc/PROD-READINESS-CHECKLIST.md:437` (variable listed as optional, presence only); `doc/phase-5-launch/01-seed-instrument.md:12-13,18` (seven events, funnel dashboard, acceptance "events fire … for all 7 actions" — all unchecked).
- **Reproduction.** `curl -s https://www.periodictable.lol/ | Select-String -Pattern plausible | Measure-Object` → count 0.
- **Why P1.** Launch day is the only measurement that cannot be re-run. The plan's own acceptance bar is unreachable while this is true, and the fix is a variable plus a redeploy — not code.
- **Proposed fix.** Set `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` in Vercel Production, redeploy, re-run the reproduction until the count is ≥ 1, then confirm one pageview and one `tile_click` in the Plausible realtime view before announcing (U19-3).

### R19-2 — The announce's central claim is undecided and unrecorded: seeded provenance or an empty board

- **Severity.** P1 · **Category.** content · **Status.** open
- **Evidence.** `doc/phase-5-launch/README.md:4` ("launch with a table that already looks alive"); `01-seed-instrument.md:6-9,17` (four unticked seed boxes; "Fresh visitor sees ≥6 colored tiles incl. 1 exotic + 1 elite + full activity feed"); production is the opposite — 0 claimed, 0 stakes, `$0`, empty crown board and feed (§5.1, §5.5); the ledger's position is "the site is empty and ready to announce" (`doc/PROD-READINESS-CHECKLIST.md:272`) and its only open decision is about `Payment` rows (`:296`), not seeding, while the review plan calls seeding "the ledger's own open question" (`doc/review/00-REVIEW-PLAN.md:152`) — the pointer is stale in both directions.
- **Reproduction.** `curl -s https://www.periodictable.lol/api/stats` → all zeros; `curl -s "https://www.periodictable.lol/api/board?tab=crowns"` → `[]`; then grep the repository for a recorded decision — there is none (`Select-String -Path doc\**\*.md -Pattern 'seed or|declare the board empty'`).
- **Why P1.** The announcement's copy depends on the answer, and the operator must choose *before* writing a word of it.
- **Proposed fix.** Decide in §9 Q1 and record the answer, with the date, in §11. The machinery makes either answer safe: `prisma/launch-seed.ts` writes 8–12 real startups with a contested `C` ladder and a 72-hour activity backlog, `scripts/clear-demo-data.ts` reverses it (dry-run by default, provenance-guarded, aborts if anything was notified, paid or moderated). If the answer is "empty", the same decision must be reflected back into `doc/phase-5-launch/README.md` and `01-seed-instrument.md`, and R19-3 fixed so the empty board reads as open rather than unfinished.

### R19-3 — The primary board panel has no empty state, which is the only state it will have on launch day

- **Severity.** P2 · **Category.** ux · **Status.** open
- **Evidence.** §5.5; `components/WorldOrder.tsx:74-79` (error copy, five skeleton rows), `:80` (rows), `:125` (caption) — no zero-row branch; contrast the product's own copy elsewhere: `components/TerritoryView.tsx:98,159-161` and `lib/activityFace.ts:47`.
- **Reproduction.** `curl -s "https://www.periodictable.lol/api/table-order"` → `200 []` (2026-09-15T08:03:29Z), then load `/` and look at the Table Order panel: a header, a caption, and blank space where ranks belong.
- **Proposed fix.** Add the one line the other two panels already have — "No stakes yet — the first claim lands here." — to `WorldOrder`'s empty branch, styled like the activity card's, and pin it the way this codebase already pins component copy: `lib/a11y.test.ts:277,387` scan `components/WorldOrder.tsx` line by line, and the route's shape is covered at `lib/routes.test.ts:119-123` (nothing renders the panel today, so the assertion is a source-scan or a new render test). This is worth doing whichever way Q1 goes: a seeded board still empties the moment the seed is cleared, and an unseeded board shows it to every visitor on day one.

### R19-4 — There is no FAQ, and no URL reserved for one

- **Severity.** P2 · **Category.** content · **Status.** open
- **Evidence.** §5.4 (`/faq` → 404, `/pricing` → 404), §5.9 (`FAQ` ×1 in the repository, in `doc/review/00-REVIEW-PLAN.md:152`); the only explanatory surface is the three-step help modal (`components/Modals.tsx:19-44`), which covers claim/stake/reclaim and nothing else.
- **Reproduction.** `curl -s -o NUL -w "%{http_code}" https://www.periodictable.lol/faq` → `404`; `Select-String -Path app\**,components\**,lib\** -Pattern FAQ` → no hits.
- **Proposed fix.** One static `/faq` route answering the six questions a stranger actually has — what a stake is, what "ranked by total stake" means, what happens when I am outbid, what my money buys (an ad slot, not equity or a bet), refunds and disputes, and what happens to my stake if the product ends (20 §9 Q2, which cannot be answered until that decision exists) — linked from the footer, the help modal and the checkout modal. Until then the help modal's dead text (R19-5) is the whole answer.

### R19-5 — The rules are two clicks away from the footer and zero clicks from nowhere else

- **Severity.** P2 · **Category.** ux · **Status.** open
- **Evidence.** §5.7; `components/FooterBar.tsx:17,19,21` (three links, rendered at `app/page.tsx:435`); `components/Modals.tsx:490` (checkout links "rules & terms" — the one good precedent); `components/Modals.tsx:41` (help modal prints `About & disclaimer · Rules & payments` as text); §5.4 (element page: `href="/legal/` ×0).
- **Reproduction.** `curl -s https://www.periodictable.lol/elements/C | Select-String -Pattern 'href="/legal/' | Measure-Object` → count 0.
- **Proposed fix.** Make `Modals.tsx:41` the same two links the footer has, and add one "Rules & payments" link (plus the FAQ once it exists) to the element detail page's own panel — that page is where a symbol is chosen and where the price ladder is argued.

### R19-6 — Nothing states the price ladder or what an outbid holder keeps

- **Severity.** P2 · **Category.** content · **Status.** open
- **Evidence.** `components/HeroCard.tsx:73` ("Claim an element · from $5"); `components/Modals.tsx:20-22` ("stake from $5… Top up anytime — past stake still counts… Outbid? Pay only the difference back to #1"); `components/WorldOrder.tsx:125` (board captioned "total staked across every element", reading `$0` on day 1); §5.1 (`totalStakedUsd: 0`); the ledger's own `Payment` sample includes an operator-typed `$25` checkout (`doc/PROD-READINESS-CHECKLIST.md:296-302`), i.e. the amount is chosen by the buyer and nothing tells them what the floor is.
- **Reproduction.** Read `/legal/rules` and the help modal and search either for the words "minimum", "$1" or "difference" — the modal has the difference in one sentence, and no surface states the ladder or the floor.
- **Proposed fix.** One paragraph, in the help modal or the FAQ, in the same numbers `04` settled: entry from $5; rank is cumulative, so a holder keeps credit; a takeover must beat the leader by the $1 floor; a hidden stake is excluded from the face and the price (`04` §7 R04-1/R04-2 own the mechanics — this is only the sentence a buyer needs). Cheap, and it removes the one plausible "this felt like a trick" complaint on a $5 impulse buy.

### R19-7 — Three published support channels, no evidence any of them is read

- **Severity.** P2 · **Category.** ops · **Status.** open
- **Evidence.** §5.7; `app/legal/[slug]/page.tsx:110` (`abuse@`, "actioned within 72 hours"), `:116` (`payments@`), `:122` (`hello@`, "reply within 2–3 business days"), `:123` (postal address on request); sender-address divergence across surfaces: `HANDOFF.md:603` (`EMAIL_FROM` = `info@`), `lib/email.ts:59` (default `hi@`), `app/api/report/route.ts:65` (default `abuse@`).
- **Reproduction.** Send one message from outside to each of the three addresses and read what comes back; nothing inside this repository can settle it (U19-2).
- **Proposed fix.** Before announcing: confirm each address exists and forwards to a mailbox a human opens (alias or Resend destination), fix the sender so receipts and replies come from one address that matches `EMAIL_FROM`, and put the same three addresses on the FAQ page so the promise and the inbox cannot drift apart.

### R19-8 — The launch-day script contradicts the runbook that supersedes it, in four places

- **Severity.** P2 · **Category.** ops · **Status.** open
- **Evidence.** `doc/phase-5-launch/02-launch-gate-runbook.md:14` (deploy order names "Whop live keys" and "Upstash" — the provider is Stripe and Upstash is unwired by decision, `doc/PROD-READINESS-CHECKLIST.md:269`) vs `ops/rollback.md:34,41` (step 0 `check-prod-env.mjs` + `audit:prod`; then Stripe/Resend/Turnstile/`CRON_SECRET`); `:17` ("hide stake (`hidden=true` hotfix column)") — no such column has ever existed (`prisma/schema.prisma:75`, `ModerationState`); `:21` points at `03-launch-post.md`, absent from `doc/phase-5-launch/`; `:6-12` all six gate boxes unticked, `:10` including sitemap submission with no submission evidence (§5.8-§5.9).
- **Reproduction.** List `doc/phase-5-launch/` (three files, no `03-`); `Select-String -Path prisma\schema.prisma -Pattern 'hidden='` → no hits.
- **Proposed fix.** Either correct the four lines (`Whop`→Stripe, drop Upstash, `hidden=true`→"set `moderationState = HIDDEN` via admin triage", add the `check-prod-env` step, and write or delete the comms reference) or mark the file superseded by `ops/rollback.md` at its head and tick nothing in it. Do this *before* T-0: under time pressure the operator will read the file with unchecked boxes first.

### R19-9 — No attribution channel and no link tagging: the launch cannot be told apart from silence

- **Severity.** P2 · **Category.** seo · **Status.** open
- **Evidence.** §5.9 — no product-owned social account exists anywhere in the repository (the only social URL is user-supplied, `lib/validate.ts:114`); `lib/shareMeta.ts:39` carries a `twitter` block with no `site`/`creator`, so a card credits nobody; `utm_` ×0 repo-wide; `02-launch-gate-runbook.md:21` expects a launch post the repository does not contain.
- **Reproduction.** `Select-String -Path app\**,components\**,lib\**,doc\** -Pattern 'utm_'` → no hits; grep the card metadata for `twitter:site` → none.
- **Proposed fix.** Fix the channel and the link once, at T-0: one canonical announcement URL per channel, each with `?utm_source=&utm_medium=&utm_campaign=launch` (which also makes the R19-1 funnel readable per channel), and add `twitter:site` to `lib/shareMeta.ts` if an account is created. This is a convention, not code — but it is unrecoverable after the fact, because a launch post's referral data is the only record of where the first cohort came from.

## 8. Acceptance criteria — the T-0 checklist

Owner is the operator unless stated. "GO/NO-GO" is the answer **before** the announcement; a NO-GO line blocks T-0, not the whole day.

- [ ] **Pre-flight passes**: `node scripts/check-prod-env.mjs` and `npm run audit:prod`, with production env — `ops/rollback.md:34` — **GO/NO-GO:** NO-GO if either fails; a failing env check is the one failure that has a runbook.
- [ ] **Webhook destination live**: the Stripe endpoint registered for the seven handled types is still `Active` — `doc/PROD-READINESS-CHECKLIST.md` §7 ("Still to do before announce") — **GO/NO-GO:** NO-GO if it is disabled; a paid claim would not settle.
- [ ] **Kill switch rehearsed**: `PAYMENTS_LIVE=false` → checkout serves the waitlist card → back on — `ops/rollback.md:27-31`, `doc/phase-5-launch/README.md:16` — **GO/NO-GO:** GO with the caveat the runbook states itself: the *off* half is verified on production (`ops/rollback.md:27-31`), the *on* half is proven by the $1 smoke, not by the rehearsal.
- [ ] **Seed or not, decided and written down** — §9 Q1, R19-2 — **GO/NO-GO:** NO-GO while the decision is unrecorded; it decides every line below that mentions the board.
- [ ] **If seeded**: `tsx prisma/launch-seed.ts` run, then `/api/stats` shows the stakes and `/api/board?tab=crowns` shows the ladder — `01-seed-instrument.md:6-9,17` — **GO/NO-GO:** GO only if the board renders at least one contested element; undo is `npx tsx scripts/clear-demo-data.ts` (dry-run first).
- [ ] **Board panel says something when empty** — R19-3 — **GO/NO-GO:** GO either way; a NO-GO on this line means shipping a panel that reads as unfinished to the first cohort.
- [ ] **Analytics live**: domain variable set, redeployed, `plausible` present in the served document, one pageview and one `tile_click` visible in realtime — R19-1, U19-3 — **GO/NO-GO:** NO-GO; the launch day cannot be re-measured.
- [ ] **Search Console**: property verified (DNS method, since no token is served — §5.9, U19-4), sitemap submitted, Pages read — `02-launch-gate-runbook.md:10`, U01-2 — **GO/NO-GO:** GO with the sitemap submitted; the index reading is post-launch and slow.
- [ ] **Support reachable**: one test message to each of the three addresses, answered by a human, and the sender address made consistent — R19-7, U19-2 — **GO/NO-GO:** NO-GO if any bounces; the published SLAs would then be false.
- [ ] **Announcement written before it is posted**, naming channel, copy and the tagged link — R19-9, and replace or delete the missing `03-launch-post.md` reference — **GO/NO-GO:** NO-GO while the runbook points at a file that does not exist.
- [ ] **Legal reachable where the buyer is**: `/legal/about`, `/legal/rules`, `/legal/contact` all 200 (§5.1) and the checkout modal's "rules & terms" link intact (`components/Modals.tsx:490`) — **GO/NO-GO:** GO; the help-modal and element-page gaps stay open as R19-5.
- [ ] **Discovery surfaces as expected**: `robots.txt` carries the `Sitemap:` directive and `/sitemap.xml` is 200 with 123 URLs (§5.8) — **GO/NO-GO:** GO.
- [ ] **Card verified on the channel actually used**: paste the announcement URL into the channel and read the rendered card — U01-1; §5.2 proves the bytes, not the render — **GO/NO-GO:** GO only after a human looks at it.
- [ ] **A watcher is named and reachable for four hours** — §9 Q3 — **GO/NO-GO:** NO-GO without a name; the rollback trigger below is worthless unattended.
- [ ] **Announce** — `ops/rollback.md:42` step 5 — the last step, after everything above.
- [ ] **T+30m read**: `/api/stats`, the activity feed, Plausible realtime, and all three inboxes — four readings, one of which should be non-empty if anything landed.
- [ ] **Rollback trigger, pre-agreed**: any of — checkout 5xx above the standing rate, a settled charge with no stake or no email, a hidden listing visible anywhere, or any P0-class defect. Action: `PAYMENTS_LIVE=false` (~2 min, `ops/rollback.md:13-19`); if it must stop *now*, roll the `STRIPE_SECRET_KEY` in the Stripe dashboard — provider-side and immediate.
- [ ] **T+24h read**: Plausible funnel (depends on R19-1), Search Console Pages (U01-2), the inbox. This is also the batch-2/3/4 re-verification trigger named in §11.

## 9. Open questions — the operator decision list

1. **Seed, or announce an empty table?** (§3, §5.5, R19-2; the review plan calls this "the ledger's own open question", `00-REVIEW-PLAN.md:152` — the ledger's actual open decision, `doc/PROD-READINESS-CHECKLIST.md:296`, is about `Payment` rows, not seeding.) **Recommended: seed.** The evidence: the product's own goal is a table that "already looks alive" (`README.md:4`); every other empty-state surface is already honest, so the only weak panel is the board (R19-3) and its fix is one line; the seed writes real startups, no notification email is sent, and `scripts/clear-demo-data.ts` reverses it by provenance. The counter-case is real too — ten friendly logos on day one is a claim about traction that is not true, and the ledger has already chosen truth over gloss once (`doc/PROD-READINESS-CHECKLIST.md:306-311`). **If the answer is empty**, fix R19-3 and rewrite the launch-set goal line so the two documents stop disagreeing, then announce with the honest empty copy standing behind a "be the first" CTA.
2. **Announce where?** No product account exists (R19-9) and the planned post document is missing. **Recommended:** one primary channel owned by a named human — the operator's own account — plus the one community where the product's audience already is; hold a `Show HN` until the board is non-empty, because a frontier of the product *is* the board. Each post carries its own UTM link, and §11 records the channel and date after the fact.
3. **Who watches what, for how long?** **Recommended:** one named human for four hours from T-0, pre-authorised to flip the kill switch without asking. Their four readings: Stripe (charges and failures), the site (a manual claim attempt, then `/api/stats`), Plausible realtime, and the inboxes. After four hours, the same readings once at T+24h. Nobody watches the DB directly; `/api/jobs/config` and the GitHub workflow red/green are the standing signals (20 §7 R20-6/R20-7).
4. **Where does the FAQ live?** **Recommended:** a static `/faq` route (R19-4), linked from the footer, the help modal and the checkout modal, because the alternative — folding it into `/legal/about` — buries answers behind the word "legal".
5. **Does `02-launch-gate-runbook.md` get corrected, or does `ops/rollback.md` supersede it?** (R19-8.) **Recommended:** correct the four stale items, because the operator runs the gate file tonight and a file with six unticked boxes and a nonexistent comms target invites exactly the improvisation a launch cannot afford. The answer belongs in §11 either way, since the file is not owned by this phase.

## 10. Cross-references

- Plan §1, §2 ("Batch 5 — launch and after"), §3 (template), §4 (severity), §5 row 19.
- `01-discovery-and-unfurl.md` owns the unfurl mechanics and the two inherited unknowns this phase consumes: U01-1 (per-platform render) and U01-2 (Search Console property, sitemap submission, index coverage); 01 §7 R01-1/R01-4 are settled and not re-raised here.
- Batch 3's `13` "Jobs and cron" and batch 4's `18` "Observability, analytics, alerts" (`00-REVIEW-PLAN.md:226,231`) will own the cadence and instrumentation questions this doc only points at; 20 §7 R20-6/R20-7 carry them until those batches land.
- `doc/phase-5-launch/README.md`, `01-seed-instrument.md` and `02-launch-gate-runbook.md` are the operator's launch set: this phase measures them against production and finds the seed boxes unticked (§3), the analytics acceptance bar unmet (R19-1), and the gate file stale in four places (R19-8) — the set is not rewritten here.
- `ops/rollback.md` is authoritative for the switch, its cost and its order; §8 cites it rather than restating it. `ops/takedown.md` owns the moderation path; its own gap (no site-shutdown clause) belongs to 20 §7/§9.
- Facts settled in `doc/PROD-READINESS-CHECKLIST.md` are cited by section: §7 GO/NO-GO table and "Still to do before announce" (`:355`), "Where the release stands" (`:272`), "Kept deliberately, and one open decision" (`:296`), "What is actually left" (`:306-311`, item 3 = the unproven production card payment), Appendix inventory (`:437`).
- **Documentation drift found while writing:** `00-REVIEW-PLAN.md:152` points at "the ledger's own open question" for seeding; the ledger records no such question (`Select-String -Path doc\PROD-READINESS-CHECKLIST.md -Pattern seed` — ten hits, all procedural). The pointer is recorded here, not corrected there, because the plan is a shared file this batch only edits in §5 rows 19-20.
- Evicted: card mechanics → 01; reclaim arithmetic → 04 §7; legal copy → `16` "Legal, privacy, tax"; the money path → `06`/`07`/`08` "Checkout before payment" / "Payment provider integration" / "Settlement and ledger integrity"; moderation cadence, refunds, retention, backups and the v2 backlog → 20.

## 11. Change log

| Date | Commit | Change |
| --- | --- | --- |
| 2026-09-15 | `9681bdcbff2435ef258224c52000e0f8d6089f5c` | First pass: authored 2026-09-15 against `9681bdcbff2435ef258224c52000e0f8d6089f5c`; written before the batch-2/3/4 fix packs landed — re-verify §6 file:line evidence after they do. R19-1…R19-9 raised; U19-1…U19-5 opened; §8 checklist and §9 decision list written for the operator. Evidence is three agreeing production probe sets of 2026-09-15 (§5.1-§5.9) plus source reads; **no local dev server was run and no `.env` exists here or was created** — §5.12 records the deviation and its reason. |

## 12. UNKNOWN log

| ID | Phase | Category | What is unknown | What settles it |
| --- | --- | --- | --- | --- |
| U19-1 | 19 | ops | What the announcement actually is: channel, account, copy and tagged link — nothing in the repository records it, and the file the runbook names for it does not exist (§5.9-§5.10, R19-9) | Write it, post it, then append the channel, date and URL to §11 |
| U19-2 | 19 | ops | Whether `abuse@`, `payments@` and `hello@` deliver and are answered, which decides whether the 72-hour and 2–3-day promises are true (`app/legal/[slug]/page.tsx:110,122`) | Send one message from an outside address to each, then read the replies — and the Resend dashboard for delivery events |
| U19-3 | 19 | ops | Whether `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is set in Vercel Production (for a Sensitive value `vercel env ls` proves presence only) and which property the seven events land in | Vercel → Environment Variables (read, do not display); set if absent → redeploy → `curl -s https://www.periodictable.lol/ \| Select-String plausible` ≥ 1 → Plausible → Realtime |
| U19-4 | 19 | seo | How the `www` property is verified, given no token is served: whether a DNS TXT record exists at all (§5.9) | Search Console → Settings → Ownership verification, plus the registrar's DNS page or `dig TXT www.periodictable.lol` |
| U19-5 | 19 | ux | Whether a zero-stake board reads as "new and open" or "broken" to a stranger — the empirical half of Q1, and the input to R19-3's priority | The T+24h funnel once R19-1 is fixed; failing that, a five-person five-second test on the empty and seeded versions, recording which word they use first |
