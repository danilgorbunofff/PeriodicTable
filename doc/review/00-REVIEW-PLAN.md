# Review plan — periodictable.lol

**What this file is.** The plan that generates the review. It defines the phase documents under `doc/review/`, the coverage model that proves nothing is missed, the template every phase doc follows, the severity and evidence rules, and the order the phase docs get written and acted on. It is not the review itself — it is the machine that produces it. `doc/review/TEMPLATE.md` is the skeleton each phase doc starts from; `doc/review/FINDINGS.md` is the register every finding lands in.

**Why it exists.** `doc/PROD-READINESS-CHECKLIST.md` is a *launch gate*: it answers "can we announce?" for the money path and a handful of ops items, in the order the blockers appeared. It is not a review of the product. Nothing has ever walked the app end to end with the question "what is wrong or unfinished here?" — every prior pass was triggered by a specific failure (the 502, the Turnstile loader, the missing scope). This set is that missing pass: twenty phase documents covering the lifecycle from a crawler's first request to what happens to a holder's stake if the site ever shuts down, each one evidence-bound.

**Non-goals.** No redesign. No v2 features (`doc/phase-6-v2/` stays where it is). No Next 16 / React 19 migration (recorded as post-launch debt in the ledger; this plan must not pull it forward). No code changes *inside* a review pass — a pass produces findings, and fixes happen afterwards as separate ordered steps. No re-deriving facts the ledger already settled: that is what "cite, do not repeat" in the evidence rules means.

---

## 1. Coverage model

"Every possible phase and aspect" is only a claim if it can be falsified. Three axes, and every cell of the first two must be claimed by exactly one phase doc or explicitly marked `n/a` with a reason. The third axis is a per-doc checklist, because an aspect can be covered in depth and still miss an actor.

**Axis 1 — lifecycle stage.** What is happening to the product, in order.

| # | Stage |
| --- | --- |
| S1 | Arrival — a crawler, a link unfurl, or a first visit |
| S2 | Orientation — understanding what this is before investing attention |
| S3 | Browsing the board |
| S4 | Inspecting one element |
| S5 | Deciding to buy |
| S6 | Checkout and payment |
| S7 | Settlement — money becomes ownership |
| S8 | Defending ownership, being outbid, reclaiming |
| S9 | Post-purchase communication |
| S10 | Support and recovery — refund, dispute, manage, unsubscribe |
| S11 | Stewardship — operator running the thing |
| S12 | After — growth, debt, and end of life |

**Axis 2 — system layer.** Where the behaviour actually lives.

| # | Layer | Where it lives |
| --- | --- | --- |
| L1 | Client | `components/`, `lib/cameraInteract.ts`, `lib/gridNav.ts`, browser behaviour |
| L2 | HTTP edge | `app/api/**/route.ts`, `app/*/page.tsx`, headers, caching, `next.config.mjs` |
| L3 | Domain logic | `lib/pricing.ts`, `lib/settle.ts`, `lib/applyPayment.ts`, `lib/recompute.ts`, `lib/money.ts`, `lib/moderation.ts`, `lib/reservations.ts` |
| L4 | Data | `prisma/schema.prisma`, `prisma/migrations/0000…0006`, aggregates, Neon, backups |
| L5 | Async | `lib/outbox.ts`, `lib/email.ts`, `lib/jobs.ts`, `/api/jobs/*`, `vercel.json` crons |
| L6 | Providers | Stripe, Resend, Cloudflare Turnstile, Upstash, Vercel |
| L7 | Operations | config and secrets, deploy, rollback, monitoring, cost |
| L8 | Trust | legal pages, privacy, tax, abuse handling, moderation |

**The matrix.** Rows are stages, columns are layers, cells hold the doc that owns that intersection.

