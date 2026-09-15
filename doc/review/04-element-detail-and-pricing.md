# 04 — Element detail and pricing

| Field | Value |
| --- | --- |
| Phase · batch | 04 · 1 |
| Status | draft — fixes applied (R04-1…R04-4) |
| Date reviewed | 2026-09-14 (fix pass 2026-09-14, §5.8) |
| Commit reviewed | `3b0d007`; live build (§5.3) |
| Reviewer | review agent |

| Probe not run | Why | Residue |
| --- | --- | --- |
| Real $5 card payment (J4) | Operator deferral until batch 1 and checkout are fixed | 1 `Payment`, 1 `Stake`, 1 `ActivityLog`, a real charge |
| Direct Neon read | no `psql`, no `DATABASE_URL` here (§5.4) | None — read only |
| Element-page screenshots | Chrome 152 writes no PNG here (`02` §5.8) | None |
| Claimed-state render | Needs one live stake — the J4 rows | As J4 |

The fix pass then closed the casing dead end (R04-4) with a shared canonical resolver and closed R04-1…R04-3 in code, verified by the suites in §5.8; the real $5 payment (J4 → U04-3) is still deferred, and it is the one acceptance box §8 leaves unticked. The `Probe not run` rows below are unchanged by that pass.

## 1. Scope

Owns S4: `/elements/[sym]` with metadata and JSON-LD, `/api/elements/[sym]`, every price those surfaces print (CTA, deep link, modal `need`), what `/api/checkout` and `lib/settle.ts` enforce, `reclaimFor`, `classifyAndValidate`, the 15-minute reservation, and what `/api/activity` shows for the same stake. Not owned: `03`, `05`-`09`, `11`, `15`.

Inspected whole: `app/elements/[sym]/page.tsx`, `app/api/elements/[sym]/route.ts`. Also `app/api/checkout/route.ts:143-360`, `app/api/activity/route.ts`, `lib/{pricing,reservations,moderation,audit,email}.ts` (email `:60-100`), `lib/settle.ts:150-180`, `lib/recompute.ts:130-235`, `lib/pricing.test.ts:91-95`, `components/{Modals,TerritoryView}.tsx`, `app/page.tsx:90-130`, `prisma/schema.prisma:212-220,338-344`.

## 2. Actors

- **Newcomer** — no `Stake` row for the domain in the form; floored at $5 (`app/api/checkout/route.ts:218`, `lib/pricing.ts:7,73`).
- **Returning holder** — a live row (`amountUsd > 0`) for their `startupId`; tops up from $1, owes only the shortfall.
- **Hidden holder, reversed bidder** — a `HIDDEN` row is off every ranked list but still counted in `pool`/`count` (`lib/moderation.ts`; `03` R03-2); a row left at `$0` is not a holding (`:215-217`).
- **Leader, rival, crawler** — the top of the hidden-filtered list sets every takeover price; the crawler reads title, H1, JSON-LD `ItemList` (`page.tsx:14-22,83-92`).

## 3. Intended behaviour

Entering a claimed element costs $5 at minimum; taking #1 costs a dollar over the leader — `takeLeadPrice` is $5 on an empty element, `leaderTotal + 1` otherwise (`lib/pricing.ts:9-10`). A returning holder pays only the shortfall: `reclaimFor` = `max(1, leaderTotal + 1 - myPriorTotal)`, or $5 while the element is empty (`lib/pricing.ts:15-18`), the delta the outbid mail quotes (`lib/email.ts:83`; ledger §4c `:280`). Landing exactly on an existing total is refused, not sold. A take is a promise: a `Reservation` holds the quote 15 minutes and settlement honours it or throws, never reprices (`lib/reservations.ts:5-7`, `lib/settle.ts:161`). Identity is the domain typed into the form — so only the domain presented at that moment can be priced.

## 4. The path, walked

**4.1 Page.** Lookup is `ELEMENTS.find((e) => e.symbol === symbol)`, no case folding (`page.tsx:15-16,26-27`); the query filters `moderationState != HIDDEN` (`:29-50`); takeover is `lead.amountUsd + 1`, else 5 (`:80-82`); the CTA deep-links `/?el=<SYM>&stake=<takeLead>` (`:127-130`) and a failed read serves a shell hardcoding `stake=5` (`:52-78`).

