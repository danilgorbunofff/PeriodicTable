# PeriodicTable strict review findings

## Executive assessment

The project has strong product intent, strict TypeScript, clean lint output, a recognizable design system, and useful pure pricing tests. Those strengths are outweighed by financial and data-integrity defects that make live payments unsafe. The most serious risks are not cosmetic: an unverified caller can overwrite an existing startup identity, a payment can be marked paid before stake application succeeds, statusless webhook payloads are treated as successful payments, and quoted leadership is not guaranteed through settlement.

### Severity summary

| Severity | Count | Meaning |
|---|---:|---|
| P0 Blocking | 7 | Unsafe to launch or prevents a documented core workflow |
| P1 Major | 20 | Material correctness, reliability, accessibility, or operational defect |
| P2 Minor | 13 | Real defect or maintainability risk with a workaround |
| P3 Polish | 3 | Low-risk cleanup |
| **Total** | **43** | |

## Evidence collected

### Automated checks

| Check | Result | Important qualification |
|---|---|---|
| `npm test -- --run` | 36 passed, 3 skipped | Every database integration test was skipped because `DATABASE_URL` was absent |
| `npm run lint` | Passed | No ESLint warnings or errors |
| `npm run build` | Exit 0 | Emitted repeated Prisma `DATABASE_URL` errors while prerendering 122 element pages |
| Impeccable detector | No mechanical findings | Manual source and live review still found verified accessibility and integrity defects |
| `npm audit --omit=dev` | 5 high vulnerable package nodes | Includes direct `next@14.2.35` plus Prisma/config and bundled PostCSS paths |
| Prisma migrations | Missing | `prisma/migrations` does not exist |
| CI workflows | Missing | `.github/workflows` does not exist |

### Live browser checks

Evidence is stored under `files/browser-review/`.

- `home-desktop.png` shows the app’s API failure states without a database.
- `home-mobile.png` confirms the responsive app shell is usable but initially renders the table at extremely small text.
- `territory-keyboard.png` confirms `/api/elements/C` failure is rendered as “UNCLAIMED TERRITORY” with an active $5 claim CTA.
- `checkout-mobile.png` confirms dense mobile checkout and background controls remaining exposed in the accessibility tree.
- Direct focus probing confirmed that changing the amount field moves focus to the modal “Close” button.

## UI technical audit

| # | Dimension | Score | Key finding |
|---|---|---:|---|
| 1 | Accessibility | 1/4 | Failing contrast, placeholder-only fields, focus resets, non-inert modal background |
| 2 | Performance | 2/4 | Profile N+1 queries and request-bound screenshot work |
| 3 | Responsive design | 2/4 | Mobile shell works, but targets/legal access/table legibility remain weak |
| 4 | Theming | 3/4 | Cohesive tokens with isolated hard-coded drift |
| 5 | Implementation integrity | 1/4 | UI/API contracts and several displayed metrics disagree with product truth |
| **Total** |  | **9/20** | **Poor — major remediation required** |

The implementation does express a product-specific visual system, so this is not a generic-template failure. It fails implementation integrity because multiple polished surfaces present incorrect data or incorrect business state.

## P0 — Blocking findings

### P0-01 — Unverified checkout can overwrite an existing startup identity

- **Location:** `app/api/checkout/route.ts:84-119`
- **Evidence:** The server prefers `body.startup.domain` over the validated URL-derived domain, then upserts by that caller-controlled value and updates `url`, `linkType`, and `email`.
- **Impact:** Any caller can retarget an existing listing, replace its notification address, and redirect paid traffic without proving ownership.
- **Recommendation:** Always derive canonical identity server-side. Allow staking against an existing startup, but keep its profile immutable until an email magic-link management session is verified. Audit all profile mutations.

### P0-02 — Payment is marked paid before stake application is durable

- **Location:** `lib/applyPayment.ts:10-24`
- **Evidence:** `Payment.status` transitions to `paid` in one database operation; `applyStakeTx` runs afterward in a separate transaction.
- **Impact:** Any failure between those operations charges the customer and permanently suppresses retries because later deliveries see a non-pending payment.
- **Recommendation:** Claim the provider event, apply the stake, set `stakeId`, and commit the payment transition in one transaction. Use a separate durable outbox for notifications.