| Stage \ Layer | L1 Client | L2 Edge | L3 Domain | L4 Data | L5 Async | L6 Providers | L7 Ops | L8 Trust |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 Arrival | 01 | 01 | n/a | n/a | n/a | 01 | 01 | 16 |
| S2 Orientation | 02 | 02 | n/a | n/a | 10 | n/a | n/a | 16 |
| S3 Browsing | 03 | 03 | 04 | 03 | 03 | n/a | 15 | 03 |
| S4 Inspecting | 04 | 04 | 04 | 04 | n/a | n/a | n/a | 04 |
| S5 Deciding | 06 | 06 | 04 | 06 | n/a | 06 | 06 | 04 |
| S6 Checkout | 06 | 07 | 08 | 08 | n/a | 07 | 07 | 16 |
| S7 Settlement | 08 | 08 | 08 | 08 | 08 | 08 | 08 | 16 |
| S8 Ownership | 09 | 09 | 09 | 09 | 09 | n/a | 17 | 09 |
| S9 Comms | 10 | 10 | 09 | 10 | 10 | 10 | 10 | 16 |
| S10 Recovery | 17 | 11 | 08 | 12 | 10 | 07 | 17 | 16 |
| S11 Stewardship | 17 | 11 | n/a | 12 | 13 | 15 | 17 | 16 |
| S12 After | 20 | 20 | 20 | 20 | 20 | 20 | 18 | 20 |

Cross-cutting docs that own no single cell but must be read against every row: **05** (accessibility and every user-facing string), **11** (API contracts), **12** (data layer), **13** (jobs), **14** (security), **15** (performance, concurrency, cost), **18** (observability), **19** (launch readiness).

**Actor checklist.** Every phase doc reviews its scope against all actors that can reach it, and says `n/a` where an actor cannot:

| Actor | Cares about |
| --- | --- |
| Anonymous visitor | honesty, speed, clarity, no dead ends |
| Paying customer | does my money do what the page said |
| Defending holder | not being silently outbid; the reclaim path working |
| Losing bidder | being told, being able to come back |
| Operator | can I see it, fix it, undo it |
| Attacker | free stakes, forged events, IDOR, spam relays, SSRF |
| Crawler / unfurl bot | can it see and re-share this correctly |
| Email recipient | deliverability, unsubscribe, receipt legality |
| Payment provider | signature, idempotency, retry semantics |
| Future maintainer | can this be understood and changed safely |

**Cells that are deliberately thin.** `n/a` in the matrix is a claim like any other: each phase doc restates its own `n/a`s with a one-line reason, so a wrong `n/a` is visible rather than invisible.

---

## 2. Phase documents

Each entry: what it owns, what it must actually inspect (real paths, not categories), and what it must produce beyond the common template. The template in §3 supplies the sections; the exit criteria in §4 apply to all of them.

### Batch 1 — the visible surface (written first)

**01 — Discovery and unfurl** · `doc/review/01-discovery-and-unfurl.md`
Owns S1 in every layer. Inspect: `app/sitemap.ts` (what actually appears — element pages, profile pages, legal pages; whether `/pay/` and `/api/` are excluded; `lastModified` truthfulness), `app/robots.ts`, metadata in `app/layout.tsx` (`metadataBase`, title template, description, canonical, `openGraph`, `twitter`), the absence of any `app/opengraph-image.*` or per-route image, `app/s/[domain]/page.tsx` generateMetadata, `app/elements/[sym]/page.tsx` generateMetadata, JSON-LD (present or absent), and hostname consistency (`periodictable.lol` vs `www.`). Produce: the exact unfurl a stranger sees on X, Slack, Discord, iMessage and LinkedIn, captured as evidence; a sitemap-vs-database diff (122 elements — how many are in the sitemap, with which URLs); the canonical/duplicate-content answer for `/` vs `/s/[domain]` vs `/elements/[sym]`.