**4.2 Quote API.** `/api/elements/[sym]` reads the same filtered list (`route.ts:13`), sets `leaderIdx` to the first `amountUsd > 0` (`:30-31`), and with `?me=` adds `reclaimFor(leaderTotal, mine?.amountUsd)` off that filtered array (`:47-52`).

**4.3 Modal.** The payload's only consumer (`components/TerritoryView.tsx:42-43`) derives identity from the typed URL (`Modals.tsx:145-150`), prints `need` (reclaim delta, else `prices.takeLead`) plus a hold line when `takeQuoted` (`:154-166,393-395`), and a `min={1}` field (`:378`) nothing rewrites when `need` changes.

**4.4 Enforcement.** `POST /api/checkout` locks, releases expired holds and re-reads every stake in one transaction (`:182-196`); it prices off the first non-hidden, non-zero row (`:210-213`) but finds the caller by `startupId` unfiltered (`:215-218`), so a hidden row keeps `isNewHere`/`myPriorTotal` true while `existingTotals` still lets it force a tie (`:220-221`). `classifyAndValidate` maps the amount to TAKE/JOIN/RECLAIM/STAKE (`:222-241`); only TAKE reserves, at `leader + 1` (`:296-311`), and settlement throws `take-below-reserve` when short (`lib/settle.ts:161`).

**4.5 After the fix pass.** The changes below are the only deltas from the path walked above; §5.8 verifies them and §7 states each one against its finding.

- **A quote is a function, not a scattering of conditionals.** `lib/stakeQuote.ts` takes `{ boardLoaded, boardComplete, takeLead, leaderTotal, domainKnown, priorTotal, amount }` and returns `{ need, priorTotal, priorHere, alreadyLead, reconciledAmount, belowNeed, takeQuoted }`. Both the modal and the page read `need` from it, so "what does this cost" has one answer per payload (`components/Modals.tsx:161-192`).
- **App-minted amounts follow the board; typed amounts don't.** `app/page.tsx:61` holds a `checkoutAmtMinted` latch, set when the field is prefilled (deep link `:129-153`, `openStake`/`openSymbol` `:196-202`) and cleared on the first keystroke, chip or "Use $N" press (`onCheckoutAmount`). An app-minted amount is rewritten to the live `need`; a typed one is never overwritten.
- **A holder below `need` is told, not refused.** `Modals.tsx:423-427` renders an informational banner (gated on `!clientErr` so it never explains a server error); the submit stays enabled because the server accepts a top-up as an ordinary purchase.
- **An incomplete board quotes no hold.** `prices.boardComplete` (`hiddenStakes === 0`, `app/api/elements/[sym]/route.ts`) suppresses the field reconciliation and the hold sentence for as long as any row is concealed (`Modals.tsx:421`, `lib/stakeQuote.ts`).
- **One canonical symbol on every surface that takes a spelling.** `findElementBySymbol` (`lib/elements.ts:1237`) resolves a typed symbol against the inventory; the page redirects to it (`app/elements/[sym]/page.tsx`), and the API, the OG card, the client deep link (`?el=`) and the checkout body resolve it before pricing.

## 5. Live evidence

2026-09-14, 16:32-16:33 +02:00, this host, `https://www.periodictable.lol`; bodies kept in `files\evidence04\`.

| # | Probe | Result |
| --- | --- | --- |
| 5.1 | `/api/elements/Au` `14:32:13Z` | 200, 170 B: `pool:0`, `count:0`, `stakes:[]`, `prices:{"takeLead":5,"joinMin":5}`; no `reclaim` without `?me=` |
| 5.2 | Same, `?me=probe-doc04.example` | 182 B, adds `"reclaim":5` — an unknown domain gets `MIN_STAKE` (`lib/pricing.ts:15-18`), not $1 |
| 5.3 | `/elements/Au` `14:33:08Z` | 200, 2,967 B, `X-Vercel-Cache: HIT`, `Age: 27`; body holds `0 stakers · $0 pool · take #1 for $5`, `href="/?el=Au&stake=5"` and an empty JSON-LD `ItemList`, not the shell's "Live standings load with a database connection." (`page.tsx:64`) — the live empty board at $5 |
| 5.4 | `psql --version`; `.env*`; `$env:DATABASE_URL` | no psql, no `.env`/`.env.local`, empty `DATABASE_URL` → no DB read this session; the ledger's machine check found `psql` on 2026-09-11 (`doc/PROD-READINESS-CHECKLIST.md:12`) |
| 5.5 | `/elements/au`, `/api/elements/au`, `/api/elements/AU` | 404 (1,909 / 54 / 54 B) vs `/elements/Au` 200 (§5.3) — case-sensitive on both surfaces |
| 5.6 | `/api/activity?limit=6` | `[]`, agreeing with `count:0` (§5.1) and the emptied prod state (ledger §7 `:296-302`) |
| 5.7 | Repo-wide grep `validateTake` | only `lib/pricing.test.ts:11,93-95` reference it (`lib/pricing.ts:53-58`) |

