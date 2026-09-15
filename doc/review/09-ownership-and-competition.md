# 09 — Ownership and competition

| Field | Value |
| --- | --- |
| Phase · batch | 09 · 2 |
| Status | draft |
| Date reviewed | 2026-09-15 |
| Commit reviewed | `9681bdcbff2435ef258224c52000e0f8d6089f5c` |
| Reviewer | review agent |

**How this doc was produced.** A scratch Postgres 16 container (`ptl-review-batch2-pg`, host port 55499) was migrated 0000–0006 and seeded (`prisma/seed.ts`: 122 elements, 8 startups, 26 stakes), and a dev server was started from an **isolated copy** of the checkout (`%TEMP%\ptl-b2\s3206`, `node_modules` junctioned) on port 3206 in the dev provider mode (`STRIPE_SECRET_KEY` absent, `PAYMENTS_LIVE=true`, `RESERVATION_TTL_MS=15000` so a hold's whole life fits in a probe). Every money claim below is a payment this server actually settled (`POST /api/checkout` → `POST /api/dev/pay`, `app/api/dev/pay/route.ts:41-44`), followed by a `GET /api/elements/<sym>` read and a `psql` read of the same rows. Where a bid had to be unwound, `_b2rev.ts` called the same `reverseStakeTx` the Stripe refund webhook calls (`lib/recompute.ts:132-160`, invoked from `lib/settle.ts:366-390`) rather than deleting rows, so the board states below are states the app can really reach. Element symbols `Cl`, `Ar`, `Kr`, `Xe`, `Rn`, `Po`, `Ra`, `Er` and `Ho` were used and left populated in the scratch database. The probe scripts the reproductions name (`_b2doc09*.mjs`, `_b2rev.ts`) are scratch files that sat at the repository root; they were deleted after the pass, so each reproduction lists the steps the script ran and can be rebuilt from them.

| Probe not run | Why | Residue |
| --- | --- | --- |
| A stale take (`W4`) settled by a **real** card | No `.env` in this checkout and no test card; the dev provider has no "settled late" outcome, so the hold was expired by `RESERVATION_TTL_MS=15000` instead of by a slow human | None — the applied stake, ranks and mail are the real code paths (`lib/settle.ts:229-281`) |
| The production value of `RESERVATION_TTL_MS` | Production env is not readable from this checkout; `doc/PROD-READINESS-CHECKLIST.md` §5 covers provider and database variables, not this one | None — `lib/reservations.ts:14-19` is the only reader |
| Two takes on **different** elements in the same instant | The lock is per element (`app/api/checkout/route.ts:264`), so the outcome is stated from the code and from the same-element case, which is the interesting one | None |
| Whether any **real** buyer has paid a stale take | Needs a production `Payment`/`ClaimReservation` read plus the rank at settle time, which is not recorded anywhere | None — U09-3 |

## 1. Scope

**Owns.** Plan §1 **S6 × L4 and S7 × L5**: who owns an element at any instant, what a reclaim is, what an outbid recipient is owed, ties, self-outbid, and two buyers acting at once. Paths inspected: `lib/pricing.ts` whole (192 lines); `lib/stakeQuote.ts` whole (79); `app/api/checkout/route.ts:180-350`; `lib/reservations.ts` whole (75); `lib/txn.ts` whole; `lib/recompute.ts:90-160`; `lib/settle.ts:145-260,330-400`; `app/api/elements/[sym]/route.ts:10-80`; `components/Modals.tsx:95-129,405-503`; `lib/links.ts:11-23`; `app/page.tsx:100-165`; `prisma/schema.prisma:150-200`.

**Does not own.** The quote *rendering* (`04` §7 R04-1/R04-2 settled `lib/stakeQuote.ts` and `prices.boardComplete`; cited, not re-opened); the checkout rejections as an intake experience (`06`); the reservation-conflict **message** as a client problem (`06` §7 R06-3); settlement, reversal and ledger invariants as a whole (`08`); the mail the outbid event triggers (`10` — this doc states the arithmetic and the recipient rule, doc 10 states what is sent and whether it can send twice); moderation and concealment (`12`).

**The one-line answer to "who owns an element".** The highest `Stake.amountUsd` greater than zero, excluding stakes whose startup is concealed (`moderationState: "HIDDEN"`), with ties in that amount broken by the **earliest `createdAt`** and then by `id` (`lib/pricing.ts:141-160`, read path `app/api/elements/[sym]/route.ts:22-42`). Ownership is a *rank*, not a flag: `isLeader` is recomputed as `rank === 1 && amountUsd > 0` on every money mutation (`lib/recompute.ts:90-130`), and a stake that has been fully reversed keeps its row but can never hold the crown (`lib/pricing.ts:154-157`).

## 2. Actors

| Actor | Applies | What this phase must check for them |
| --- | --- | --- |
| Anonymous visitor | yes | Whether the ladder they are shown is the ladder the server prices against, and whether the amount the app suggests is an amount the server will take |
| Paying customer | yes | Whether the price they paid still buys the rank they were promised, and what they get if it no longer does |
| Defending holder | yes | What their hold is worth, when they lose #1, and how they get it back |
| Losing bidder | yes | Where their money sits after losing, and whether they are told |
| Operator | partly — `08`/`12` | Whether a support agent can answer "why am I rank 2" from the board alone |
| Attacker | yes | Whether a paid reservation can be abused to freeze a competitor's element, and whether ties can be farmed |
| Crawler / unfurl bot | no | — (nothing here is crawled) |
| Email recipient | yes | Whether the reclaim figure in the mail is the figure the intake accepts (`10` sends it) |
| Payment provider | partly | Whether an amount taken by the provider can still be refused by the ledger after the fact |
| Future maintainer | yes | Whether the tie rule and the "guaranteed take" are invariants or conventions |

## 3. Intended behaviour

### 3.1 The ownership rules, as a support agent needs them

| Question | Answer | Where |
| --- | --- | --- |
| Who owns an element? | The stake with the highest `amountUsd > 0` among non-concealed startups — *not* the most recent payer, and not the biggest cumulative spender across elements | `app/api/elements/[sym]/route.ts:24-35,48-52`; `lib/pricing.ts:156-179` |
| What breaks an exact tie in the amount? | Nothing can be *accepted* at an amount already on the board (`TIE`), but if a tie is ever written, the earlier `createdAt` wins and then the smaller `id` | `lib/pricing.ts:42-48,58-66,156-179` |
| What does "reclaim" mean? | A bidder who already has money on the element tops it up until they pass the leader. The amount they need is `winner + 1 − (what they already have)`, floored at $1 | `lib/pricing.ts:27-32`; `lib/stakeQuote.ts:85-95` |
| Why does the mail say $4 when the floor is $5? | There is **no $5 floor on a reclaim**. The $5 floor is the *first-join* floor and it applies only to a bidder with no live money on that element. A holder sitting at $5 who is outbid by $8 is genuinely owed $4 and the intake accepts $4 | `lib/pricing.ts:27-32` vs `:34-38`; observation `Z3` ($2 accepted, 200) and `ZB` ($1 refused, 409 `BELOW_FLOOR`) |
| So when does a reclaim get refused for being too small? | When the bidder's own row has been unwound to $0 — a refund, chargeback or dispute (`08`). They are priced as a newcomer again, and their old $0 row is still on the board | `lib/pricing.ts:34-38`; `lib/recompute.ts:132-160`; observation `ZA`/`ZB` |
| Can I outbid myself? | No. A top-up is `prior + amount` and the amount is at least $1, so a bidder can never land on their own total; the code comment says so and the classification excludes only *other* bidders' totals | `lib/pricing.ts:111-141` (`:133-134`, the own-prior note) |
| What do I get for $5 on an element that already has a $5 leader? | Nothing — the server refuses with `TIE` and tells you to add $1 | `lib/pricing.ts:42-48`; observation `X4`, `X8` |
| If I pay and lose, where is my money? | Still on my stake row, at face value. It keeps counting toward my next reclaim, it keeps its clicks, and it stays ranked on the board | `lib/recompute.ts:90-130`; observation `Z3`/`ZD` (z 5 → 7 with w parked at 6, rank 2) |
| Am I told when I lose #1? | Only by email, and only if you gave an address: the outbid mail goes to the victim's own address, else to the newest paid payment that carries one (`R09-7`). 10 of the 40 startups in the seed have no address at all; with neither channel the operator gets an `OUTBID_UNNOTIFIED` row | `lib/settle.ts:319-364`; DB read below |
| If I hold a take quote and do not pay, what happens? | For up to `RESERVATION_TTL_MS` (15 minutes by default) nobody else can bid at or above your quote. Then it lapses and your quote is worth nothing | `lib/reservations.ts:21-34,48-89`; observations `X3`, `W2`/`W3` |
| Can I get a refund by taking #1 and not being #1? | Not automatically. The payment settles at the amount you paid and lands at whatever rank that buys. A take that lapses is applied, not cancelled — and this pass added the record and the mail that say so | `lib/settle.ts:229-281`; finding R09-2 |

### 3.2 The money rules

A stake is money paid for a *rank*, and the rank is derived from the amount, never stored as an entitlement. `takeLeadPrice` is `leaderTotal + 1`, or $5 on an unbid element (`lib/pricing.ts:9-12`); `joinMin` is the $5 floor (`:14`); `reclaimFor` never returns less than $1 (`:27-32`). Every checkout, take, top-up and reversal runs through the same classifier (`lib/pricing.ts:111-141`) and asserts the ledger invariants before commit — one leader, rank 1 is the leader, pool equals the sum, count equals the rows (`:181-207`), throwing to abort the transaction on violation.

Concurrency is handled in three layers: a per-element advisory lock held for the whole checkout transaction (`SELECT pg_advisory_xact_lock(element.id)`, `app/api/checkout/route.ts:264`), a `Serializable` money transaction with a bounded retry on serialization failures (`lib/txn.ts`, retried only for `P2034`/`40001`/`40P01` up to 10 attempts with jittered backoff), and an outer unique-violation recovery that replays the winning attempt instead of 500-ing (`route.ts:419-434`). A take additionally mints a `ClaimReservation` at `leaderTotal + 1` that is enforced for everyone else until it is consumed by settlement or lapses (`lib/reservations.ts:48-89`).

## 4. The path, walked

1. **Read.** `GET /api/elements/Li` returns the ladder sorted by amount, rank and `isLeader` per row, plus `prices.boardComplete` (whether any row is concealed), the `moderationState ≠ HIDDEN` + `amountUsd > 0` filter (`route.ts:29`, `R09-4`), the live `takeHold` and, with `?me=<domain>`, that domain's `reclaim` figure (`app/api/elements/[sym]/route.ts:24-100`).
2. **Ask for a quote.** The modal derives the same numbers client-side from the payload (`lib/stakeQuote.ts:71-113`): `need`, `belowNeed`, `reconciledAmount`, `takeQuoted`.
3. **Submit.** Under the per-element lock the server re-reads the board, takes the **first non-hidden row with `amountUsd > 0`** as the leader (`app/api/checkout/route.ts:284-286`), finds the caller's own live row (`:291`, also `> 0`), and classifies the amount (`:313`) against **every** non-hidden total (`:296`), including rows at $0 and rows whose startup is concealed (deliberately unfiltered so a reversal cannot be used to slip past a rival's total).
4. **Rejection.** `PRICE_MOVED` / `BELOW_FLOOR` / `TIE` come back as `409 { error, code, takeLead }` (`route.ts:334-342`); a live rival hold is answered *before* the classifier and comes back as `409 { error, code: "RESERVATION_CONFLICT", reservedTotal, expiresAt }` plus `joinHint` or `joinBlocked` for a bidder with no stake here (`:303-333`).
5. **Acceptance.** `200 { paymentId, checkoutUrl, provider, reservation? }`, and on a `TAKE` path the hold is minted at `leaderTotal + 1` for `RESERVATION_TTL_MS` (`:384-413`).
6. **Money.** `POST /api/dev/pay` (dev) or Stripe (live) marks the payment paid and settlement applies the stake inside the same locked, serialized transaction, reranks the element, and enqueues the receipt and — if someone was knocked off #1 — the outbid mail (`lib/settle.ts:184-440`).
7. **Reversal.** A refund or dispute unwinds the stake with `reverseStakeTx`, keeping the row, its clicks and its history, but zeroing the amount (`lib/recompute.ts:132-160`).