### P0-03 — Statusless Whop payloads are classified as paid

- **Location:** `lib/whop.ts:87-93`, `app/api/webhooks/whop/route.ts:22-28`
- **Evidence:** `whopPayloadIsPaid` returns `true` when it finds no status fields.
- **Impact:** A signed but unrelated event carrying the payment metadata can apply a stake.
- **Recommendation:** Whitelist documented paid event types and successful statuses. Validate provider reference, amount, currency, and local payment state before applying.

### P0-04 — The documented $5 contested-tile join is rejected

- **Location:** `lib/pricing.ts:16-29`, `app/api/checkout/route.ts:91-102`
- **Evidence:** Every new stake on a claimed element with `amount <= leaderTotal` is rejected, even when it meets the $5 floor.
- **Impact:** Users cannot join below #1 despite the legal copy, roadmap, checkout copy, and launch checklist saying they can.
- **Recommendation:** Separate “join ladder” validation from “take lead” validation. A new join accepts `$5+`; a take reservation requires the quoted leader total plus one.

### P0-05 — A paid take-lead quote is not guaranteed at settlement

- **Location:** `app/api/checkout/route.ts:68-100`, `lib/applyPayment.ts:20-25`
- **Evidence:** Leadership price is checked only before creating the provider session. The webhook later applies the amount without asserting the reserved quote or outcome.
- **Impact:** A customer can pay a CTA that says “takes #1” and arrive below #1.
- **Recommendation:** Add a short-lived per-element reservation with an expiry, quoted leader version, amount, and provider session. Reject conflicting take reservations until expiry or completion.

### P0-06 — The emergency payment-pause path is not a real rollback

- **Location:** `lib/flags.ts:5-10`, `components/Modals.tsx:151-156,227-231`, `ops/rollback.md`
- **Evidence:** Payments default to live when flags are absent. “Join waitlist” only displays a toast, stores nothing, promises the user a saved place, and leaves the checkout form visible.
- **Impact:** The documented emergency control fails open and makes a false user-facing claim during an incident.
- **Recommendation:** Default production payments to off unless explicitly enabled, hide/disable checkout controls when paused, and persist a validated waitlist request.

### P0-07 — A clean production database cannot be deployed from the repository

- **Location:** `prisma/schema.prisma`, `ops/rollback.md`; missing `prisma/migrations/`
- **Evidence:** The runbook requires `prisma migrate deploy`, but no migration history exists.
- **Impact:** Clean deploys, upgrades, rollback resolution, and schema provenance are not reproducible.
- **Recommendation:** Create a reviewed baseline migration, test it against an empty database and a copy of current data, and make migration validation a CI/release gate.

## P1 — Major findings

### P1-01 — Concurrent stake application can corrupt leader and aggregate state

- **Location:** `lib/recompute.ts:24-106`
- **Evidence:** Different transactions can upsert different stakes, read incomplete snapshots, independently rerank, and overwrite the same `Element` aggregate under default isolation.
- **Impact:** Two leaders, stale `totalPoolUsd`, stale `stakeCount`, and wrong `currentLeaderId` are possible.
- **Recommendation:** Serialize per-element mutations with a row/advisory lock or serializable transaction plus bounded retry. Verify persisted invariants before commit.

### P1-02 — Existing stakers can create ties that rank nondeterministically

- **Location:** `lib/pricing.ts:21-29,41-43`
- **Evidence:** Tie prevention applies only when `isNew`; existing top-ups can equal the current leader. Ranking sorts only by amount, while database input order is unspecified.
- **Impact:** Leadership can flip unpredictably and differ across API responses or recomputations.
- **Recommendation:** Reject any top-up that would tie a different leader, or define and persist an explicit deterministic tie rule.

### P1-03 — Idempotency is checked after mutable side effects and is race-prone

- **Location:** `app/api/checkout/route.ts:65-136`
- **Evidence:** Element pricing and startup upsert occur before lookup by idempotency key; concurrent inserts rely on a unique violation with no recovery.
- **Impact:** Retries can mutate a startup, fail after price movement, or return 500 under a duplicate race instead of returning the original operation.
- **Recommendation:** Resolve and bind idempotency at the start of a transaction, fingerprint the request, and return the stored result for matching retries.