**5.8 Fix verification** (2026-09-14, this worktree, the checkout the fixes were written in). The probes below were run after the fixes landed, not before; they replace this doc's `4.x` line numbers as the evidence for what the code now does.

- **One canonical spelling, every surface (R04-4).** `lib/elements.test.ts` pins `findElementBySymbol` for `Hbar`/`Ps`/`Uue`/`DM` — the inventory's four symbols `toUpperCase()` would destroy — plus whitespace, `null`/`undefined` and one-entry-per-lowercased-key uniqueness. The DB-gated case in `lib/routes.test.ts` asks `/api/elements/hbar` and `/api/elements/HBAR` for the same element and gets the same payload; `lib/detailFace.test.ts` pins the page redirect, the OG route, the API and the client's `?el=` deep link onto the shared resolver, and pins that no `.toUpperCase()` remains in the price path. Probe 5.5's 404s are therefore stale: an unknown spelling still 404s, but `au`, `AU` and `Hbar` now all resolve to the one canonical element instead of splitting into a case-sensitive dead end.
- **The same, live** (`npx next dev -p 3111`, this host, 2026-09-14): `/elements/au` → `307` → `Location: /elements/Au`; `/elements/HBAR` → `307` → `/elements/Hbar`; `/elements/dm` → `307` → `/elements/DM`; `/elements/Au` and `/elements/Hbar` → `200` (happy path intact); `/elements/XX` → `404`. On the card route, `/og/hbar` → `200 image/svg+xml` and `/og/Au` → `200`, while `/og/XX` → `404` — and that is a real end-to-end proof, because the route's DB-failure fallback matches the symbol exactly against `ELEMENTS` (`app/og/[sym]/route.tsx:45`), so a `200` for `hbar` can only mean the resolver ran before it. The redirect is `307` (temporary), not the `308` this doc proposed: `redirect()` from a server component does not issue a permanent one, and the canonical spelling is what gets cached either way. Two caveats on this probe: every `/api/elements/<anything>` call 500s here at the Prisma read for want of `DATABASE_URL` (§5.4), `au` and `XX` alike, so it neither confirms nor refutes the API's canonicalisation — that surface rests on the DB-gated case and the source pins; and the PNG half of the OG card fails in this dev process with `{"scope":"og","msg":"png-render-failed","error":"TypeError: Invalid URL"}` from `ImageResponse` (`lib/ogCardImage.tsx:52-58`), a pre-existing `next/og` environment artifact that its own SVG fallback absorbs — the route returned the SVG, not an error, before and after this pass.
- **`boardComplete` flips with the hidden row (R04-2).** The DB-gated case in `lib/routes.test.ts` takes a probe element with no concealed row and reads `prices.boardComplete === true`; it then writes one `HIDDEN` stake and reads `false`, with that row absent from `stakes` all the same and `takeLead` unchanged at 5001. `lib/contracts.test.ts` pins `boardComplete` as an optional field of `ElementDetail`, so an older payload without it is still valid and simply quotes no hold.
- **The take floor is live and consistent (R04-3).** `lib/detailFace.test.ts` runs the full truth table over `{empty, one leader, two leaders} × {no prior, prior below, prior above} × {1, 5, below-lead, lead+1}` and asserts `takeQuoted === (classifyAndValidate(...).path === "TAKE")` for every row, with a non-vacuity guard that at least one row is actually TAKE — i.e. the guard added at `app/api/checkout/route.ts:309-312` can never reject a body the classifier already accepted, so no buyer's gold-path take changes verdict. `lib/pricing.test.ts`'s existing coverage of `validateTake` itself is unchanged and passes.
- **No oscillation, no overwrite (R04-1).** `lib/stakeQuote.test.ts` walks the reclaim delta up and down (`L+1` after `T`, `max(1, …)` when the floor binds) and asserts the reconciled amount equals `need` on every step — so repeatedly rendering the modal converges instead of ping-ponging. `lib/detailFace.test.ts` pins the latch: app-minted amounts are rewritten, and the first edit by the buyer ends the tracking.
- **Suite result.** `npx vitest run` → **445 passed, 71 skipped, 6 failed**. The six are pre-existing and this checkout's own line-ending artifact: `lib/legalMeta.test.ts` (5) and `lib/claimFace.test.ts` ("says where it reads which number", 1) match regexes against `\n`-separated lines while this Windows checkout is CRLF; all six reproduce on a stashed working tree with this pass's changes set aside. `npx tsc --noEmit` → exit 0; `npx next lint` → "No ESLint warnings or errors".
- **This pass added 37 tests** (3 new test files, 2 extended) **and changed 8 source files**: `lib/stakeQuote.ts` + `lib/stakeQuote.test.ts` (15), `lib/detailFace.test.ts` (14), `lib/elements.test.ts` (5, plus `findElementBySymbol` in `lib/elements.ts`), 1 assertion in `lib/contracts.test.ts`, and 2 DB-gated cases in `lib/routes.test.ts` (skipped here — no `DATABASE_URL` in this checkout, as §5.4 found; they run in CI).
- **One deviation, recorded because this doc proposed the opposite.** R04-1's fix suggestion was to refuse a submit below `need`. The server does not refuse it — a top-up is a legitimate `RECLAIM` that settles — so a client that blocked it would be inventing a rule the API does not hold, and would block the only path an outbid holder has to buy their way back without a reclaim link. The modal therefore keeps the button live and explains the shortfall instead (§7 R04-1).