**02 — Shell and static surfaces** · `doc/review/02-shell-and-static-surfaces.md`
Owns S2. Inspect: `app/layout.tsx`, `components/FooterBar.tsx`, `HeroCard.tsx`, `StatsCard.tsx`, `ActivityCard.tsx`, `WorldOrder.tsx`, `LiveDataNotice.tsx`, `Card.tsx`, `ChunkyButton.tsx`, `IcyInput.tsx`, `Modal.tsx`, `Toast.tsx`; `app/legal/[slug]/page.tsx` and every legal slug that exists versus every slug the footer links; the *absence* of `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx` and `app/loading.tsx` (verify against the running site: what does a bad URL actually render, and does a client-side throw show a branded page or Next's default); responsive behaviour at 360/390/768/1024/1440; keyboard-only traversal of the shell; reduced-motion; the empty/loading/error states of every data card. Produce: a per-viewport screenshot set and a written answer to "if the API dies right now, what does a visitor see at each surface" — the old false-green failure (a failed element fetch rendered as *unclaimed*) is the reason this question is asked of every card, not just one.

**03 — The board** · `doc/review/03-the-board.md`
Owns S3. Inspect: `components/PeriodicGrid.tsx`, `Tile.tsx`, `TableCamera.tsx`, `BackgroundSymbols.tsx`, `lib/cameraInteract.ts`, `lib/elements.ts`, `lib/elements.json`, `lib/boards.ts`, `lib/familyFill.ts`, `lib/exoticThemes.ts`, and the read APIs `app/api/board`, `app/api/elements`, `app/api/table-order`, `app/api/search`. Verify the data itself: 122 elements present, one row per symbol, correct atomic numbers, names, masses, categories, grid coordinates, lanthanide/actinide handling; every tile state reachable and visibly distinct (unclaimed, claimed, leader, hidden, unlisted); pool and count rendering matches `/api/stats`; zoom/pan bounds and reset; mobile gestures; search behaviour for exact symbol, name, partial, miss, and a symbol that does not exist. Produce: a tile-state inventory with a screenshot each, a stated performance budget and the measured numbers for a cold mobile load of the board, and the answer to "what does a visitor see when the board API fails" — per tile, not as a whole.

**04 — Element detail and pricing** · `doc/review/04-element-detail-and-pricing.md`
Owns S4 and the pricing half of S5. Inspect: `app/elements/[sym]/page.tsx`, `app/api/elements/[sym]`, `app/api/activity`, `lib/pricing.ts` (`rankStakes`, `validateJoin`, the $5 floor, the take-price ladder), `lib/relTime.ts`, `lib/reservations.ts`, `lib/ownership.*` tests, `lib/audit.ts`. The questions this doc must answer with numbers, not prose: what price does the page *quote* for an element, what price does the server *enforce*, and do they ever disagree — including the specific case the operator raised, where the UI says "Reclaim it for **$4.00**" while the modal's floor is $5 and its amount field is free-entry. Also: what an unclaimed element shows, what a claimed one shows, whether a quoted take-price is reserved or recomputed at settlement, and what the activity feed claims versus what `ActivityLog` holds. Produce: a price-truth table (quoted vs enforced, per state), the reservation semantics in plain sentences, and a finding for every disagreement found.

**05 — Accessibility and every visible string** · `doc/review/05-accessibility-and-content.md`
Cross-cutting; owns no cell but reviews all of Batch 1 and re-runs against later batches. Inspect: `lib/a11y.test.ts`, contrast and focus in `components/*`, `lib/gridNav.ts` keyboard model, `Modal.tsx` focus trap and inert background, `Toast.tsx` live regions, `IcyInput.tsx` labels and error association, touch targets, motion and `prefers-reduced-motion`, and — systematically — *every user-facing string in the product*: hero, tiles, modals, checkout errors, legal pages, emails, empty states, toasts, and the numbers they print (currency, time, counts). Produce: a WCAG 2.2 AA pass/fail per surface with the specific criterion cited; a copy inventory listing every string that is inaccurate, ambiguous, or contradicts the code; and a list of every place the UI states a fact the server does not guarantee.

### Batch 2 — the money path

**06 — Checkout before payment** · `doc/review/06-checkout-before-payment.md`
Owns S5 and the client half of S6. Inspect: `components/Modals.tsx`, `components/TurnstileWidget.tsx`, `app/api/checkout/route.ts` before the provider call, `lib/validate.ts`, `lib/abuse.ts`, `lib/rateLimit.ts`, `lib/rateStore.ts`, `lib/ip.ts`, `lib/flags.ts`. Enumerate the validation order and the exact response for each rejection (amount, domain format, blocked domains, social handle, email, Turnstile, rate limit, paused flag, provider down), then walk each one in a browser and confirm the message a human sees matches the reason the server gave. Also: silent-bail paths (the known class where the modal ignores a submit), double-submit and idempotency, abandonment and resume, the free-entry amount field versus the implied fixed price, mobile keyboard and scroll behaviour inside the modal, and the waitlist path when the flag is off. Produce: a rejection matrix with the observed UI text for each server reason, and a finding for every silent failure.

**07 — Payment provider integration** · `doc/review/07-payment-provider-integration.md`
Owns L6 for S6 and S10. Inspect: `lib/stripe.ts` (`getProviderMode`, session creation, `verifyStripeSignature`, `paymentIdFromStripePayload`, event matching), `app/api/checkout/route.ts` provider branch, `app/pay/[paymentId]/page.tsx`, `app/api/dev/pay/route.ts`, `prisma/migrations/0006_stripe_provider`, and the legacy Whop rows still in `Payment`. Questions: success/cancel return paths and what each renders; what a customer who abandons sees later; session expiry and reuse; two sessions for one payment row; `providerRef` uniqueness under retry; live vs test vs dev mode detection and what each exposes; the key-rotation and webhook-secret-rotation procedures and how a stale value would be *detected* rather than assumed; statement descriptor and Stripe-side branding; currency and tax handling at the provider. Produce: a mode table (dev/test/live × what is reachable), the two rotation procedures written as runnable steps, and the exact symptom a stale webhook secret produces so it is recognisable in the future.

**08 — Settlement and ledger integrity** · `doc/review/08-settlement-and-ledger-integrity.md`
The highest-value doc in the set. Owns S6–S7 across L3/L4 and the async half of S7. Inspect: `app/api/webhooks/stripe/route.ts` (signature, classification order, money validation, reference checks, duplicate handling, rejected-vs-retryable status codes), `lib/settle.ts`, `lib/applyPayment.ts`, `lib/money.ts`, `lib/recompute.ts` (`rankStakes`, `rerankElementTx`, the three denormalized aggregates, `assertLedgerInvariants`), `lib/txn.ts` (`MONEY_TX`), `lib/idempotency.*`, `lib/reconcile.ts`, `/api/jobs/reconcile`, `lib/audit.ts`, and the `ProviderEvent` uniqueness contract. Verify by reading and by test: that a paid event cannot apply without the stake, that duplicates and out-of-order deliveries cannot double-apply, that a reversal always beats a paid classification, that money and reference mismatches are rejected loudly and terminally, and that the aggregate trio can never be left half-written. Then the state questions: the six dead `PENDING` rows and the twelve-row `Payment` table as it stands, what an operator is supposed to do with each shape, and whether the reconcile job can ever be the thing that silently changes a status (it is documented read-only and PAID-only — verify that in code). Produce: the invariant list as enforceable statements with the code that enforces each, the reconciliation story for every non-`PAID` row shape, and an explicit statement of what happens to a customer whose payment settles while the stake application fails.

**09 — Ownership, competition and reclaim** · `doc/review/09-ownership-and-competition.md`
Owns S8–S9 in the domain and data layers. Inspect: `lib/pricing.ts` ladder rules, `lib/recompute.ts` rank semantics, `lib/ownership.test.ts`, `FirstClaim`, `Element.currentLeaderId`, `Element.totalPoolUsd`, `Element.stakeCount`, `lib/reservations.ts`, and the outbid/reclaim UI path. Answer precisely: who owns an element, what "reclaim" means in this product (does the displaced holder pay again, or top up, or is it only a new challenger paying the ladder price), why a $5 floor applies to a reclaim that the UI advertises at $4, what happens to the displaced holder's money, what a tie does, what a self-outbid does, what two simultaneous buyers of the same element do (concurrency — with the Serializable transaction retry path exercised), and whether the outbid email link can arrive with the form already filled (the operator's stated requirement) or forces retyping. Produce: the ownership rules written as a rules table a support agent could answer from, then one finding for every rule the code does not implement.