### P1-04 — Provider retry and partial configuration paths are broken

- **Location:** `app/api/checkout/route.ts:127-167`, `app/api/dev/pay/route.ts:11-14`, `lib/whop.ts:8`
- **Evidence:** A pending Whop idempotency retry returns `/pay/{id}`, which is the dev simulator. Checkout enables Whop only with key and secret, while the simulator disables itself when only the API key exists.
- **Impact:** Provider failures and partial environment configuration strand pending payments.
- **Recommendation:** Store/resume the real provider checkout URL, centralize provider readiness validation, and fail startup on partial production configuration.

### P1-05 — Social checkout cannot pass server validation

- **Location:** `components/Modals.tsx:117-120`, `lib/validate.ts:49-61`
- **Evidence:** The client sends `https://{handle}.social`; the server’s social branch expects a raw handle matching `[a-zA-Z0-9._]`.
- **Impact:** One of the two advertised checkout modes is unusable.
- **Recommendation:** Send a canonical raw handle in the shared request contract and let the server construct the destination URL and identity.

### P1-06 — Startup search response does not match the client contract

- **Location:** `app/api/search/route.ts:38-42`, `components/SearchPill.tsx:8-10,31-59`
- **Evidence:** The API returns startup `{domain,name}` while the client expects `symbol`, `elementName`, `logo`, and `amount`.
- **Impact:** Startup rows render undefined values and selecting one cannot open an element.
- **Recommendation:** Define one shared search result schema and decide which ranked element each startup result opens.

### P1-07 — API failures are not represented by an error-aware typed client

- **Location:** `lib/api.ts:1`, all SWR consumers
- **Evidence:** `fetcher` blindly calls `r.json()` and never checks `r.ok` or validates response shape.
- **Impact:** Error bodies may be consumed as business data, JSON parse failures become opaque, and components implement inconsistent failure handling.
- **Recommendation:** Add a structured `ApiError`, status checking, request IDs, and runtime response validation at the client boundary.

### P1-08 — Element-detail failure is displayed as an unclaimed element

- **Location:** `components/TerritoryView.tsx:26-34,83-96,179-183`
- **Evidence:** `data?.stakes ?? []` enters the empty-state branch before the error UI, which only exists in the claimed branch.
- **Impact:** During an outage, users are invited to buy already-claimed inventory at the wrong price.
- **Recommendation:** Make loading, error, empty, and populated states mutually exclusive; never derive business emptiness from missing data.

### P1-09 — Homepage stats display the wrong quantities and units

- **Location:** `app/api/stats/route.ts:13-20`, `components/StatsCard.tsx`
- **Evidence:** `elementsLive` counts all elements, `totalBids` counts stake rows but is rendered with a dollar sign, and `onSale` counts distinct startups but is used as claimed-element count.
- **Impact:** Every displayed headline metric is materially misleading.
- **Recommendation:** Define exact metric names and compute claimed elements, payment/stake count, and staked USD independently.

### P1-10 — Table Order and board tabs do not implement documented rankings

- **Location:** `components/WorldOrder.tsx:21-42`, `app/api/board/route.ts:11-79`
- **Evidence:** Table Order sums only current leader amounts, “By Element” sorts total pool rather than biggest single stake, and Early Adopter sorts startup creation time then labels its largest stake as the first claim.
- **Impact:** Public leaderboards award the wrong users and conflict with product copy.
- **Recommendation:** Move ranking queries server-side, aggregate all stakes for spend, rank by leader amount for By Element, and derive early-adopter medals from stake creation order.

### P1-11 — Early-adopter truth is not representable in the schema

- **Location:** `prisma/schema.prisma` `Stake`; `app/api/board/route.ts:61-79`
- **Evidence:** `Stake` has no `createdAt`; `Startup.claimedAt` cannot identify first claimant per element.
- **Impact:** The shipped Early Adopter surface cannot be made correct without a migration and backfill policy.
- **Recommendation:** Add immutable stake creation time and an explicit first-claim/medal record or deterministic backfill.