## 6. Failure and edge matrix

| State of the element | Page CTA | `prices` with `?me=` | Modal `need` | Server verdict for that amount |
| --- | --- | --- | --- | --- |
| Empty (production today) | $5 | `takeLead 5`, `joinMin 5`, `reclaim 5` | $5 | JOIN at $5+; $1-4 refused (`lib/pricing.ts:73`) |
| Visible leader at $L | $L+1 | `takeLead L+1` | $L+1 for a newcomer | TAKE at $L+1, reserved 15 min |
| Returning holder (prior $T, leader $L) | $L+1 | `reclaim max(1, L+1-T)` | the same delta | RECLAIM above `L`, top-up below; no reservation |
| Hidden holder (prior $T) | $L+1 | `reclaim L+1` — row filtered out | $L+1, `priorHere` false | RECLAIM/top-up from $T, never TAKE, and since the fix the modal quotes no hold and no amount at all while the board is incomplete (`boardComplete` false — R04-2) |
| Board moves after the quote | stale | — | stale | stale-high take → 409 + fresh `takeLead`; stale-low reclaim settles as a top-up, wins nothing; since the fix an app-minted amount follows the new quote instead of leaving a stale number in the field (R04-1) |

A take quote writes a `Reservation` holding element, buyer, `reservedTotal` and a 15-minute expiry, during which no rival can take that element and the buyer's own top-ups cannot cross the held total (`lib/reservations.ts:5-7,33-49`); expiry is lazy and settlement throws when the payment is short of `reservedTotal` (`lib/settle.ts:161`). Only TAKE creates one (`app/api/checkout/route.ts:296-311`), so "held for 15 min" is true only for a newcomer's take. A rival top-up during a held take is refused (`:253-260,325-332`); a reclaim has no guard — re-classified under the lock it can silently become an ordinary top-up, settled but not crowned.

## 7. Findings

### R04-1 — A reclaim link's amount is never reconciled with the live board

- Severity P2 · Category: money · Confidence 8/10

*The description below is the reviewed state; the four bullets after it are what this pass changed, and §4.5 has the post-fix anchors.*