## 5. Live evidence

All timestamps 2026-09-15, server `http://127.0.0.1:3206` (dev provider, `RESERVATION_TTL_MS=15000`). Each request carried a fresh spoofed `cf-connecting-ip` so the 5/hour intake limit (`app/api/checkout/route.ts:116-119`) did not interfere. (Line numbers in §5 are the locations at the reviewed commit `9681bdc`: the fix packs since then have moved code, so the intake limit cited here reads `app/api/checkout/route.ts:243` on today's tree — doc `06`'s restructure of that route is why §5's citations to it sit lower than the ones §3–§4 now carry. §5.7 re-cites everything this pass touched.)

### 5.1 Run `D` — the ladder on `Cl` (`Cl`-labelled probes at 10:14:21Z)

| # | Action | Observed |
| --- | --- | --- |
| D1 | ladder-a asks for $5 | `200 {"paymentId":"cmu2ilubf…","provider":"dev"}` |
| D2 | pays it | `200 {"ok":true,"status":"paid","terminal":true,"elementSymbol":"Cl"}` |
| D3 | ladder-b asks for $6 (a take) | `200 {… "reservation":{"reservedTotal":6,"expiresAt":"2026-09-15T10:14:40.665Z","guaranteedTake":true}}` |
| D4 | pays the take | `200 {"ok":true,"status":"paid",…}` — ladder-b now leads |
| D5 | ladder-a asks for $2 (a reclaim) | `200` — accepted, because D4's settlement **consumed** the reservation; a reclaim needs no hold |
| D6 | ladder-a asks for $2 again | `200` |
| D7 | pays it | `200`, ladder-a leads at 7 |
| D8 | a newcomer asks for $4 | `409 {"error":"First stake is $5+.","code":"BELOW_FLOOR","takeLead":8}` |
| D9 | the same newcomer asks for $5 | `200` |

### 5.2 Run `X` — holds, ties and the floor (`Ar`, `Kr`, `Xe`, `Cl`, 10:16:21Z)

| # | Action | Observed |
| --- | --- | --- |
| X1 | `d` joins `Ar` at $5 and pays | `200`, `d` leads at 5 |
| X2 | `e` asks $6 on `Ar` and **does not pay** | `200 {… "reservation":{"reservedTotal":6,"expiresAt":"2026-09-15T10:16:37.081Z","guaranteedTake":true}}` |
| X3 | `d` (the incumbent) asks $1 while the hold is live | `409 {"error":"This element has a held take quote at $6. Refresh for a new quote.","code":"RESERVATION_CONFLICT","reservedTotal":6,"expiresAt":"2026-09-15T10:16:37.081Z"}` |
| X4 | `f`, a newcomer, asks $5 while the hold is live | `409 {"error":"$5 is taken — add $1 more to stand clear of the tie.","code":"TIE","takeLead":6}` |
| X5 | `d` asks $6 (self top-up) while the hold is live | same `RESERVATION_CONFLICT` body as X3 |
| X6 | `d` asks $1 again, 17 s later | `200` — the hold lapsed |
| X7 | `g` joins `Kr` at $5 and pays | `200` |
| X8 | `h` joins `Kr` at $5 | `409 {"error":"$5 is taken — add $1 more to stand clear of the tie.","code":"TIE","takeLead":6}` |
| X9a/X9b | two claims opened in the same instant on the empty `Xe` | `200` / `200` — neither saw a row, because a row is only written at settlement |
| X10 | `g2` joins `Cl` at $5 under a $7 leader | `200`, lands rank 3 |

DB read after run `X`: `Ar` holds one row (`d`, $5, rank 1); `Kr` one row (`g`, $5, rank 1); `Xe` **no** rows (the two payments were never paid); `Cl` three rows at 7/6/5. `ClaimReservation` for `Ar`: the hold minted by X2 is `expired` and X6's reclaim created none.

`EmailLog` after X10: `receipt | g2@d9-g.dev | Cl | 5 | "You're #1 in Cl (Chlorine) 🎉"` — a row that landed **rank 3** was thanked for taking #1. The receipt template's subject is `You're #1 in …` unconditionally (`emails/receipt.tsx`; finding is doc `10`).

### 5.3 Run `Z`/`ZA` — where a losing bidder's money goes, and what a reversal leaves

| # | Action | Observed |
| --- | --- | --- |
| Z1 | `z` joins `Rn` at $5 and pays | `200` |
| Z2 | `w` takes at $6 and pays | `200`; `w` leads; outbid payload for `z`: `{"victimTotal":5,"winnerAmount":6,…}` → mailed reclaim `max(1, 6+1−5) = $2` |
| Z3 | `z` asks for the mailed **$2** | `200` — the mail's figure is exactly what the server accepts; `z` leads at 7, `w` is parked at rank 2 with $6 still on the board |
| Z4 | `x` joins `Po` at $5 and pays | `200` |
| Z5 | tile `Po` before the unwind | `{"pool":5,"count":1,"stakes":[x 5 rank 1 isLeader true],"prices":{"takeLead":6,"joinMin":5,"boardComplete":true}}` |
| ZA | tile `Po` after `reverseStakeTx` on `x`'s payment (`removedUsd 5, remainingUsd 0`) | `201`-free `200` `{"symbol":"Po",…,"pool":0,"count":1,"stakes":[{… "amount":0,"rank":1,"isLeader":false}],"prices":{"takeLead":5,"joinMin":5,"boardComplete":true}}` |
| ZB | `x` asks $1 | `409 {"error":"First stake is $5+.","code":"BELOW_FLOOR","takeLead":5}` — the unwound bidder is a newcomer for pricing |
| ZC | `x` asks $5 | `200` — re-entry costs the full floor |
| ZD | tile `Rn` | `z` 7 rank 1 leader, `w` 6 rank 2, pool 13, `prices.takeLead 8` |

The unwind used the settler's own code path: `_b2rev.ts` called `reverseStakeTx` from `lib/recompute.ts` and the payment update the Stripe refund branch performs (`lib/settle.ts:366-390`), which is why the row still exists at `amountUsd 0`.

### 5.4 Run `Y` — two simultaneous takes on `Ra` (10:18:35Z)

| # | Action | Observed |
| --- | --- | --- |
| Y1/Y1p | `q1` joins `Ra` at $5 and pays | `200`, leads |
| Y2a | `q2` asks $6 | `200 {… "reservation":{"reservedTotal":6,"expiresAt":"2026-09-15T10:18:51.294Z","guaranteedTake":true}}` |
| Y2b | `q3` asks $6 **in the same instant** (`Promise.all`) | `409 {"error":"This element has a held take quote at $6. Refresh for a new quote.","code":"RESERVATION_CONFLICT","reservedTotal":6,"expiresAt":"2026-09-15T10:18:51.294Z"}` |
| Y3 | the winner pays | `200` |
| Y4 | tile `Ra` | `pool 11, count 2, stakes [q2 6 rank 1 leader, q1 5 rank 2], prices {"takeLead":7,"joinMin":5,"boardComplete":true}` |

The loser was not charged, was not left with a row, and was told the truth about why. Outbox rows from this run: `outbid-cmu2ir8g2…|{"to":"q1@d9-q.dev","victimTotal":5,"winnerAmount":6,"victimDomain":"d9-q1.dev","winnerDomain":"d9-q2.dev","elementSymbol":"Ra"}` → mailed `$2`, matching the `Math.max(1, winner + 1 − victim)` arithmetic in `lib/email.ts:85`.

### 5.5 Run `W` — what a "guaranteed take" is worth after its hold lapses (10:19:16Z)

| # | Action | Observed |
| --- | --- | --- |
| W1/W1p | `e1` joins `Er` at $5 and pays | `200`, leads at 5 |
| W2 | `e2` takes at $6, **left unpaid** | `200 {… "reservation":{"reservedTotal":6,"expiresAt":"2026-09-15T10:19:31.549Z","guaranteedTake":true}}` |
| — | 17 s pass | hold lapses (TTL 15 s) |
| W3/W3p | `e3` takes at $7 and pays | `200` (new hold minted at 6) → `e3` leads at 7 |
| W4 | `e2`'s **stale** $6 take is paid | `200 {"ok":true,"status":"paid","terminal":true,"elementSymbol":"Er"}` |
| W5 | tile `Er` | `pool 18, count 3, stakes [e3 7 rank 1 leader, e2 6 rank 2 isLeader false, e1 5 rank 3], prices {"takeLead":8,"joinMin":5,"boardComplete":true}` |

DB read: `Er` = `e3 7 rank 1 isLeader t`, `e2 6 rank 2 isLeader f`, `e1 5 rank 3 isLeader f`; reservations `6 consumed | 6 expired`. `EmailLog` newest three: `receipt e2@d9-e.dev Er 6 "You're #1 in Er (Erbium) 🎉"`, `outbid e1@d9-e.dev Er 3 "You were knocked off Er 👑"`, `receipt e3@d9-e.dev Er 7 "You're #1 in Er (Erbium) 🎉"`. So `e2` paid the $6 take price, landed **rank 2**, and was told they were #1; `e1` was told to reclaim for $3, which the arithmetic (`max(1, 7+1−5)`) and Z3 both say is a real price.

### 5.6 Run `V` — two claims at the same amount, both paid (10:20:34Z, element `Ho`)

| # | Action | Observed |
| --- | --- | --- |
| V1a/V1b | two claims at $5 on the empty `Ho`, submitted together | `200` / `200` — both minted a payment |
| V2 | both paid | `200` / `200` |
| V3 | tile `Ho` | `pool 10, count 2, stakes [d9-v1.dev 5 rank 1 leader, d9-v2.dev 5 rank 2 isLeader false], prices {"takeLead":6,"joinMin":5,"boardComplete":true}` |

DB read: two rows at `amountUsd 5` (`10:20:35.161`, `10:20:35.344`). The second buyer paid the tie price and got rank 2, while the *same* $5 a minute later is refused with `TIE` (X8). The tie rule is therefore a pre-commit check against committed rows, not an invariant of the board.

### 5.7 Fix verification

2026-09-15, this worktree, after the §11 fix pass. Like doc `08`'s pass and unlike doc `07`'s, this one
ran against a real Postgres: the same `postgres:16-alpine` container (`ptl-fix08-pg`, under colima)
published on port `55433` — the port `.github/workflows/ci.yml` uses — with every migration applied,
so the DB-gated suites this doc's evidence came from executed instead of skipping. The limit doc `08`
recorded stands here too: there is no payment provider reachable from this checkout, so a "take" below
is a `Payment` row this environment writes and a settle call this environment makes, not a card.

```
TEST_DATABASE_URL=… npm run test:ci → 46 files passed (46); 680 passed, 0 failed, 0 skipped (680)
npx vitest run (no database)        → 40 passed, 6 skipped (46); 588 passed, 92 skipped (680)
npx tsc --noEmit                    → clean
npm run lint                        → clean (no ESLint warnings or errors)
```

The first line is the CI-shaped run and satisfies CI's own gate (the workflow fails the build when the
log contains a skipped test; the grep against it finds nothing). The second is the shape §5.1-§5.6
were written from and the honest bound on what a checkout with no database proves: 6 files and 92
tests skip there — every DB suite, including the one this pass added. The pass added **33 tests**, and
they are the whole of the movement from `08`'s 647 to 680: `lib/reservations.test.ts` (13, new — the
first test file `lib/reservations.ts` has ever had) and 20 across six existing files —
`lib/stakeQuote.test.ts` (11, now 26), `lib/routes.test.ts` (3, now 15), `lib/settle.test.ts` (3, now
24), `lib/checkoutFace.test.ts` (1, now 21), `lib/ledger.test.ts` (1, now 11), `lib/detailFace.test.ts`
(1, now 15). Two existing tests were repaired rather than added, both because the fix moved the fact
they had pinned: `lib/pricing.test.ts`'s tie message (`$5 is taken — add $1 more` became `$5 is
already on the board — add $1 to stand clear of the tie`) and `lib/detailFace.test.ts`'s `stakeQuote`
import assertion. Because the pass moved code the doc's *living* references point at, §3.1, §3.2 and §4
had every `file:line` citation re-read against this tree; §7's **Evidence** cells keep their
at-the-time numbers on purpose (that is what was observed), and each finding's **Fix** cell carries
the post-fix location.

- **R09-1 — the hold is decided before the rule that used to answer for it, and it is rendered.**
  `getActiveReservation` + `reservationConflict` now run *ahead of* `classifyAndValidate`
  (`app/api/checkout/route.ts:303-333`, classifier at `:313`), so on a floor-priced tile the buyer gets
  `409 RESERVATION_CONFLICT` naming `$6 until 10:16:37` instead of `409 TIE "$5 is taken — add $1
  more"`; the tie hint cannot be emitted in that window because the conflict returns before the
  classifier. A newcomer is told what *does* land: `joinSpace(existingTotals, reservedTotal)`
  (`lib/stakeQuote.ts:124`) answers `{kind:"room", amount}` when a total below the hold is still free
  and `{kind:"locked", free}` when none is, and the route publishes exactly one of them —
  `joinHint: 5` (`route.ts:328`) or `joinBlocked: true` (`:329`) — never both, and only to a caller
  who has no stake here (an incumbent's remedy is the wait, not a smaller bid). The payload carries
  `reservedTotal` and `expiresAt` and **no owner**: a hold only exists on a TAKE path whose owner is
  the leader by construction, so naming the amount and the expiry is the whole disclosure
  (`lib/api.ts` `takeHold`/`joinHint`/`joinBlocked`). `components/Modals.tsx` renders the same hold
  from the detail payload's new `takeHold` field rather than re-deriving it, and
  `lib/checkoutFace.ts:131-142` turns the conflict body into "A $5 bid still joins the ladder." or
  "No amount lands until that hold ends.", taking precedence over the price-move sentence.
  Verified by `lib/routes.test.ts`'s hold probe (the refusal *and* the hinted amount then actually
  landing, on a live hold), `lib/checkoutFace.test.ts`'s hint/blocked/precedence case and
  `lib/stakeQuote.test.ts`'s three `joinSpace` arms.