**10 — Email and notifications** · `doc/review/10-email-and-notifications.md`
Owns S9 in async and provider layers, plus the unsubscribe half of S10. Inspect: `lib/email.ts` (every template), `lib/outbox.ts` and `/api/jobs/outbox`, `vercel.json` cron, `EmailLog`, `/api/unsubscribe`, `app/api/manage/*`, `/api/waitlist`, `/api/emails/preview`, and the Resend configuration behind it. Verify: every trigger fires exactly once under retry (dedupe keys); suppression and unsubscribe are respected on every template including receipts; the receipt contains everything a buyer needs (amount, element, what they own, reference, refund policy, contact); deliverability is real (SPF/DKIM/DMARC on the sending domain, from-name, reply-to, `List-Unsubscribe` one-click); bounces and complaints have somewhere to go; and the preview route is not a public spam relay. Produce: the message inventory (trigger → template → recipient → dedupe key → suppression rule), a delivered-mail evidence set from a real inbox including spam-folder placement, and findings for every template that can be sent twice, send to an unsubscribed address, or state something untrue.

### Batch 3 — the platform underneath

**11 — API contracts** · `doc/review/11-api-contracts.md`
Every route in `app/api/` — `activity`, `admin/outbox/retry`, `admin/reports`, `admin/reports/[id]`, `admin/startups/[domain]/moderate`, `board`, `checkout`, `dev/pay`, `elements`, `elements/[sym]`, `emails/preview`, `jobs/config`, `jobs/outbox`, `jobs/reconcile`, `jobs/screenshot`, `manage/request`, `manage/session`, `manage/verify`, `report`, `search`, `startups/[domain]`, `stats`, `table-order`, `unsubscribe`, `waitlist`, `webhooks/stripe` — documented as: method, auth model, inputs, validation, status codes, error shape (`lib/api.ts`, `lib/contracts.test.ts`), rate limit, caching, and whether failure is distinguishable from emptiness. Specifically: no route may return a success-shaped response when its dependency failed; no public route may leak an email address (`/api/startups/[domain]` is the one to check hardest); every `/api/admin/*` route is authenticated and audited; `/api/dev/pay` and `/api/emails/preview` are dead in production. Produce: a complete route table with observed responses, and a finding for every route whose failure mode is indistinguishable from a legitimate empty state.