### P1-12 — Profile outbound navigation breaks destinations and attribution

- **Location:** `app/s/[domain]/page.tsx:92-95`
- **Evidence:** “Visit site” reconstructs `https://{domain}` instead of using `Startup.url` or `/go/{stakeId}`.
- **Impact:** Social profiles and URLs with paths break; profile clicks bypass the advertised click counter.
- **Recommendation:** Choose a representative active stake and route through `/go/{stakeId}`, preserving the stored destination.

### P1-13 — Profile rendering has an unbounded N+1 query pattern

- **Location:** `app/s/[domain]/page.tsx:33-43`
- **Evidence:** The page runs one leaderboard query for every held element, up to 122 additional queries.
- **Impact:** High-spend profiles can become slow or exceed serverless/database limits.
- **Recommendation:** Fetch all relevant element stakes in one query and group in memory or use a bounded aggregate query.

### P1-14 — Preview generation is not connected to payment completion

- **Location:** `lib/screenshots.ts`, `app/api/jobs/screenshot/route.ts`, `lib/applyPayment.ts`
- **Evidence:** Comments and docs promise enqueue-on-paid behavior, but no payment path schedules the job.
- **Impact:** New claims do not automatically receive persisted previews.
- **Recommendation:** Emit a durable outbox job after the stake transaction and process it asynchronously.

### P1-15 — Screenshot job authentication and execution model are unsafe

- **Location:** `app/api/jobs/screenshot/route.ts:13-52`
- **Evidence:** In production, an invalid secret is accepted when `body.domain` is present. Up to 100 targets run serially with three 8-second probes each, potentially around 40 minutes.
- **Impact:** Unauthenticated callers can trigger expensive work; normal cron execution can exceed serverless limits.
- **Recommendation:** Require authentication for every production invocation, validate the target, process a small bounded batch, and persist retry state outside the request.

### P1-16 — Production-sensitive configuration fails open

- **Location:** `lib/abuse.ts:5-11`, `lib/clicks.ts:14`, `lib/flags.ts:5-10`, `lib/email.ts:10`
- **Evidence:** Missing Turnstile secret bypasses verification, missing salts use a public fallback, payments default live, and missing app URL creates localhost email links.
- **Impact:** A production misconfiguration silently weakens abuse controls, privacy, payment containment, and email correctness.
- **Recommendation:** Add environment validation with development-only fallbacks and production startup failure for missing required values.

### P1-17 — Email and webhook side effects lack durable delivery semantics

- **Location:** `lib/applyPayment.ts:27-78`, `lib/email.ts`
- **Evidence:** Outbid and receipt work runs inline after stake application. A post-commit failure can make the webhook return an error, but the retry sees an already-paid payment and does not replay notifications.
- **Impact:** Receipts/outbid alerts can be lost or provider retries can report misleading outcomes.
- **Recommendation:** Write notification jobs to an outbox in the financial transaction; process and retry them independently with idempotent delivery keys.

### P1-18 — Email links expose PII and unsubscribe mutates state on GET

- **Location:** `lib/email.ts:74-80`, `app/api/unsubscribe/route.ts`
- **Evidence:** Outbid links include the recipient email in the query string even though the homepage does not consume it. Unsubscribe clears email on a GET request.
- **Impact:** Email addresses leak into history, analytics, logs, and referrers; link scanners can unsubscribe users.
- **Recommendation:** Remove raw email from URLs, use short-lived opaque tokens, and implement standards-compliant one-click unsubscribe semantics with an idempotent POST plus appropriate headers.

### P1-19 — Runtime dependencies have known high-severity advisories

- **Location:** `package.json`, `package-lock.json`
- **Evidence:** `npm audit --omit=dev` reports five high-severity vulnerable package nodes, including direct Next.js and Prisma paths.
- **Impact:** Known denial-of-service, SSRF, cache, and source-map risks remain in the shipped dependency graph.
- **Recommendation:** Upgrade to supported patched versions, review framework migration notes, then rerun tests/build/audit. Record any accepted advisory with applicability analysis.

### P1-20 — Verification and operations can report success while critical behavior is untested or impossible