- **R09-2 — a lapsed take is applied, recorded, and receipted at the rank it got** (§9 Q2 arm (a)).
  Inside the settle transaction the expired reservation is still marked `EXPIRED`, and the amount it
  promised is now carried out of the block in `lapsedTakeTotal` (`lib/settle.ts:235,242`) — the
  application itself is unchanged, because the money is already captured and the ledger has no refund
  path for a `PENDING` row (`08`). What is new is the record and the mail: a `TAKE_LAPSED` audit row
  with `detail: "take-lapsed:<rank>"` and the settlement's `rank` (`:262-270`, `lib/audit.ts:31`), the
  receipt payload's `lapsedTakeTotal` (`:315`, `lib/outbox.ts`), and a rank-aware subject —
  `receiptSubject({ …, rank })` (`emails/receipt.tsx:23`) keeps `You're #1 in C (Carbon) 🎉` only at
  rank ≤ 1 and otherwise says `You're #2 in C (Carbon)`, with the lapse sentence appended to the body
  (`:28-40`, plumbed through `lib/email.ts:125`). Verified by `lib/settle.test.ts`'s lapse case against
  a real expired reservation: the stake lands at the stale amount, `rank` is 2 because the pass's
  raider outbid it while the quote ran, the reservation reads `EXPIRED`, the audit detail is
  `take-lapsed:2`, the outbox payload carries `lapsedTakeTotal: 6` and `rank: 2`, and the rendered
  HTML says the take "settled as an ordinary stake at **#2**" — the W-run anomaly (a $6 stale take
  receipted as the crown) is the assertion that now fails.