**12 — Data layer** · `doc/review/12-data-layer.md`
`prisma/schema.prisma` model by model (`Element`, `Startup`, `Stake`, `Payment`, `ProviderEvent`, `OutboxEvent`, `EmailLog`, `AuditLog`, `ActivityLog`, `ClickEvent`, `FirstClaim`, `Report`, and every other), plus enums (DB lowercase vs API uppercase — a documented trap), uniques, indexes against the actual query patterns, relation delete behaviour, the denormalized aggregate trio, and money representation. Then the operational half: `prisma/migrations/0000_baseline` … `0006_stripe_provider` replayed onto an empty database and onto a copy of production; `scripts/migrate-if-production.mjs` and the build-time migration behaviour; seeds (`prisma/launch-seed.ts`, `lib/demoData.ts`); PII retention and deletion across `Payment`, `EmailLog`, `Stake`, `ActivityLog`; Neon PITR and an actual restore drill; connection pooling and timeouts. Produce: the schema's promise list with the constraint that enforces each, and a written, dated restore drill result — not a plan to do one.

**13 — Jobs and cron** · `doc/review/13-jobs-and-cron.md`
`vercel.json` schedules exactly two jobs (`/api/jobs/outbox` 04:00, `/api/jobs/screenshot` 04:30) while the codebase also exposes `/api/jobs/reconcile` and `/api/jobs/config`; `/api/admin/outbox/retry` is manual. Establish for each: what it does, its auth (`CRON_SECRET`), its bound on work per run, its idempotency, its timeout versus `maxDuration`, what happens when it fails, and who finds out. Answer directly: is reconcile supposed to be scheduled, and if not, what is the operator cadence; what happens to a missed run; whether the outbox can back up invisibly; whether any job can overlap itself. Produce: a job inventory with schedule, auth, bound, failure visibility, and a finding for every job whose failure is currently nobody's responsibility.

**14 — Security** · `doc/review/14-security.md`
Threat model first, then each attacker goal: free stake via `/api/dev/pay`; forged or replayed webhook; IDOR on `manage` tokens, payments, reports, or startup profiles; spam relay through `report`, `waitlist`, `manage/request`, `emails/preview`; SSRF through the screenshot/preview worker taking a user-supplied domain; XSS through domain, title, or social fields rendered into the board or emails; enumeration of customer emails. Then the controls: `next.config.mjs` headers and CSP (including the known dead Turnstile entries), Turnstile fail-open, rate limiting with Upstash unwired (`lib/rateStore.ts`, the `degraded` finding from `/api/jobs/config`) and what fail-open costs, secret inventory and rotation, `ADMIN_TOKEN` transport and strength, magic-link token entropy/expiry/single-use (`lib/manage.ts`), signature replay windows, dependency advisories and their tripwires, log hygiene, and error-message leakage. Produce: a threat table (goal → path → control → residual risk), and findings ranked by exploitability.