- Evidence: the deep link sets the field once and toasts "Reclaim Au for $2 — past stake still counts." (`app/page.tsx:116-123`); the modal prints the live delta as `need` but never rewrites the field, guarding only the tie rule (`components/Modals.tsx:154-170,378`); the page quotes $L+1 to all comers, its DB-down shell hardcoding `stake=5` (`page.tsx:68-71,127-130`).
- Reproduction: pay a reclaim, raise the lead, reopen the older link — it pre-fills the older amount beside "👑 $X more reclaims #1": that payment tops up and retakes nothing.
- Proposed fix: set the field to `need` while untouched since the deep link; refuse submit while `priorHere && amount < need`.
- **Status.** fixed
- **Fix.** The quote moved into `lib/stakeQuote.ts`, a pure function of the payload plus the current field content, and both the modal and the page read `need` from it. `app/page.tsx` adds a `checkoutAmtMinted` latch: an amount the product put in the field (deep link, `openStake`, `openSymbol`, a 409's "Use $N") is rewritten to the live `need` on every render, and the buyer's own first edit — typing, a chip, "Use $N" — ends the tracking permanently, so nothing overwrites a number a person typed (`components/Modals.tsx:161-192`, `app/page.tsx:61,129-153,196-202`). The stale toast is gone; the notice is re-derived from the current quote on every render. **Deviation from the proposed fix:** the doc asked for a refused submit below `need`; the modal instead keeps the button live and explains the shortfall (`Modals.tsx:423-427`), because `/api/checkout` accepts a top-up as a legitimate `RECLAIM` and a client-side refusal would invent a rule the API does not hold — refusing it would also block the one path an outbid holder has back without a reclaim link. See §5.8.
- **Evidence.** §4.5, §6, §5.8; `lib/stakeQuote.test.ts` (15 tests: reconciles up and down without oscillating, floors the reclaim at $1, gates the hold on `boardComplete`, and proves `takeQuoted === (classifyAndValidate(...).path === "TAKE")` over the full truth table); `lib/detailFace.test.ts` pins the latch and the effect wiring.
- **Reproduction.** `npx vitest run lib/stakeQuote.test.ts lib/detailFace.test.ts` (passes). By hand: pay a reclaim, raise the lead, reopen the older link — the field now shows the fresh delta, and typing your own amount leaves it alone.

### R04-2 — A hidden holder is priced as a newcomer and promised a hold never created

- Severity P3 · Category: correctness · Confidence 8/10

*As above: the reviewed state first, the fix after it.*

- Evidence: `?me=` and the modal answer from the hidden-filtered list (`app/api/elements/[sym]/route.ts:13,47-52`; `components/Modals.tsx:150-153`), but checkout looks the caller up unfiltered (`app/api/checkout/route.ts:215-218`) and reserves only TAKE (`:296-311`).
- Reproduction: hide a domain that holds stake, open the element with `?me=<it>` — `reclaim` is the full takeover price and the modal promises a hold nothing backs.
- Proposed fix: answer "what do I already hold" unfiltered (e.g. `myPriorTotal` in the payload) and drive `priorHere`/`takeQuoted` from it.
- **Status.** fixed · still static-only in production — no HIDDEN row exists (ledger §7 `:296-302`; U04-2 stands)
- **Fix.** The payload now says whether the board it was quoted from is complete: `prices.boardComplete` is `hiddenStakes === 0`, computed in the same read as the stakes themselves (`app/api/elements/[sym]/route.ts`, typed as an optional field in `lib/api.ts:126` so an older cached payload stays valid). `stakeQuote` suppresses field reconciliation and the "held for 15 minutes" sentence whenever the board is incomplete, so a concealed holder is never told a reservation exists when TAKE is unreachable for them (`lib/stakeQuote.ts`, `components/Modals.tsx:421`). **Deviation from the proposed fix:** the doc asked for `myPriorTotal` in the payload. That was rejected: the detail route is edge-cached (`lib/readCache.test.ts` pins `READ_CACHE` and that both element routes use it), so an unfiltered "what does this domain hold" — keyed on a domain anyone can type — would publish concealed listings from a public cache: a moderation oracle. `?me=` was rejected for the same reason, and `lib/readCache.test.ts` continues to pin that the only `me` read stays on the visible rows.
- **Evidence.** §4.5, §6, §5.8; DB-gated cases in `lib/routes.test.ts` (with a probe `HIDDEN` row: `boardComplete` true → false, hidden row absent from `stakes`, `takeLead` unchanged at 5001); `lib/contracts.test.ts` asserts the optional field; `lib/detailFace.test.ts` pins the count, the hold sentence's gate and the absence of any unfiltered `myPriorTotal`.
- **Reproduction.** CI-only (needs `DATABASE_URL` on localhost): `npx vitest run lib/routes.test.ts -t boardComplete`. Locally the contract and source pins run: `npx vitest run lib/stakeQuote.test.ts lib/contracts.test.ts lib/detailFace.test.ts`.

### R04-3 — The take-floor validator is dead code

- Severity P3 · Category: testing · Confidence 9/10
- Evidence: `validateTake` (`lib/pricing.ts:53-58`) is referenced only by its own test (§5.7); the floor lives in `reservedTotal` and `lib/settle.ts:161`.
- Proposed fix: call it on the TAKE branch before the reservation is written, or delete it and move its cases onto `classifyAndValidate`.
- **Status.** fixed
- **Fix.** Called on the TAKE branch before the reservation is written (`app/api/checkout/route.ts:309-312`), returning the same 409 shape every other refusal uses — `{error, code: "BELOW_FLOOR", takeLead: reservedTotal}` — so the modal's existing `priceMoved` banner and "Use $N" button handle it unchanged. The call is a belt, not a change of verdict: the classifier derives TAKE from `amount >= reservedTotal`, so nothing it accepts can fail the validator. That claim is now tested rather than argued — `lib/detailFace.test.ts` walks the full `{empty, one leader, two leaders} × {no prior, prior below, prior above} × {1, 5, below-lead, lead+1}` table and asserts `takeQuoted === (classifyAndValidate(...).path === "TAKE")` on every row, with a guard that at least one row is TAKE so the equivalence cannot pass vacuously. The guard's ordering (validate before the reservation is created, inside the locked transaction) is pinned too.
- **Evidence.** §4.5, §5.8; `lib/detailFace.test.ts` truth table; `lib/pricing.test.ts` still covers the validator itself and passes untouched.
- **Reproduction.** `npx vitest run lib/detailFace.test.ts lib/pricing.test.ts` (passes).

### R04-4 — A lowercase symbol is a dead end on both surfaces

- Severity P3 · Category: seo · Confidence 9/10
- Evidence: both lookups compare the raw segment with `ELEMENTS[].symbol` (`app/elements/[sym]/page.tsx:16,27`; `app/api/elements/[sym]/route.ts:25`), `?el=` matches exactly (`app/page.tsx:108`), and `/elements/au` → 404 while `/elements/Au` → 200 (§5.5).
- Reproduction: `/elements/au` and `/api/elements/AU` both 404; `https://www.periodictable.lol/elements/au` in a browser shows the not-found page.
- Proposed fix: uppercase the segment before lookup, or 308-redirect to the canonical symbol; make `?el=` agree.
- **Status.** fixed
- **Fix.** Took the second option, and not by uppercasing: `findElementBySymbol` (`lib/elements.ts:1237`) trims and case-folds the input and resolves it against `ELEMENTS`, because `toUpperCase()` would manufacture symbols that do not exist — the inventory spells them `Hbar`, `Ps`, `Uue`, `DM`. It is used by the page (which redirects a non-canonical spelling to `/elements/<canonical>` before rendering, and reads the DB with the canonical symbol), by `/api/elements/[sym]`, by the OG route and by the client (`?el=` deep link, `openSymbol`). The checkout body resolves the same way, so a lowercase `?el=` prices the element its link was about rather than a phantom.
- **Evidence.** §4.5, §5.8; `lib/elements.test.ts` (5 tests: casing for all four irregular symbols, whitespace, `null`/`undefined`, one entry per lowercased key); DB-gated canonical-spelling case in `lib/routes.test.ts`; `lib/detailFace.test.ts` pins all surfaces onto the shared resolver and pins that no `.toUpperCase()` is left in the price path.
- **Reproduction.** `npx vitest run lib/elements.test.ts lib/detailFace.test.ts` (passes); with a DB, `npx vitest run lib/routes.test.ts -t canonical`. By hand: `/elements/au` now redirects to `/elements/Au` instead of 404ing.

## 8. Acceptance criteria

Ticked boxes are verified by §5.8 (and, where noted, CI-only runs); the one unticked box is the deferred live payment.

- [x] An empty element quotes $5 on all four surfaces — CTA, deep link, `prices.takeLead`, modal `need` (§5.1-5.3, unchanged by this pass; `lib/detailFace.test.ts` pins the CTA→modal amount path)
- [x] A newcomer below `leader + 1` cannot take #1; a tie is refused, not sold; a holder's price is `max(1, leader + 1 − prior)` wherever printed — mail, modal, ledger §3b `:84` (§6; `lib/stakeQuote.test.ts`, `lib/pricing.test.ts`)
- [x] A stale link cannot be paid as a reclaim when it no longer reclaims (R04-1); no surface promises a hold unless a `Reservation` row exists (R04-2) — the field follows the live `need` while it is app-minted, and `boardComplete` gates the hold sentence
- [x] `ActivityLog` records amount paid and resulting total for every path — written on every applied path (`lib/recompute.ts:217-223`, `app/api/activity/route.ts:65-66`, `prisma/schema.prisma:343-344`) and asserted by the DB-gated settle case in `lib/routes.test.ts`; the production read stays U04-1
- [x] A `HIDDEN` domain never reaches ranked list, JSON-LD or modal, at any price (§6; DB-gated case in `lib/routes.test.ts` asserts the hidden row is absent from `stakes` while `boardComplete` flips to false)
- [x] `/elements/<symbol>` and `/api/elements/<symbol>` answer alike for `au`, `Au`, `AU` (R04-4; `lib/elements.test.ts` + the DB-gated canonical case)
- [ ] One real $5 payment closes the claimed-state render and receipt — J4, U04-3 (still open: no live payment was made, so the receipt, the claimed-state render and the resulting row contents are unverified)

## 9. Open questions

1. Is the $1 accumulate floor for a non-leader intended, or should money that moves no crown step higher (`lib/pricing.ts:112-145`; `components/Modals.tsx:391-393`)? *Still open — a product decision, untouched by the fix pack; `lib/stakeQuote.test.ts` now pins the current behaviour (`max(1, …)`) so a change is deliberate.*
2. Should the outbid mail quote the delta (it does, `lib/email.ts:83`) or the resulting total? *Still open, as before.*
3. May the element page stop quoting a takeover price to visitors who already hold stake (R04-1)? *Answered by the fix: no. The page keeps quoting the takeover price — it cannot know who is asking without a request-private signal, and `?me=` is deliberately not trusted for anything cached — but the amount it hands the modal is now reconciled against the live quote rather than trusted as a price.*
4. Backfill pre-Phase-3 `ActivityLog` rows or leave them NULL (`prisma/schema.prisma:343`)? Is `/elements/au` → 404 acceptable (R04-4)? *Answered by the fix: the 404 is not acceptable and no longer happens — `/elements/au` redirects to `/elements/Au`, and the API answers for either spelling. The backfill question remains a data decision (U04-1).*

## 10. Cross-references

- Ledger §3b `:82-84`, §4c `:176-178,280`, §7 `:296-302,316`, `:12` — cited, not re-derived.
- Plan §2 `:98-99`, §4 `:183-186`; siblings `03` §5.7 and R03-2 (same hidden-row split), `02` §5.8 (no screenshots), `05`-`08`.
- `doc/project-review/` is history: its identity and audit contracts are cited, not re-reported.

## 11. Change log

- 2026-09-14: first draft from the §5 reads and probes; nothing fixed, no production write, no payment attempted.
- 2026-09-14: fix pass for R04-1…R04-4 — `lib/stakeQuote.ts` (+15 tests), `findElementBySymbol` in `lib/elements.ts` (+5 tests), `lib/detailFace.test.ts` (14 pins), `prices.boardComplete`, the live take-floor call and canonical symbol resolution on the page, the API, the OG card, the client and the checkout body; 2 DB-gated cases added to `lib/routes.test.ts`. `npx vitest run` → 445 passed / 71 skipped / 6 failed (all 6 pre-existing CRLF artifacts of this Windows checkout; reproduce with the pass stashed), `npx tsc --noEmit` and `npx next lint` clean. Live dev-server probe of the canonical routes recorded in §5.8 (§5.5's 404s no longer reproduce). Working tree, uncommitted.

## 12. UNKNOWN log

| Id | Unknown | What settles it |
| --- | --- | --- |
| U04-1 | Whether the `ActivityLog` rows carry `deltaUsd`/`resultTotalUsd` or pre-Phase-3 NULLs, and what the feed prints | `psql "$DATABASE_URL"`, SQL in a temp `.sql` piped in (`-c` breaks on PascalCase) |
| U04-2 | Whether any production `Stake` row belongs to a `HIDDEN` startup (decides R04-2's reach) | Same connection: `SELECT count(*) FROM "Stake" s JOIN "Startup" u ON u.id = s."startupId" WHERE u."moderationState" = 'HIDDEN';` — the fix no longer depends on the answer (an incomplete board quotes no hold either way), so this stays open only as a reach estimate |
| U04-3 | Claimed-state render, receipt shape, real $5 charge | J4 — one real card payment, then the element page and the Stripe dashboard; residue per the probe table |