- **R09-3 — the tie rule is stated as what it is.** The `TIE` copy is now "`$5` is already on the board
  — add $1 to stand clear of the tie" (`lib/pricing.ts:46`) and the prior-total form says "would tie a
  bid already on the board" (`:60`), so the message no longer claims a uniqueness the ledger does not
  enforce; the classifier's own comment was reworded to match. Simultaneous empty-tile claims stay
  allowed — the tie rule is a pre-commit check by design, and the ledger's answer to two equal rows is
  the order `rankStakes` already defines. Verified by `lib/ledger.test.ts`: two equal claims both land,
  arrival order decides, *and* a forced identical `createdAt` still ranks deterministically by row id,
  surviving a re-rank — then `assertLedgerInvariants` over the whole board. `lib/pricing.test.ts` pins
  the reworded message (it asserts the word "tie", which the fix kept).
- **R09-4 — an unwound stake is no longer a listed bid.** Both display surfaces filter the row out:
  `amountUsd: { gt: 0 }` beside the intact `moderationState` literal
  (`app/api/elements/[sym]/route.ts:29`, `app/elements/[sym]/page.tsx:62`), and the payload's `count`
  is recomputed from the rows it publishes (`route.ts:91`) instead of from the denormalized aggregate;
  the server-rendered page keeps its own arithmetic (`stakes.length + hiddenStakes`). The ZA shape —
  `count 1`, one `amount 0` row at `rank 1`, no leader — cannot be served; the element now reads
  `count 0`, `pool 0`, `prices: { takeLead: 5, joinMin: 5 }`, which is exactly what the board can
  honour. Verified by `lib/routes.test.ts`'s zero-amount case, which writes the unwound row on a real
  element and asserts it is absent from `stakes` and from `count`.
- **R09-5 — the floor is stated where the figure is rendered.** `smallestFreeAmount`
  (`lib/pricing.ts:20`) returns the lowest amount a tile will actually accept — the floor, unless a
  row already sits on it — and `joinSpace`/`crownCopy` use it (`lib/stakeQuote.ts:126,196,208`), so a
  refunded bidder who arrives at a mailed sub-$5 link is told "A first bid is $5+ — $6 takes #1 right
  now" at the point of entry rather than answering with "First stake is $5+." *after* the click. The
  arithmetically correct reclaim figure is unchanged (`Z3` still takes $2 while the row is live), and
  the mail's own sentence is left to doc `10`, which owns that template and its copy lock — recorded
  in §11 rather than taken here. Verified by `lib/stakeQuote.test.ts`'s floor-plus-hold cases, one of
  which asserts the hint equals `smallestFreeAmount(existingTotals)` rather than a literal.
- **R09-6 — the crown sentence is derived from the live board.** `components/Modals.tsx` no longer
  contains any fixed "$5+"/"takes #1"/"reclaims #1" sentence: it imports `crownCopy`, passes the live
  board (`boardComplete`, `priorTotal`) and the hold it read from the payload, and renders
  `{crown.lead}` and `{crown.joins}` (`lib/stakeQuote.ts:161-215`). On a floor-priced tile that means
  "$5 is already on the board" plus the exact amount that does land; with a live hold it means the
  amount and the expiry; the incumbent is told the wait instead of being offered a price the intake
  refuses. Verified by the new assertion block in `lib/detailFace.test.ts`, which requires the derived
  call shape and forbids the three removed sentences from returning.
- **R09-7 — an outbid holder with no address on the startup is reached through the payment that funded
  the stake.** The outbid block now resolves `victim?.email ?? fundingEmail?.email ?? null`
  (`lib/settle.ts:337`), where `fundingEmail` is the newest `PAID` payment on the same element and
  startup that carries one (`:325`) — the address the bidder actually typed at checkout. When neither
  exists, the notice is not silently skipped any more: an `OUTBID_UNNOTIFIED` audit row records the
  victim and the reason (`:355`, `detail: "no-address:<victimDomain>"`, `lib/audit.ts:34`), so an
  operator can see how many holders are unreachable instead of inferring it from a join. The receipt
  is unaffected, and a payment *without* an address still mails when its startup has one (`:337` is
  the same expression the receipt uses). Verified by `lib/settle.test.ts`'s two cases: a victim whose
  startup has no email receives the mail at its funding payment's address (and no audit row), and a
  victim with neither channel produces no outbox row at all plus the audit row naming its domain.

## 6. Failure and edge matrix

| Situation | What the app does | Evidence |
| --- | --- | --- |
| Bid below the floor with no prior stake | `409 BELOW_FLOOR`, "First stake is $5+." — no payment row | D8, ZB |
| Bid equal to a committed total | `409 TIE` — no payment row | X8 |
| Bid equal to a total that is *not yet* committed (simultaneous claims) | Both accepted, both settle, second lands rank 2 | V1a–V3 |
| Take quoted while a rival hold is live | `409 RESERVATION_CONFLICT` naming the hold and its expiry; the tie hint is *not* shown (X5/X3) | X3, X5 |
| **Newcomer** bid while a rival hold is live on a floor-priced tile | `409 TIE` "add $1 more" — and that $1 more is exactly the amount the hold refuses | X4 then X2/X3; finding R09-1 |
| Incumbent tops up while a rival hold is live | `409 RESERVATION_CONFLICT`; the only remedy is to wait for the lapse | X3, X5, X6 |
| Hold owner pays before the lapse | Reservation consumed; the hold stops blocking immediately | D3/D4 (and `lib/reservations.ts:70-77`) |
| Hold owner pays after the lapse | Stake applies at the stale amount, whatever rank that now is | W2→W4, W5; finding R09-2 |
| Invariant violated at settlement (`take-below-reserve`, ledger invariant) | The settlement transaction throws — the payment stays `PENDING` and the provider retries | `lib/settle.ts:161-163`; mechanism and residue are doc `08` |
| Refund / chargeback on a stake | Row kept at $0, clicks kept, crown given up, bidder priced as a newcomer again | ZA, ZB, ZC; `lib/recompute.ts:132-160` |
| Dethroned holder with an email | Outbid mail with `max(1, winner+1−victim)` | Z2/Z3, Y4 |
| Dethroned holder without an email | Nothing is sent; the board is the only signal | `lib/settle.ts:222-233`; R09-7 |
| Concealed (hidden) competitor | Excluded from the ladder and from leadership, but still counted in `count`/`pool` and **still able to collide** with a new amount | `app/api/elements/[sym]/route.ts:22-28`; `app/api/checkout/route.ts:223` |
| Two buyers, one element, same instant | One wins the lock; the other gets a deterministic rejection (409) or, if the tile was empty, a second payment that lands rank 2 | Y2a/Y2b, V1a/V1b |

Observed before the fix pass, so its `file:line` citations are the locations at the time of the
observation — §7's **Fix** cells and the table below carry the current ones.

**After the fix pass** (§5.7), the rows whose behaviour or visibility changed:

| Situation | Current behaviour | What the bidder sees | What the operator sees |
| --- | --- | --- | --- |
| Newcomer bid while a rival hold is live on a floor-priced tile | unchanged refusal, different sentence: `409 RESERVATION_CONFLICT` decided *before* the tie rule, so `$5` no longer gets "add $1" | the hold named with its total and expiry, plus either the smallest amount that still lands (`A $5 bid still joins the ladder.`) or, when none exists, `No amount lands until that hold ends.` | the same `CHECKOUT_*` activity rows as before, one code — the tie and the hold can no longer be confused for each other in the log |
| Take quoted while a rival hold is live / incumbent top-up | unchanged refusal; the tie hint is structurally unreachable in that window (the conflict returns first) | as above, and the incumbent is told the wait rather than offered a price the intake would refuse | — |
| Hold owner pays after the lapse | the take still applies at the stale amount, and is now recorded as such | receipt subject reports the **applied rank** (`You're #2 in Er (Erbium)`) and the body says the quote lapsed and settled as an ordinary stake at that rank | one `TAKE_LAPSED` audit row per lapsed take, carrying `take-lapsed:<rank>` — the rank U09-3 could not reconstruct is now written down |
| Two buyers, one element, same instant, empty tile | unchanged: both settle, arrival order then row id decides the ranks | unchanged; the `TIE` message they will meet against a *committed* row no longer claims ties are impossible | a ledger test that asserts the documented answer instead of the absence of one |
| Bid equal to a committed total | unchanged `409 TIE` with clearer copy (`$5 is already on the board — add $1 to stand clear of the tie`) | the amount that does land | — |
| A fully unwound stake (refund/chargeback) | it is no longer listed as a bid: the display include filters `amountUsd > 0` and `count` follows the listed rows | the tile reads `count 0, pool 0, no leader, $5 to join` — no phantom rank-1 bidder | the row itself is untouched, so `ZA`'s click history and first claim survive (doc `08` owns that) |
| Reclaim figure below the floor after a refund | unchanged arithmetic (`Z3` still takes the mailed $2 while the row is live); when the row is *gone*, entry at the sub-$5 figure is refused — and the modal now says so in the same breath as the amount | `A first bid is $5+ — $6 takes #1 right now`, instead of `First stake is $5+.` after the click | — |
| Crown copy on a floor-priced tile | derived from the live board, not a literal | the smallest free amount for *this* bidder, and the hold when there is one | — |
| Dethroned holder with no `Startup.email` | the notice goes to the address on the payment that funded the stake | the outbid mail, at the address they typed at checkout | — |
| Dethroned holder with neither address | nothing is sent — deliberately — but it is no longer silent | nothing | one `OUTBID_UNNOTIFIED` audit row naming the victim domain, so the unreachable-holder count is a read, not an inference |

## 7. Findings

### R09-1 — A live take hold can close an element to every bidder, and the rejection it produces recommends the one amount the hold refuses