- **Location:** `lib/recompute.test.ts`, missing CI, `app/elements/[sym]/page.tsx:28-50`, `README.md`, `ops/*.md`
- **Evidence:** Database tests skip by default; no browser E2E or CI exists; build catches database errors and emits fallback pages; README is untouched scaffold text. Rollback references migrations that do not exist, and takedown requires `Report.detail`/hide behavior absent from the schema.
- **Impact:** Regressions in the money path can merge and deploy with green local gates; incident procedures cannot be executed as written.
- **Recommendation:** Add CI services and non-skipping integration/E2E suites, make build/runtime configuration explicit, and reconcile runbooks with implemented schema and commands.

## P2 — Minor findings

### P2-01 — Returned stake rank can be stale

- **Location:** `lib/recompute.ts:89-95`
- **Evidence:** The result reads `stake.rank` from the pre-rerank upsert object.
- **Impact:** Receipt email or callers can receive the wrong rank.
- **Recommendation:** Return the matching row from the computed/persisted ranked set.

### P2-02 — Payment and moderation records lack relational integrity

- **Location:** `prisma/schema.prisma`
- **Evidence:** `Payment.stakeId` starts as the literal `"pending"` and is never updated; payment/report/click references are strings without relations; state/path/provider fields are unconstrained strings; `unsubToken` is not unique.
- **Impact:** Orphans and impossible states complicate audit, cleanup, and incident response.
- **Recommendation:** Add nullable relations, enums/check constraints, a unique unsubscribe token, and explicit lifecycle timestamps.

### P2-03 — Dev payment UI reports contradictory outcomes

- **Location:** `app/pay/[paymentId]/page.tsx:13-20,88-90`, `app/api/dev/pay/route.ts:20-27`
- **Evidence:** The API marks a simulated failure as `failed`, while copy says it stays pending. A failed pay response still redirects to a “Payment confirmed” query state.
- **Impact:** Local E2E can produce false positives and confuse developers.
- **Recommendation:** Handle response status/body explicitly and align copy with the actual state machine.

### P2-04 — Report UI claims success without checking the response

- **Location:** `components/TerritoryView.tsx:139-153`
- **Evidence:** The UI fires `fetch`, suppresses rejection, and immediately renders “reported”.
- **Impact:** Users receive a false moderation confirmation.
- **Recommendation:** Await and validate the response; show pending, confirmed, and failed states.

### P2-05 — Rate limiting is instance-local

- **Location:** `lib/rateLimit.ts`
- **Evidence:** Limits are stored in an in-memory `Map`.
- **Impact:** Serverless instances do not share limits, restarts reset them, and abuse protection is inconsistent.
- **Recommendation:** Move checkout, search, report, and click limits to a shared atomic store.

### P2-06 — Activity data can misstate payments and reuse React keys

- **Location:** `lib/recompute.ts:69-77`, `components/ActivityCard.tsx`
- **Evidence:** Activity logs the cumulative stake total rather than the payment delta; rows key by `domain + elementSymbol`, which repeats for top-ups.
- **Impact:** The feed can imply a larger transaction than occurred and React may reuse the wrong row.
- **Recommendation:** Store/display both delta and resulting total, return log IDs, and key by ID.

### P2-07 — Profile mini-table does not preserve periodic-table topology

- **Location:** `app/s/[domain]/page.tsx:64-75`
- **Evidence:** `ELEMENTS.map` fills an 18-column grid sequentially without using `gridRow`/`gridCol`.
- **Impact:** The profile visual is not actually the periodic table and can mislead users about held positions.
- **Recommendation:** Reuse the canonical grid-cell mapping in a non-interactive compact component.

### P2-08 — Table keyboard navigation is a 122-stop flat list

- **Location:** `components/PeriodicGrid.tsx`, `components/Tile.tsx`
- **Evidence:** Every tile is independently tabbable, with no `grid` semantics or roving focus.
- **Impact:** Keyboard navigation is technically possible but impractical.
- **Recommendation:** Implement semantic grid navigation with one tab stop and arrow-key movement while preserving Enter/Space activation.

### P2-09 — Motion and status accessibility are incomplete