**15 — Performance, concurrency, cost, resilience** · `doc/review/15-performance-concurrency-cost.md`
Core Web Vitals on a cold 4G mobile load of `/` and one element page, with the board's 122 tiles and camera animations accounted for; bundle composition; the DB query plan behind the board and element pages; N+1 risks; cache headers; cold-start behaviour of the money path; a concurrency exercise on one element (two claims, a claim during settlement, a reclaim during a takeover); failure injection for Stripe, Resend and Neon (what the customer sees, what the ledger does); `maxDuration` versus the real worst case in settlement; and the cost model at 10 / 100 / 1 000 checkouts per day across Vercel, Neon, Stripe and Resend, including the screenshot worker. Produce: measured numbers with the command that produced them, a concurrency result, and a stated launch-day ceiling — the load beyond which behaviour is unknown rather than merely untested.

### Batch 4 — trust and operations

**16 — Legal, privacy, tax** · `doc/review/16-legal-privacy-tax.md`
Every page under `app/legal/[slug]` read against what the software actually does: terms, privacy, refunds, and whatever else exists. Then the gaps: is there a refund policy and does it match the reversal code; is there a privacy policy that describes the real data flows (email, payment reference, stake history, click log) and the real processors (Stripe, Resend, Neon, Vercel, Cloudflare); is consent captured for whatever analytics runs (`lib/analytics.ts`); is the operator's identity and contact address published; is VAT/sales tax decided and, if charged, collected (Stripe Tax) and shown on the receipt; is the statement descriptor recognisable; what does the product's own framing ("bid", "outbid", "crown", "own an element") imply legally, and does anything resemble a lottery or prize competition in a way a regulator would read differently than the site does. Produce: a claims-vs-reality list for every sentence in the legal pages, and an explicit list of decisions only the operator can make (jurisdiction, tax registration, refund window, age limit).

**17 — Operator tooling and runbooks** · `doc/review/17-operator-tooling-and-runbooks.md`
What the operator can see and do: `/api/admin/*`, `ADMIN_TOKEN` handling, `scripts/rehearse-release.sh`, `scripts/clear-demo-data.ts`, `prisma/launch-seed.ts --fresh`, and the manual procedures the ledger already references. Then the runbooks that must exist: stuck payment, webhook failures, stale signing secret, refund and chargeback, dispute evidence, hiding or unlisting content, moderating a report, rotating each secret, redeploy and rollback (including the honest truth that a migration cannot be rolled back — 0005/0006 have no down path), database down, email outage, abuse wave, and site-down comms. Each runbook must be executable by someone who is not the author, in a stressful moment, with copy-paste commands and stated expected output. Produce: the runbook set as findings (missing, incomplete, or wrong), plus an access inventory — which credentials exist, who holds them, and what happens if the holder is unavailable.

**18 — Observability, analytics, alerts** · `doc/review/18-observability-analytics-alerts.md`
What would be visible if something broke at 03:00: structured logging coverage on the money path (the 502 diagnosis worked *because* the route logged — check every comparable path for the same property), error tracking (present or absent), uptime monitoring, job-failure notification, outbox depth, webhook failure, alert thresholds and who receives them. Then business visibility: which metrics exist, whether `/api/stats` tells the truth, what the operator would look at on launch day, and what analytics collect client-side with what consent. Produce: a monitoring gap list ordered by "what breaks silently today", a proposed launch-day dashboard defined in terms of queries that already exist, and a finding for every failure that currently has no owner and no alarm.

### Batch 5 — launch and after