- **Severity.** P2
- **Category.** money
- **Evidence.** `lib/reservations.ts:38-52` blocks any bid where `myPriorTotal + addUsd >= reservation.reservedTotal`; `app/api/checkout/route.ts:248-267` answers that with `RESERVATION_CONFLICT`; `lib/pricing.ts:28-35` rejects any amount equal to an existing total with `TIE`. On a tile whose leader sits at the $5 floor the hold is minted at $6 (`route.ts:302`), so a newcomer's reachable range is `$5 ≤ amount < $6` — which is exactly `$5`, which is exactly the leader's total. Observation: X2 (hold minted at $6 on `Ar`), X4 (newcomer's $5 → `409 TIE "$5 is taken — add $1 more to stand clear of the tie."`, `takeLead: 6`), X3 (`$6` → `409 RESERVATION_CONFLICT`). The advice in the X4 body is unactionable for the whole life of the hold, and `components/Modals.tsx:414-426` renders the same "add $1"/"$5+ joins the ladder" framing to every visitor.
- **Reproduction.** `node _b2doc09b.mjs http://127.0.0.1:3206` (dev provider, `RESERVATION_TTL_MS=15000`); steps X1–X6.
- **Proposed fix.** While any live reservation exists for the element, make it the *first* thing every rejection names (the incumbent path already does: `route.ts:248-267`), and suppress the tie hint in that window (`route.ts:227-238` should not offer `+$1` when `myPriorTotal + (amount + 1) >= reservedTotal`). The modal already receives `reservedTotal`/`expiresAt`; render the hold instead of the tie copy (`lib/stakeQuote.ts` is the right place to expose `heldByOtherUntil`). Test: `lib/reservations.test.ts` case with a live hold asserting the conflict payload is what the client renders; route test asserting the 409 for the newcomer case carries `code: "RESERVATION_CONFLICT"` (or, if the tie is kept, that no `+$1` hint is emitted).
- **Fix.** The hold is decided first and rendered. `getActiveReservation` + `reservationConflict` moved
*ahead of* `classifyAndValidate` (`app/api/checkout/route.ts:303-333`), so a well-formed amount from
a non-owner meets `409 RESERVATION_CONFLICT` (`:325`) before any tie or floor message can answer for
it; a malformed amount keeps its shape message, because a hold cannot explain a negative bid. The
refusal now says what does land: `joinSpace(existingTotals, reservedTotal)`
(`lib/stakeQuote.ts:124`) returns `{kind:"room", amount}` when some total under the hold is still
free and `{kind:"locked", free}` when the tile is closed, and the route publishes exactly one —
`joinHint` (`route.ts:328`) or `joinBlocked` (`:329`) — to a newcomer only, since the incumbent's
remedy is the wait. The payload publishes `reservedTotal` and `expiresAt` and no owner, deliberately:
a hold exists only on a TAKE path whose owner is the leader by construction, so there is no "by
another" to prove and nothing to leak. `lib/api.ts` types the three fields,
`lib/checkoutFace.ts:131-142` turns them into the client sentence (`A $5 bid still joins the
ladder.` / `No amount lands until that hold ends.`) with precedence over the price-move copy, and
`components/Modals.tsx` renders the same hold from the detail payload's new `takeHold` field
(`app/api/elements/[sym]/route.ts:93`). Verified in §5.7 — `lib/routes.test.ts`'s probe refuses on a
live hold *and* shows the hinted amount then landing, `lib/checkoutFace.test.ts` covers
hint/blocked/hint-wins-precedence, `lib/stakeQuote.test.ts` the three `joinSpace` arms.
- **Status.** fixed

### R09-2 — `guaranteedTake: true` expires silently: a take that settles after its hold lapses applies at its stale amount, lands behind a newer leader, and its receipt still says #1

- **Severity.** P2
- **Category.** money
- **Evidence.** `lib/settle.ts:158-174`: if the payment's reservation is `ACTIVE` but `expiresAt <= now`, the reservation is marked `EXPIRED` and `takeGuaranteed` stays `false` — the stake is then applied unconditionally (`:172-182`). Nothing at settlement re-reads the leader. The promise itself is minted at checkout: `app/api/checkout/route.ts:370-374` returns `reservation: { …, guaranteedTake: true }`, and `lib/api.ts:181` types it. Observation W: `e2` was quoted `reservedTotal 6` with `guaranteedTake: true` at 10:19:16Z, did not pay, the hold lapsed at 10:19:31Z, `e3` took at **$7** and paid, and `e2`'s stale $6 then **settled 200** into rank 2 (`isLeader false`, tile `pool 18`). `EmailLog` for that settlement reads `receipt | e2@d9-e.dev | Er | 6 | "You're #1 in Er (Erbium) 🎉"`. A plain $5 join would have bought the same rank 2, so the stale take is also a $1 overpay here — unbounded in principle, because the gap is `payment.amount − takeLeadPrice(what a join would have cost for that rank)`.
- **Reproduction.** `node _b2doc09f.mjs http://127.0.0.1:3206`; steps W1–W5, then `select template, "to", detail from "EmailLog" order by "createdAt" desc limit 3`.
- **Proposed fix.** Decide the product rule for a lapsed take and encode it at settle: either (a) settle it as an ordinary stake and record the downgrade — `detail: "take-lapsed:<rank>"` on the payment plus a "your take landed at #N" mail — or (b) refuse the application, leave the row `PENDING` with an operator-visible reason and refund. Either way the receipt must read the applied rank rather than the intent (shared with doc `10`). Test: `lib/settle.test.ts` with an `ACTIVE`-but-expired reservation asserting the chosen outcome and that the receipt payload carries the settled rank.
- **Fix.** Arm (a), the conservative one: the take settles as an ordinary stake at its stale amount —
the money is captured and no refund path exists for a `PENDING` row (`08`) — and the downgrade is
recorded and mailed instead of hidden. `lapsedTakeTotal` is carried out of the reservation block
(`lib/settle.ts:235,242`); the application path itself is untouched. After the stake is applied, a
`TAKE_LAPSED` audit row is written with `detail: "take-lapsed:<rank>"` and the settlement's rank
(`:262-270`, action added at `lib/audit.ts:31`) — the rank U09-3 said could not be reconstructed.
The receipt carries `lapsedTakeTotal` (`:315`, payload type in `lib/outbox.ts`), the subject is
rank-aware (`receiptSubject({ …, rank })`, `emails/receipt.tsx:23`: the 🎉 form only at rank ≤ 1) and
the body appends the lapse sentence (`:28-40`), plumbed through `lib/email.ts:125`. Verified in §5.7
by `lib/settle.test.ts`, which builds a real expired reservation and asserts the stake amount, the
`rank` (2 — a raider outbid the quote while it ran), the `EXPIRED` status, the audit detail, the
payload's `lapsedTakeTotal`/`rank`, and the rendered HTML and subject.
- **Status.** fixed

### R09-3 — The tie rule is a pre-commit check, not an invariant: two simultaneous claims at the same amount both settle, and the second buyer pays the tie price for rank 2

- **Severity.** P2
- **Category.** correctness
- **Evidence.** `lib/pricing.ts:136-138` states in a comment that "Ties cannot occur post-validation", and `assertLedgerInvariants` (`:166-192`) checks rank contiguity, one leader, pool sum and row count — never amount uniqueness. The tie check therefore only sees rows that are already committed, and a stake row is written at **settlement**, not at checkout. Observation V: two claims at $5 were opened together on the empty `Ho` (`V1a`/`V1b`, both `200`), both were paid (`V2`, both `200`), and the tile now shows `d9-v1.dev 5 rank 1 leader` and `d9-v2.dev 5 rank 2 isLeader false` with `pool 10, takeLead 6` — two rows at the same total. DB read confirms `amountUsd 5` for both. Contrast X8, where the same $5 against a *committed* $5 is refused `TIE`.
- **Reproduction.** `node _b2doc09g.mjs http://127.0.0.1:3206 Ho`; then dump the `Ho` ladder.
- **Proposed fix.** Either accept ties and make the rank order explicitly tie-broken (it already is, `lib/pricing.ts:141-152`) — in which case the `TIE` rejection, its copy and the comment should be reworded to "the same total is refused only against bids already on the board" — or make the amount truly unique by holding the claim at checkout (the empty-tile case has no reservation today, `route.ts:295-327`) so the second claim is refused before money moves. Test: a `ledger.test.ts` case that settles two equal claims and asserts the documented outcome.
- **Fix.** The first arm: ties stay possible and are explicitly tie-broken; the rule is reworded to say
only what it enforces. `lib/pricing.ts:46` now reads `$5 is already on the board — add $1 to stand
clear of the tie.` and the prior-total form at `:60` `would tie a bid already on the board`; the
classifier's comment above them states that the check sees committed rows only. No behaviour change
at intake, which is the point — the ledger's own answer (amount desc, `createdAt` asc, row id) is now
the documented one. Verified in §5.7 by `lib/ledger.test.ts`, which lands two equal claims, asserts
arrival order, then *forces* an identical `createdAt` on both rows and asserts the id tie-break
decides and survives a re-rank, and finishes with `assertLedgerInvariants` over the whole board;
`lib/pricing.test.ts` pins both reworded strings.
- **Status.** fixed

### R09-4 — A fully unwound stake is still listed as a bid and still counted, so a tile can show one stake, `count 1`, `pool 0` and no leader

- **Severity.** P3
- **Category.** data
- **Evidence.** `lib/pricing.ts:149-157` deliberately keeps reversed rows (`amountUsd 0`) for click history and first claims, and `isLeader: i === 0 && s.amountUsd > 0` keeps them off the crown. But the display payload maps **every** row into `stakes` with `rank: i + 1` (`app/api/elements/[sym]/route.ts:44-56`) while the leader lookup skips zero rows (`:41-42`). Observation ZA: after the unwind, `Po` serves `pool: 0, count: 1, stakes: [{domain: "d9-x.dev", amount: 0, rank: 1, isLeader: false}], prices: {takeLead: 5, joinMin: 5}` — a listed bidder who has no bid, occupying rank 1 without the crown.
- **Reproduction.** `node _b2doc09c.mjs http://127.0.0.1:3206` (Z1–Z4), `npx tsx _b2rev.ts <paymentId>`, then `node _b2doc09d.mjs http://127.0.0.1:3206` (ZA).
- **Proposed fix.** Filter `amountUsd: { gt: 0 }` in the display `include` and recompute `count` from the same set (or keep the row but render it as an unlisted historical entry). Reference: `08` owns what the unwind must preserve; this is only about what the public payload asserts. Test: extend `lib/routes.test.ts` to assert a zero-amount row is not listed as a bid.
- **Fix.** The filter, not the row: `amountUsd: { gt: 0 }` sits beside the intact
`moderationState: { not: "HIDDEN" }` literal in both display surfaces
(`app/api/elements/[sym]/route.ts:29`, `app/elements/[sym]/page.tsx:62`), and the payload's `count`
is recomputed from the rows it publishes (`route.ts:91`) instead of read from the denormalized
aggregate that `lib/recompute.ts` still keeps for click history and first claims. The
server-rendered page keeps its own arithmetic (`stakes.length + hiddenStakes`), so a hidden rival
does not vanish from the count. The ZA payload (`count 1`, one `amount 0` row at `rank 1`, no
leader) is now unservable: the element reads `count 0`, `pool 0`, `prices { takeLead: 5, joinMin: 5
}`. Verified in §5.7 by `lib/routes.test.ts`, which writes an unwound row on a real element and
asserts it is absent from `stakes` and from `count`.
- **Status.** fixed

### R09-5 — The reclaim quote has no floor and no expiry, so a bidder unwound to $0 can be offered a figure the intake then refuses

- **Severity.** P3
- **Category.** content
- **Evidence.** `lib/pricing.ts:14-17` floors a reclaim at $1 and has no lower bound beyond that; `lib/email.ts:85` uses the same `Math.max(1, winner + 1 − victim)` for the mailed figure, and `lib/links.ts:17-23` puts it in the URL (`/?el=Er&stake=3&r=…`). `TIE`/`stakeQuote` therefore advertise reclaims below the $5 newcomer floor — legitimately, and Z3 proves the server accepts the mailed $2. The gap opens only when the bidder's own row is unwound to zero between the quote and the click: their total drops out of `myPriorTotal` (`app/api/checkout/route.ts:218` requires `amountUsd > 0`) and the amount is reclassified as a first join, so `lib/pricing.ts:20-24` answers `"First stake is $5+."` — observed in ZB for $1 after the ZA unwind.
- **Reproduction.** ZA + ZB (`node _b2doc09d.mjs http://127.0.0.1:3206`), with the outbid payload from Z2 as the mail that produced such a link.
- **Proposed fix.** When a reclaim figure below the floor is quoted, say so where the figure is rendered (`lib/stakeQuote.ts`) and in the mail ("if your stake has been refunded, re-entry is $5"), instead of letting the intake answer with the newcomer message after a click. Test: `lib/stakeQuote.test.ts` case with `myTotal === 0` and `leaderTotal > 4` asserting a floor-aware hint; `links.test.ts` unchanged.
- **Fix.** `smallestFreeAmount(existingTotals, floor)` (`lib/pricing.ts:20`) answers the lowest amount a
tile will actually accept — the floor, unless a row already sits on it — and is the number now quoted
wherever a first bid is described: `joinSpace` (`lib/stakeQuote.ts:126`), the room sentence (`:196`)
and the newcomer line (`:208`, `A first bid is $5+ — $6 takes #1 right now.`). A refunded bidder who
arrives at a mailed sub-$5 link therefore learns the floor at the point of entry, inside the modal,
rather than from `First stake is $5+.` after the click. Two limits are deliberate. The reclaim
arithmetic is unchanged (`Math.max(1, winner + 1 − victim)` still quotes the mailed $2, and `Z3`
still proves a live row takes it — this finding is about the *gap* after a refund, not the figure).
And the mail's own sentence is left to doc `10`, which owns `emails/outbid.tsx` and its copy lock,
where the same floor question is answered for every template at once; §11 records the deferral.
Verified in §5.7 by `lib/stakeQuote.test.ts`, whose floor-plus-hold cases assert the hint equals
`smallestFreeAmount(existingTotals)` rather than a literal.
- **Status.** fixed (the rendering half; the mail's wording is doc `10`'s)

### R09-6 — The crown copy promises that "any $5+ amount joins the ladder" on elements where $5 is the one amount that cannot

- **Severity.** P3
- **Category.** ux
- **Evidence.** `components/Modals.tsx:414-426` renders "Any $5+ amount joins the ladder — $N grabs #1 right now. Exact ties are rejected, so stand $1 clear." whenever the caller is below the take price. On `Ar` at the $5 floor that is false in two directions: $5 is refused (`TIE`, X4/X8) and $6 was refused by the hold while it lived (X3/X5). The same copy is shown to the incumbent, whose only remedy for a live hold is to wait (X6).
- **Reproduction.** X4/X8 against `components/Modals.tsx:414-426`; the copy is static, so the check is the message text versus the 409 body.
- **Proposed fix.** Derive the sentence from `stakeQuote` (`need`, `belowNeed`, `takeQuoted`) instead of a fixed "$5+": state the smallest acceptable amount for *this* bidder and, when a hold is live, the amount and the expiry. Test: `lib/claimFace.test.ts` (the batch-1 R05-1/R05-4 file) extended with the floor-plus-hold case.
- **Fix.** The three fixed sentences are gone from `components/Modals.tsx`; the modal calls
`crownCopy({ elementName, boardComplete, existing, existingTotals, heldUntil, heldTotal, need,
priorTotal, takeLead, userTotal })` (`lib/stakeQuote.ts:161-215`) and renders `{crown.lead}` and
`{crown.joins}`, so the sentence is a function of the board the modal can see and the hold the
server published. On a floor-priced tile it says `$5 is already on the board — add $1 …` with the
amount that does land; with a live hold it names the hold and the amount that still fits; the
incumbent is told the wait. The `takeQuoted` suffix is preserved. Verified in §5.7 by the new
assertion block in `lib/detailFace.test.ts`, which requires the derived call shape (including
`boardComplete`, `heldUntil`/`heldTotal`, `{crown.lead}`/`{crown.joins}`) and forbids the three
removed sentences from returning; `lib/stakeQuote.test.ts` holds both `crownCopy` arms (held and
not-held) and the `joinSpace` arms the copy is built from.
- **Status.** fixed

### R09-7 — A dethroned holder with no email address is never told they lost #1

- **Severity.** P3
- **Category.** ops
- **Evidence.** `lib/settle.ts:222-233` enqueues the outbid mail only `if (victim?.email)`; nothing else records the event for the victim — the activity feed row and the audit row are operator/public surfaces, not notifications (doc `08` §5, `lib/settle.ts:203-256`). The address is optional at intake (`components/Modals.tsx:236-256` sends `email?`), and in the seed 10 of 40 startups have none. Observation: `e1` (who had an address) received `outbid … Er 3` at 10:19:16Z, while Z2's victim and X10's displaced leader were both reachable only because those probes supplied addresses.
- **Reproduction.** Compare `lib/settle.ts:222-233` with `select count(*) from "Startup" where email is null or email = ''` and the absence of any alternative channel in `app/api/outbox`-adjacent code (doc `10`'s inventory).
- **Proposed fix.** Product decision, then either require an address to hold a stake (intake `06`), or send the "you lost #1" notice to the address on the *payment* that funded the stake (the `Payment.email` that is already stored, `prisma/schema.prisma:171-199`), or accept that an anonymous holder learns from the board. Test: `lib/settle.test.ts` case where the victim has no `Startup.email` but its funding payment has one, asserting the chosen behaviour.
- **Fix.** The payment's own address, then the audit row. The outbid block resolves
`victim?.email ?? fundingEmail?.email ?? null` (`lib/settle.ts:337`), where `fundingEmail` is the
newest `PAID` payment on the same element and startup that carries one (`:325`) — the address the
bidder typed at checkout, which is the only address this product has ever been given for an
anonymous listing. When neither exists the notice is not dropped in silence any more: an
`OUTBID_UNNOTIFIED` audit row (`:355`, `lib/audit.ts:34`) records the victim startup and
`detail: "no-address:<victimDomain>"`, so the population of unreachable holders is a query rather
than an inference — which is what the finding's evidence (`10 of 40 startups have no address`) was
missing. The receipt uses the same expression and is unchanged by this. Verified in §5.7 by two
`lib/settle.test.ts` cases: a victim whose startup has no email is mailed at its funding payment's
address with no audit row, and a victim with neither channel produces no outbox row plus exactly the
audit row naming its domain.
- **Status.** fixed

## 8. Acceptance criteria

- [x] An ownership rule a support agent can apply without reading code — §3.1, one row per question, each with `file:line`.
- [x] A reclaim is defined and its arithmetic checked against a live payment — §3.1 and Z3 ($2 accepted), Y4/`lib/email.ts:85`.
- [x] The $5-floor-versus-$4-mail question answered explicitly — §3.1 row 4, with ZB as the case where the floor *does* apply.
- [x] Where a displaced holder's money goes, stated and observed — §3.1 row 8, Z3/ZD (`w` parked at $6, rank 2, reclaim intact).
- [x] Ties: rule, reachable violation, and the resulting board — §5.6, R09-3.
- [x] Self-outbid ruled out with the arithmetic, not by test — §3.1 row 6, `lib/pricing.ts:111-141` (`:133-134`).
- [x] Two simultaneous buyers covered with the observed outcome and the concurrency machinery named — §5.4, §5.6, §3.2 (`pg_advisory_xact_lock`, `Serializable` + retry, unique-violation replay).
- [x] Whether the outbid email can arrive pre-filled — yes: `lib/links.ts:17-23` builds `/?el=<sym>&stake=<reclaim>&r=<victimDomain>`, `app/page.tsx:118-161` parses those three parameters, `components/Modals.tsx:95-129` seeds the domain, the amount (minted, so it keeps tracking the board until edited) and the tab, and Z3 shows the mailed figure is an amount the server takes. The step that is broken in this class of link is the *preview* the modal wants for the domain (`app/api/emails/preview` 500, doc `10`), not the prefill.
- [x] R09-1's hold state rendered to the buyer — the modal reads `takeHold` from the element payload and
      `lib/stakeQuote.ts`'s `joinSpace`/`crownCopy` state the amount that still lands or that none does;
      the route names the hold before any other rule (§5.7).
- [x] R09-2's lapsed-take rule — arm (a): it settles as an ordinary stake at the stale amount, with a
      `TAKE_LAPSED` audit row carrying the applied rank and a receipt that reports that rank instead of
      the quote's promise (§5.7, §9 Q2).

**Fix-pass criteria** (2026-09-15, verified by §5.7):

- [x] No rejection can advise an amount the element will refuse in the same window: the hold is decided
      before the tie rule, and the advice it carries is computed from the same totals the intake will
      read (R09-1 — `route.ts:303-333`, `lib/stakeQuote.ts:124`)
- [x] A take that settles after its hold lapses is either recorded as a downgrade or refused — not
      applied silently: the applied rank, the stale total and the audit row are all written (R09-2 —
      `lib/settle.ts:262-270,315`)
- [x] The tie rule's reachable consequence is asserted, not assumed, and the copy states only what the
      ledger enforces (R09-3 — `lib/ledger.test.ts`'s forced-`createdAt` case)
- [x] The public board never lists a rank-1 bidder with no bid, and `count` matches the rows it
      publishes (R09-4 — `lib/routes.test.ts`'s zero-amount case)
- [x] Every amount quoted to a bidder is one the intake accepts: the floor is stated where a first bid
      is described, holding or not (R09-5 — `smallestFreeAmount`, §11 records the mail's half as
      doc `10`'s)
- [x] The crown sentence is derived from the live board and the live hold, and cannot be a literal
      (R09-6 — `lib/detailFace.test.ts`'s block forbids the three removed sentences)
- [x] A dethroned holder is either mailed or recorded as unmailable; a notice is never dropped in
      silence (R09-7 — `lib/settle.ts:325-360`, `lib/settle.test.ts`'s two cases)
- [x] The new `lib/reservations.test.ts` exercises the reservation module directly — the store, the
      sweep and the consume step — against a real database, including the partial unique index that
      allows one live hold per element (13 cases, §5.7)

## 9. Open questions

1. **Should a live hold be visible to the competitor at all?** Today the incumbent and every newcomer learn about it only from a rejection (X3/X4/X5), and on a floor-priced tile that rejection is the tie message, which is unactionable (R09-1). Showing "$6 held until 10:16:37 by a rival" makes the wait rational; hiding it is defensible only if takes are expected to complete in seconds. Operator call. **Answered by the fix pass (arm: show it, do not hide it):** the hold is now the first
thing every rejection names and the modal renders it from the element payload, so a waiting newcomer
is told the amount that still lands or that the tile is closed until the expiry. The operator decision
was not "should the hold be visible" but which side of the trade-off to take, and the pass took the
one that makes the wait rational. What it deliberately did **not** take is the second half of the
question — whether a hold should be visible *before* a rejection (a countdown on the tile itself): the
payload carries `takeHold` and the modal uses it, but the board does not advertise a rival's hold while
the visitor is merely looking. The unpaid-hold-for-15-minutes behaviour (Q4) is unchanged.

2. **What should happen to a take that settles after its hold lapses?** Applying it at the stale amount (today) honours the money and keeps the ledger clean, but sells a rank the buyer did not choose and the receipt misstates it. Refusing it needs a refund path the ledger does not have for a `PENDING` payment (`08`). Operator call; the current behaviour is at least deterministic.

**Answered by the fix pass (arm (a), apply and record):** the take still settles at its stale amount —
the money is captured and `08` has no refund path for a `PENDING` row — and the misstatement is what
the pass fixed: a `TAKE_LAPSED` audit row carries the applied rank, and the receipt reports that rank
with a sentence saying the quote lapsed. The rank the buyer did *not* choose is still sold to them;
that part is the price of the conservative arm and is stated here rather than fixed.

3. **Is the $5 first-join floor meant to apply to a bidder returning after a refund?** Today it does (ZB), while their old row remains visible and their last mailed quote may have been below $5 (R09-5). If refunded bidders are meant to be able to reclaim at the mailed figure, the classifier needs a "has history on this element" flag separate from `amountUsd > 0`.

**Partly answered, partly still open.** The fix pass did not change the classifier, so the floor still
applies to a refunded bidder (ZB) — but the copy no longer lets that arrive as a surprise: the modal
states the smallest amount the tile will take at the point of entry (R09-5). Whether the *rule* should
change is still an operator call, and it is the same question as Q4's for a different reason: both
armed the same risk — a bidder told one figure and refused another — and only the second was fixed.
4. **Should an unpaid hold be considered abuse?** A `$6` claim costs nothing until it is paid (X2) and can freeze an element's top of the ladder for 15 minutes. Nothing rate-limits reservations beyond the 5/hour intake limit (`app/api/checkout/route.ts:116-119`), and the reservation rows are cheap.

## 10. Cross-references

- `04` §7 R04-1/R04-2 — the quote derivation and `prices.boardComplete` this doc builds on (cited, not re-opened).
- `06` §7 R06-3 — the two `409`s that both announced "Price moved"; §7 R06-1 the silent-bail intake; §7 R06-7 the provider failure that leaves a `Payment` row.
- `08` §7 R08-2 — reversal sends the buyer nothing; §7 R08-4 the dead `lib/applyPayment.ts`; §6 the terminal-rejection rows this doc's `RESERVATION_CONFLICT` is *not* part of.
- `10` — the outbid and receipt templates referenced here (`lib/email.ts:85`, `emails/outbid.tsx`, the receipt subject). The receipt's subject and body are now rank-aware and lapse-aware (§7 R09-2); the outbid template's floor sentence is deliberately left to `10`, which owns that file and its copy lock (§7 R09-5).
- `12` — concealment (`moderationState: "HIDDEN"`) as an ownership modifier.
- `doc/PROD-READINESS-CHECKLIST.md` — the settled production/environment facts cited in the probe table.

## 11. Change log

- 2026-09-15 — authored 2026-09-15 against 9681bdcbff2435ef258224c52000e0f8d6089f5c. First pass: 12 sections, R09-1…R09-7, U09-1…U09-4.
- 2026-09-15 (working tree) — fix pass for R09-1…R09-7, each cited in §7 with its verification in §5.7
  (a new section, written against a real Postgres: the `08` container on CI's port 55433, all
  migrations applied, `npm run test:ci` green at 46 files / 680 passed / 0 skipped), the §6 matrix
  extended with the rows the pass changed, §8's two open criteria ticked and a fix-pass block added,
  and §9 Q1–Q3 annotated with the arms taken. Decisions, each one a choice between two defensible
  readings. **R09-1**: the hold is named *before* the rule it used to be confused with — the conflict
  moved ahead of `classifyAndValidate` — but the fix publishes the amount that still lands rather than
  the hold's owner (`reservedTotal` + `expiresAt` + `joinHint`/`joinBlocked`, never a `paymentId`),
  because a hold only exists on a TAKE path whose owner is the leader by construction. **R09-2**: arm
  (a), apply-and-record, not arm (b), refuse-and-refund — the ledger has no refund path for a
  `PENDING` row (`08`), so the pass made the record truthful instead of inventing a state machine; the
  rank is carried on a `TAKE_LAPSED` audit row because there is no `Payment.detail` column to put it
  in. **R09-3**: the reword arm, not the hold-the-empty-tile arm — simultaneous claims stay legal and
  the ledger's tie-break is asserted by test rather than removed. **R09-5**: the floor is stated where
  the figure is rendered, and the *mail's* sentence is left to `10`, which owns `emails/outbid.tsx`
  and its copy lock — the one part of a finding this pass handed on rather than took.
  Files: `lib/pricing.ts` (tie copy at `:46,60`, `smallestFreeAmount` at `:20`), `lib/stakeQuote.ts`
  (`heldByOtherUntil`/`heldByOtherTotal`, `joinSpace` `:124`, `crownCopy` `:161`),
  `app/api/checkout/route.ts` (reservation conflict before classification `:303-333`),
  `app/api/elements/[sym]/route.ts` (`amountUsd > 0` `:29`, `count` from listed rows `:91`, `takeHold`
  `:93`), `app/elements/[sym]/page.tsx` (the same filter `:62`), `components/Modals.tsx` (`takeQuote`
  from the payload, `crownCopy` rendering), `lib/api.ts`, `lib/checkoutFace.ts` (`:131-142`),
  `lib/reservations.ts` (header rationale; no logic change), `lib/settle.ts` (`lapsedTakeTotal`
  `:235-242`, `TAKE_LAPSED` `:262-270`, receipt payload `:315`, funding-payment address `:325-337`,
  `OUTBID_UNNOTIFIED` `:355`), `lib/audit.ts` (`:31,34`), `lib/outbox.ts`, `lib/email.ts`,
  `emails/receipt.tsx` (rank-aware subject and lapse paragraph). Tests: new `lib/reservations.test.ts`
  (13, the module's first), 11 added to `lib/stakeQuote.test.ts`, 3 to `lib/routes.test.ts`, 3 to
  `lib/settle.test.ts`, 1 each to `lib/checkoutFace.test.ts`, `lib/ledger.test.ts` and
  `lib/detailFace.test.ts`, and two repaired assertions (`lib/pricing.test.ts`'s tie copy,
  `lib/detailFace.test.ts`'s import) — 33 new tests, 647 → 680. No live provider: U09-1…U09-4 stand,
  with U09-3's "the rank is not recorded" now answered for future settlements (it was about the rows
  already in the database).
- 2026-09-15 (working tree) — **citation refresh.** The pass moved code that this doc's living
  references point at, so §2's "Probe not run" residue pointers, §3.1's rules table, §3.2's money
  rules, §4's walked path, §8's ticked criteria and §5.7's own `file:line` citations were re-read
  against the post-fix tree and updated (route conflict `:303-333`, classifier `:313`, leader `:284`/
  own row `:291`/totals `:296`, advisory lock `:264`, P2002 recovery `:419-434`, hold mint `:384-413`,
  `rankStakes` `:156-179`, classifier `:111-141`, invariants `:181-207`, `settlePayment` `:184-440`
  and the lapsed/outbid blocks `:229-281`/`:319-364`, `lib/reservations.ts` `:21-34,48-89`). §7's
  **Evidence** cells were *not* touched: they are the record of what was observed on the day, and
  each finding's **Fix** cell carries the post-fix location. §6's first table is the same kind of
  record and says so under it; the "After the fix pass" table beside it is the current behaviour,
  and §1's "Paths inspected" list keeps its at-the-time line ranges for the same reason.
  No production code or test changed in this pass — `npm run lint`, `npx tsc --noEmit` and
  `npm run test:ci` (46 files / 680 passed / 0 skipped) were re-run green on the tree it describes.

## 12. UNKNOWN log

| Id | Unknown | What settles it |
| --- | --- | --- |
| U09-1 | How often R09-1's floor-plus-hold lockout is hit by real buyers | A production read of `ClaimReservation` joined to the leader's amount at the same instant — e.g. `select count(*) from "ClaimReservation" r join "Element" e on e.id = r."elementId" where r.status = 'ACTIVE' and exists (select 1 from "Stake" s where s."elementId" = e.id and s."amountUsd" = 5)` run against the production replica, or a week of `ActivityLog` `CHECKOUT_*` rows carrying `code: RESERVATION_CONFLICT` |
| U09-2 | Whether a real (test-mode Stripe) buyer has ever settled a take whose reservation had expired | A read of the Stripe test account's `payment_intent` timeline against `Payment.paidAt` for rows whose `ClaimReservation.expiresAt < Payment.paidAt`, e.g. `select count(*) from "Payment" p join "ClaimReservation" r on r."paymentId" = p.id where p.path = 'TAKE' and p.status = 'PAID' and r.status = 'EXPIRED' and r."expiresAt" < p."paidAt"` against a database with paid rows |
| U09-3 | What the applied rank was at the moment a late take settled (the rank is not recorded) | Adding the settled rank to the settlement detail, or a one-off back-fill: the `ActivityLog`/`AuditLog` rows written at settle carry the amount but not the rank — inspect `select type, detail from "AuditLog" where type like '%PAYMENT%' order by "createdAt" desc limit 20` on a production-like database to see whether the rank can be reconstructed from the timestamps |
| U09-4 | Whether the tie guard can be bypassed a second time on an element that already carries a tied pair | Re-run the two-simultaneous-claims probe of `09` §5.6 against a database where `Ho` already carries two equal rows: two `POST /api/checkout` calls at the same amount from different IPs, both paid through `POST /api/dev/pay`, then read `GET /api/elements/Ho` for a third equal row; no production data is touched by the local run |

All four stand after the fix pass (§5.7, "Still not measured"): no production database, no Stripe
dashboard and no test-mode buyer is reachable from this checkout, so nothing in U09-1…U09-4 was
answered by running it. One of them changed shape rather than closed. U09-3 asked what the applied
rank was *because nothing wrote it down*, and the R09-2 fix writes it down from now on
(`take-lapsed:<rank>` on the `TAKE_LAPSED` audit row) — so the unknown is now about the rows that
already exist, which is why its "what settles it" column still reads as a back-fill question. U09-1 and
U09-4 are both probes this checkout *can* run but did not: U09-1 needs a production replica, U09-4 needs
the two-simultaneous-claims run against an element that already carries a tied pair — a local run, and
the one to make first if a future pass wants to know whether the documented tie outcome degrades into a
third equal row.