- **Location:** `app/globals.css`, `components/TableCamera.tsx`, `app/page.tsx`, `components/Toast.tsx`
- **Evidence:** Reduced motion disables tile/modal animation but not camera transitions or ping animation; toasts have no live-region semantics.
- **Impact:** Motion-sensitive users still receive unrequested motion, and screen-reader users miss status messages.
- **Recommendation:** Extend reduced-motion behavior and render toasts through a polite status/live region.

### P2-10 — Interactive markup and touch targets are inconsistent

- **Location:** `components/TerritoryView.tsx:107-154`, `components/IconBtn.tsx`, `components/WorldOrder.tsx`, `components/FooterBar.tsx`
- **Evidence:** A report button is nested inside a bidder anchor; several controls are 28-32px; mobile hides all footer/legal links and checkout “rules & terms” is not a link.
- **Impact:** Invalid interaction nesting, missed taps, and inaccessible legal information.
- **Recommendation:** Separate profile/visit/report actions, raise targets to at least 44px on touch layouts, and expose legal links on mobile.

### P2-11 — Camera shortcuts can interfere with overlays

- **Location:** `components/TableCamera.tsx:160-201`
- **Evidence:** Global arrow/zoom handlers ignore only inputs, textareas, and contenteditable elements.
- **Impact:** Arrow keys on modal buttons, tabs, or links can pan the background table.
- **Recommendation:** Disable camera shortcuts while an overlay is open or when focus is inside any interactive control outside the camera.

### P2-12 — Seed/recompute behavior is duplicated and can drift

- **Location:** `prisma/seed.ts`, `prisma/launch-seed.ts`, `lib/recompute.ts`
- **Evidence:** Seeds implement separate ranking/aggregate loops and do not fully update existing seed stakes/activity.
- **Impact:** Seeded state can disagree with production invariants and “idempotent” runs do not converge to one desired dataset.
- **Recommendation:** Reuse a shared deterministic recompute path and define whether seed is append-only or desired-state reconciliation.

### P2-13 — Public metadata and operational documentation are incomplete

- **Location:** `README.md`, `app/s/[domain]/page.tsx`, `app/sitemap.ts`, `app/robots.ts`
- **Evidence:** README is generic create-next-app text; profiles lack tailored metadata and sitemap entries; internal pay surfaces are not explicitly excluded from indexing.
- **Impact:** Onboarding, deployment, discoverability, and crawl behavior are under-specified.
- **Recommendation:** Replace README with real setup/architecture/runbook links and complete metadata/indexing policy.

## P3 — Polish findings

### P3-01 — Special pages drift from the token system

- **Location:** `app/pay/[paymentId]/page.tsx`, repeated inline gradients in profile/expanded rail
- **Impact:** Maintenance and visual consistency suffer.
- **Recommendation:** Reuse shared tokens/components after correctness work.

### P3-02 — Territory footer shows fabricated freshness

- **Location:** `components/TerritoryView.tsx` final footer
- **Evidence:** `relTime(Date.now() - 3600_000)` always renders an artificial one-hour-old value.
- **Impact:** Users see meaningless freshness information.
- **Recommendation:** Use a real response/update timestamp or remove it.

### P3-03 — Unused or misleading names remain

- **Location:** `CheckoutMock`, `BoardMock`, `onSale`, local Geist font files
- **Impact:** Production code reads as provisional and API names obscure their actual meaning.
- **Recommendation:** Rename after contracts are corrected and remove unused assets only when confirmed unreferenced.

## Positive findings to preserve

1. TypeScript strict mode is enabled, and lint/type compilation are clean.
2. Pricing helpers are separated into pure functions with readable unit tests.
3. The code attempts conditional idempotent payment claiming rather than blindly applying every webhook.
4. Click IPs are hashed rather than stored raw.
5. Modal code includes focus trapping, Escape handling, and focus restoration intent.
6. Tile buttons have useful accessible names.
7. The visual token system and product-specific stage/rail/profile language are coherent.
8. Data reads generally select bounded fields, and primary board payloads are small.
9. The project has explicit rollback, takedown, and design documentation—even though implementation currently lags those documents.