**19 — Launch and marketing readiness** · `doc/review/19-launch-and-marketing-readiness.md`
The announce itself: unfurl quality on every platform, the landing story, whether an empty board with zero stakes is the right first impression or whether the product needs seeded provenance (the ledger's own open question), pricing clarity for a stranger, FAQ existence, legal links reachable from where a buyer actually is, support inbox ready, social accounts consistent, Search Console and sitemap submitted, UTM discipline, and the launch-day operating plan with a rollback trigger. Produce: a T-0 checklist with an owner and a go/no-go answer for each line, and the decision list for the operator (seed or not; announce where; who watches what).

**20 — Post-launch and debt** · `doc/review/20-post-launch-and-debt.md`
The register of everything knowingly deferred, with the condition that makes each one due: Next 16 / React 19 and the two critical advisories with their tripwires; dead Turnstile CSP entries; unused `WHOP_*` env vars; the six dead `PENDING` rows and the twelve-row `Payment` table; the three stake-less `PAID` rows; the absence of error tracking; reconcile not scheduled. Then the longer horizon: support and moderation cadence, refund and dispute cadence, retention and backups, growth experiments, the v2 backlog in `doc/ROADMAP.md`, and the two questions nothing has answered yet — does the game ever end, and what happens to holders' money if the site is shut down.

---

## 3. The template

Every phase doc is written from `doc/review/TEMPLATE.md`, which is exactly these sections in this order. A section with nothing to say keeps its heading and says `None found` or `Not applicable — reason`, so an empty section is a statement rather than an omission.

1. **Header** — phase number, title, batch, status, date, commit reviewed, reviewer.
2. **Scope** — what this doc owns (quote the matrix cell), what it explicitly does not own, and the paths it inspected.
3. **Actors** — the actor checklist from §1 with `n/a` reasons.
4. **Intended behaviour** — what the code means to do, with `file:line` for each claim.
5. **The path, walked** — the real sequence a user or system takes, step by step, with the requests, responses, and state changes at each step. Written so someone who has never opened the repo can follow it.
6. **Live evidence** — dated command output, screenshots, DB reads, or provider console readings. Every claim in §4 and §7 must be traceable to a line here or to a `file:line`.
7. **Failure and edge matrix** — for each failure mode: trigger, current behaviour, what a user sees, what an operator sees, acceptable or not.
8. **Findings** — numbered `R<phase>-<n>`, each with severity, category, one-line summary, evidence pointer, reproduction, proposed fix, and status. Same text lands in `doc/review/FINDINGS.md`.
9. **Acceptance criteria** — the observable conditions under which this phase is done, each written so it can be tested rather than read.
10. **Open questions** — anything only the operator can answer, phrased as a decision with options and a recommendation.
11. **Cross-references** — ledger sections, other phase docs, tests, and prior review artifacts that must not be contradicted.
12. **Change log** — one line per revision, so a re-run of this phase is auditable.

---

## 4. Rules

**Severity.**
- **P0 — blocks announce.** Money can be lost, created, or misrepresented; customer data can leak; the product is legally exposed; a failure is silent in a way that cannot be detected.
- **P1 — must fix before announce.** Visible dishonesty, a dead end for a paying customer, an operational blind spot the operator cannot work around, an accessibility failure on the primary path.
- **P2 — first week.** Real but survivable: rough copy, missing convenience, non-critical perf, a runbook gap with a workaround.
- **P3 — backlog.** Polish, debt, nice-to-have.

**Categories.** `money`, `correctness`, `security`, `privacy`, `legal`, `ux`, `a11y`, `perf`, `ops`, `content`, `seo`, `data`, `testing`.

**Evidence.** No claim without one of: a `file:line`, a dated live probe output, a database read, or a provider console reading. Where none is possible, the item is marked `UNKNOWN` together with the exact command or dashboard step that would settle it. Secrets are never printed into a doc — a probe that needs one references it by name and states what its presence was proven by. Facts already settled in `doc/PROD-READINESS-CHECKLIST.md` are cited by section, never re-derived: a second, drifting copy of the same fact is worse than no copy.

**Read-only by default.** A review pass inspects; it does not fix, and it does not mutate production. Any probe that would write — a test payment, a webhook replay, a moderation action — is listed in the phase doc's findings as a required-but-not-run step, with its expected residue and how to clear it, and is executed only on the operator's explicit go-ahead.

**Batch discipline.** One batch in flight. A batch is done when: every cell it owns has a doc, every finding has evidence and a register entry, the doc set is committed, and a one-page summary has been delivered. Fixes start only after the operator approves a batch, in severity order, as separate steps with tests, and each fix cites the finding it closes.

**Batching.**

| Batch | Docs | Theme | Why here |
| --- | --- | --- | --- |
| 1 | 01–05 | Visible surface | The operator's own condition before paying for anything: nothing visibly unfinished |
| 2 | 06–10 | Money path | The part that must not be wrong when real money moves |
| 3 | 11–15 | Platform | Everything the money path rests on |
| 4 | 16–18 | Trust and operations | What must be true before strangers arrive |
| 5 | 19–20 | Launch and after | What happens on and after T-0 |

**Sequencing note for the operator's $5 test.** The real card payment (J4) is the one thing that cannot be scripted, and it is deliberately *not* first. Batch 1 fixes what a buyer would see; Batch 2 fixes what a buyer would hit. Running J4 after Batch 1 and the checkout-facing half of Batch 2 is the cheapest order, because every finding discovered by that payment is then a real defect rather than a known one being rediscovered.

---

## 5. Status tracker

Updated whenever a doc is written, revised, or its findings change state. `—` means not started.

| Doc | Title | Batch | Status | P0 open | P1 open | Findings | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 00 | Review plan (this file) | — | draft | — | — | — | 2026-09-14 |
| 01 | Discovery and unfurl | 1 | draft | 0 | 0 | R01-1…R01-8 (3 P2, 5 P3) | 2026-09-14 |
| 02 | Shell and static surfaces | 1 | draft | 0 | 0 | R02-1…R02-7 (5 P2, 2 P3) | 2026-09-14 |
| 03 | The board | 1 | draft | 0 | 0 | R03-1…R03-4 (4 P3) | 2026-09-14 |
| 04 | Element detail and pricing | 1 | draft | 0 | 0 | R04-1…R04-4 (1 P2, 3 P3) | 2026-09-14 |
| 05 | Accessibility and content | 1 | draft | 0 | 0 | R05-1…R05-8 (2 P2, 6 P3) | 2026-09-14 |
| 06 | Checkout before payment | 2 | — | — | — | — | — |
| 07 | Payment provider integration | 2 | — | — | — | — | — |
| 08 | Settlement and ledger integrity | 2 | — | — | — | — | — |
| 09 | Ownership and competition | 2 | — | — | — | — | — |
| 10 | Email and notifications | 2 | — | — | — | — | — |
| 11 | API contracts | 3 | — | — | — | — | — |
| 12 | Data layer | 3 | — | — | — | — | — |
| 13 | Jobs and cron | 3 | — | — | — | — | — |
| 14 | Security | 3 | — | — | — | — | — |
| 15 | Performance, concurrency, cost, resilience | 3 | — | — | — | — | — |
| 16 | Legal, privacy, tax | 4 | — | — | — | — | — |
| 17 | Operator tooling and runbooks | 4 | — | — | — | — | — |
| 18 | Observability, analytics, alerts | 4 | — | — | — | — | — |
| 19 | Launch and marketing readiness | 5 | — | — | — | — | — |
| 20 | Post-launch and debt | 5 | — | — | — | — | — |

---

## 6. Relationship to the existing documents

- **`doc/PROD-READINESS-CHECKLIST.md` — authoritative, unchanged in role.** It remains the launch gate and the source of settled facts. This set adds a pointer to `doc/review/` and one line per finding that changes a gate answer, referencing the `R`-id. It does not absorb the phase docs and must not be rewritten by them.
- **`doc/project-review/` — historical.** Its findings, remediation phases and validation matrix describe the pre-Stripe state and the fixes that followed. Nothing in it is deleted: the review docs cite it where a past fix is what makes a current behaviour correct, and say so explicitly instead of re-reporting it as new.
- **`doc/REVIEW.md`, `doc/phase-*/`, `doc/ROADMAP.md`, `doc/ARCHITECTURE.md`, `doc/DESIGN-SYSTEM.md`** — build-phase history and design intent. Phase docs read them for expected behaviour, and flag it when the code has moved on.
- **`doc/review/FINDINGS.md`** — the single register. Every finding from every phase doc, with id, severity, category, status, evidence pointer, and the fix commit once closed.
