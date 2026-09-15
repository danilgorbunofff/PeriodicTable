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
| A stale take (`W4`) settled by a **real** card | No `.env` in this checkout and no test card; the dev provider has no "settled late" outcome, so the hold was expired by `RESERVATION_TTL_MS=15000` instead of by a slow human | None — the applied stake, ranks and mail are the real code paths (`lib/settle.ts:158-174`) |
| The production value of `RESERVATION_TTL_MS` | Production env is not readable from this checkout; `doc/PROD-READINESS-CHECKLIST.md` §5 covers provider and database variables, not this one | None — `lib/reservations.ts:14-19` is the only reader |
| Two takes on **different** elements in the same instant | The lock is per element (`app/api/checkout/route.ts:191`), so the outcome is stated from the code and from the same-element case, which is the interesting one | None |
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
| Who owns an element? | The stake with the highest `amountUsd > 0` among non-concealed startups — *not* the most recent payer, and not the biggest cumulative spender across elements | `app/api/elements/[sym]/route.ts:22-42`; `lib/pricing.ts:141-160` |
| What breaks an exact tie in the amount? | Nothing can be *accepted* at an amount already on the board (`TIE`), but if a tie is ever written, the earlier `createdAt` wins and then the smaller `id` | `lib/pricing.ts:28-35,141-152` |
| What does "reclaim" mean? | A bidder who already has money on the element tops it up until they pass the leader. The amount they need is `winner + 1 − (what they already have)`, floored at $1 | `lib/pricing.ts:14-17`; `lib/stakeQuote.ts:64-77` |
| Why does the mail say $4 when the floor is $5? | There is **no $5 floor on a reclaim**. The $5 floor is the *first-join* floor and it applies only to a bidder with no live money on that element. A holder sitting at $5 who is outbid by $8 is genuinely owed $4 and the intake accepts $4 | `lib/pricing.ts:14-17` vs `:20-24`; observation `Z3` ($2 accepted, 200) and `ZB` ($1 refused, 409 `BELOW_FLOOR`) |
| So when does a reclaim get refused for being too small? | When the bidder's own row has been unwound to $0 — a refund, chargeback or dispute (`08`). They are priced as a newcomer again, and their old $0 row is still on the board | `lib/pricing.ts:20-24`; `lib/recompute.ts:132-160`; observation `ZA`/`ZB` |
| Can I outbid myself? | No. A top-up is `prior + amount` and the amount is at least $1, so a bidder can never land on their own total; the code comment says so and the classification excludes only *other* bidders' totals | `lib/pricing.ts:119-127` |
| What do I get for $5 on an element that already has a $5 leader? | Nothing — the server refuses with `TIE` and tells you to add $1 | `lib/pricing.ts:28-35`; observation `X4`, `X8` |
| If I pay and lose, where is my money? | Still on my stake row, at face value. It keeps counting toward my next reclaim, it keeps its clicks, and it stays ranked on the board | `lib/recompute.ts:90-130`; observation `Z3`/`ZD` (z 5 → 7 with w parked at 6, rank 2) |
| Am I told when I lose #1? | Only by email, and only if you gave an address: the outbid mail is sent `if (victim?.email)`. 10 of the 40 startups in the seed have no address at all | `lib/settle.ts:222-233`; DB read below |
| If I hold a take quote and do not pay, what happens? | For up to `RESERVATION_TTL_MS` (15 minutes by default) nobody else can bid at or above your quote. Then it lapses and your quote is worth nothing | `lib/reservations.ts:14-19,38-52`; observations `X3`, `W2`/`W3` |
| Can I get a refund by taking #1 and not being #1? | Not automatically. The payment settles at the amount you paid and lands at whatever rank that buys. A take that lapses is applied, not cancelled | `lib/settle.ts:158-174`; finding R09-2 |

### 3.2 The money rules

A stake is money paid for a *rank*, and the rank is derived from the amount, never stored as an entitlement. `takeLeadPrice` is `leaderTotal + 1`, or $5 on an unbid element (`lib/pricing.ts:9-11`); `joinMin` is the $5 floor (`:7`); `reclaimFor` never returns less than $1 (`:14-17`). Every checkout, take, top-up and reversal runs through the same classifier (`lib/pricing.ts:97-127`) and asserts the ledger invariants before commit — one leader, rank 1 is the leader, pool equals the sum, count equals the rows (`:166-192`), throwing to abort the transaction on violation.

Concurrency is handled in three layers: a per-element advisory lock held for the whole checkout transaction (`SELECT pg_advisory_xact_lock(element.id)`, `app/api/checkout/route.ts:191`), a `Serializable` money transaction with a bounded retry on serialization failures (`lib/txn.ts`, retried only for `P2034`/`40001`/`40P01` up to 10 attempts with jittered backoff), and an outer unique-violation recovery that replays the winning attempt instead of 500-ing (`route.ts:334-349`). A take additionally mints a `ClaimReservation` at `leaderTotal + 1` that is enforced for everyone else until it is consumed by settlement or lapses (`lib/reservations.ts:38-52`).

## 4. The path, walked

1. **Read.** `GET /api/elements/Li` returns the ladder sorted by amount, rank and `isLeader` per row, plus `prices.boardComplete` (whether any row is concealed) and, with `?me=<domain>`, that domain's `reclaim` figure (`app/api/elements/[sym]/route.ts:22-70`).
2. **Ask for a quote.** The modal derives the same numbers client-side from the payload (`lib/stakeQuote.ts:60-78`): `need`, `belowNeed`, `reconciledAmount`, `takeQuoted`.
3. **Submit.** Under the per-element lock the server re-reads the board, takes the **first non-hidden row with `amountUsd > 0`** as the leader (`app/api/checkout/route.ts:211`), finds the caller's own live row (`:218`, also `> 0`), and classifies the amount against **every** non-hidden total, including rows at $0 and rows whose startup is concealed (`:223`, deliberately unfiltered so a reversal cannot be used to slip past a rival's total).
4. **Rejection.** `PRICE_MOVED` / `BELOW_FLOOR` / `TIE` come back as `409 { error, code, takeLead }` (`route.ts:227-238`); a live rival hold comes back as `409 { error, code: "RESERVATION_CONFLICT", reservedTotal, expiresAt }` (`:248-267`).
5. **Acceptance.** `200 { paymentId, checkoutUrl, provider, reservation? }`, and on a `TAKE` path the hold is minted at `leaderTotal + 1` for `RESERVATION_TTL_MS` (`:295-327`).
6. **Money.** `POST /api/dev/pay` (dev) or Stripe (live) marks the payment paid and settlement applies the stake inside the same locked, serialized transaction, reranks the element, and enqueues the receipt and — if someone was knocked off #1 — the outbid mail (`lib/settle.ts:145-260`).
7. **Reversal.** A refund or dispute unwinds the stake with `reverseStakeTx`, keeping the row, its clicks and its history, but zeroing the amount (`lib/recompute.ts:132-160`).

## 5. Live evidence

All timestamps 2026-09-15, server `http://127.0.0.1:3206` (dev provider, `RESERVATION_TTL_MS=15000`). Each request carried a fresh spoofed `cf-connecting-ip` so the 5/hour intake limit (`app/api/checkout/route.ts:116-119`) did not interfere.

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

## 7. Findings

### R09-1 — A live take hold can close an element to every bidder, and the rejection it produces recommends the one amount the hold refuses

- **Severity.** P2
- **Category.** money
- **Evidence.** `lib/reservations.ts:38-52` blocks any bid where `myPriorTotal + addUsd >= reservation.reservedTotal`; `app/api/checkout/route.ts:248-267` answers that with `RESERVATION_CONFLICT`; `lib/pricing.ts:28-35` rejects any amount equal to an existing total with `TIE`. On a tile whose leader sits at the $5 floor the hold is minted at $6 (`route.ts:302`), so a newcomer's reachable range is `$5 ≤ amount < $6` — which is exactly `$5`, which is exactly the leader's total. Observation: X2 (hold minted at $6 on `Ar`), X4 (newcomer's $5 → `409 TIE "$5 is taken — add $1 more to stand clear of the tie."`, `takeLead: 6`), X3 (`$6` → `409 RESERVATION_CONFLICT`). The advice in the X4 body is unactionable for the whole life of the hold, and `components/Modals.tsx:414-426` renders the same "add $1"/"$5+ joins the ladder" framing to every visitor.
- **Reproduction.** `node _b2doc09b.mjs http://127.0.0.1:3206` (dev provider, `RESERVATION_TTL_MS=15000`); steps X1–X6.
- **Proposed fix.** While any live reservation exists for the element, make it the *first* thing every rejection names (the incumbent path already does: `route.ts:248-267`), and suppress the tie hint in that window (`route.ts:227-238` should not offer `+$1` when `myPriorTotal + (amount + 1) >= reservedTotal`). The modal already receives `reservedTotal`/`expiresAt`; render the hold instead of the tie copy (`lib/stakeQuote.ts` is the right place to expose `heldByOtherUntil`). Test: `lib/reservations.test.ts` case with a live hold asserting the conflict payload is what the client renders; route test asserting the 409 for the newcomer case carries `code: "RESERVATION_CONFLICT"` (or, if the tie is kept, that no `+$1` hint is emitted).

### R09-2 — `guaranteedTake: true` expires silently: a take that settles after its hold lapses applies at its stale amount, lands behind a newer leader, and its receipt still says #1

- **Severity.** P2
- **Category.** money
- **Evidence.** `lib/settle.ts:158-174`: if the payment's reservation is `ACTIVE` but `expiresAt <= now`, the reservation is marked `EXPIRED` and `takeGuaranteed` stays `false` — the stake is then applied unconditionally (`:172-182`). Nothing at settlement re-reads the leader. The promise itself is minted at checkout: `app/api/checkout/route.ts:370-374` returns `reservation: { …, guaranteedTake: true }`, and `lib/api.ts:181` types it. Observation W: `e2` was quoted `reservedTotal 6` with `guaranteedTake: true` at 10:19:16Z, did not pay, the hold lapsed at 10:19:31Z, `e3` took at **$7** and paid, and `e2`'s stale $6 then **settled 200** into rank 2 (`isLeader false`, tile `pool 18`). `EmailLog` for that settlement reads `receipt | e2@d9-e.dev | Er | 6 | "You're #1 in Er (Erbium) 🎉"`. A plain $5 join would have bought the same rank 2, so the stale take is also a $1 overpay here — unbounded in principle, because the gap is `payment.amount − takeLeadPrice(what a join would have cost for that rank)`.
- **Reproduction.** `node _b2doc09f.mjs http://127.0.0.1:3206`; steps W1–W5, then `select template, "to", detail from "EmailLog" order by "createdAt" desc limit 3`.
- **Proposed fix.** Decide the product rule for a lapsed take and encode it at settle: either (a) settle it as an ordinary stake and record the downgrade — `detail: "take-lapsed:<rank>"` on the payment plus a "your take landed at #N" mail — or (b) refuse the application, leave the row `PENDING` with an operator-visible reason and refund. Either way the receipt must read the applied rank rather than the intent (shared with doc `10`). Test: `lib/settle.test.ts` with an `ACTIVE`-but-expired reservation asserting the chosen outcome and that the receipt payload carries the settled rank.

### R09-3 — The tie rule is a pre-commit check, not an invariant: two simultaneous claims at the same amount both settle, and the second buyer pays the tie price for rank 2

- **Severity.** P2
- **Category.** correctness
- **Evidence.** `lib/pricing.ts:136-138` states in a comment that "Ties cannot occur post-validation", and `assertLedgerInvariants` (`:166-192`) checks rank contiguity, one leader, pool sum and row count — never amount uniqueness. The tie check therefore only sees rows that are already committed, and a stake row is written at **settlement**, not at checkout. Observation V: two claims at $5 were opened together on the empty `Ho` (`V1a`/`V1b`, both `200`), both were paid (`V2`, both `200`), and the tile now shows `d9-v1.dev 5 rank 1 leader` and `d9-v2.dev 5 rank 2 isLeader false` with `pool 10, takeLead 6` — two rows at the same total. DB read confirms `amountUsd 5` for both. Contrast X8, where the same $5 against a *committed* $5 is refused `TIE`.
- **Reproduction.** `node _b2doc09g.mjs http://127.0.0.1:3206 Ho`; then dump the `Ho` ladder.
- **Proposed fix.** Either accept ties and make the rank order explicitly tie-broken (it already is, `lib/pricing.ts:141-152`) — in which case the `TIE` rejection, its copy and the comment should be reworded to "the same total is refused only against bids already on the board" — or make the amount truly unique by holding the claim at checkout (the empty-tile case has no reservation today, `route.ts:295-327`) so the second claim is refused before money moves. Test: a `ledger.test.ts` case that settles two equal claims and asserts the documented outcome.

### R09-4 — A fully unwound stake is still listed as a bid and still counted, so a tile can show one stake, `count 1`, `pool 0` and no leader

- **Severity.** P3
- **Category.** data
- **Evidence.** `lib/pricing.ts:149-157` deliberately keeps reversed rows (`amountUsd 0`) for click history and first claims, and `isLeader: i === 0 && s.amountUsd > 0` keeps them off the crown. But the display payload maps **every** row into `stakes` with `rank: i + 1` (`app/api/elements/[sym]/route.ts:44-56`) while the leader lookup skips zero rows (`:41-42`). Observation ZA: after the unwind, `Po` serves `pool: 0, count: 1, stakes: [{domain: "d9-x.dev", amount: 0, rank: 1, isLeader: false}], prices: {takeLead: 5, joinMin: 5}` — a listed bidder who has no bid, occupying rank 1 without the crown.
- **Reproduction.** `node _b2doc09c.mjs http://127.0.0.1:3206` (Z1–Z4), `npx tsx _b2rev.ts <paymentId>`, then `node _b2doc09d.mjs http://127.0.0.1:3206` (ZA).
- **Proposed fix.** Filter `amountUsd: { gt: 0 }` in the display `include` and recompute `count` from the same set (or keep the row but render it as an unlisted historical entry). Reference: `08` owns what the unwind must preserve; this is only about what the public payload asserts. Test: extend `lib/routes.test.ts` to assert a zero-amount row is not listed as a bid.

### R09-5 — The reclaim quote has no floor and no expiry, so a bidder unwound to $0 can be offered a figure the intake then refuses

- **Severity.** P3
- **Category.** content
- **Evidence.** `lib/pricing.ts:14-17` floors a reclaim at $1 and has no lower bound beyond that; `lib/email.ts:85` uses the same `Math.max(1, winner + 1 − victim)` for the mailed figure, and `lib/links.ts:17-23` puts it in the URL (`/?el=Er&stake=3&r=…`). `TIE`/`stakeQuote` therefore advertise reclaims below the $5 newcomer floor — legitimately, and Z3 proves the server accepts the mailed $2. The gap opens only when the bidder's own row is unwound to zero between the quote and the click: their total drops out of `myPriorTotal` (`app/api/checkout/route.ts:218` requires `amountUsd > 0`) and the amount is reclassified as a first join, so `lib/pricing.ts:20-24` answers `"First stake is $5+."` — observed in ZB for $1 after the ZA unwind.
- **Reproduction.** ZA + ZB (`node _b2doc09d.mjs http://127.0.0.1:3206`), with the outbid payload from Z2 as the mail that produced such a link.
- **Proposed fix.** When a reclaim figure below the floor is quoted, say so where the figure is rendered (`lib/stakeQuote.ts`) and in the mail ("if your stake has been refunded, re-entry is $5"), instead of letting the intake answer with the newcomer message after a click. Test: `lib/stakeQuote.test.ts` case with `myTotal === 0` and `leaderTotal > 4` asserting a floor-aware hint; `links.test.ts` unchanged.

### R09-6 — The crown copy promises that "any $5+ amount joins the ladder" on elements where $5 is the one amount that cannot

- **Severity.** P3
- **Category.** ux
- **Evidence.** `components/Modals.tsx:414-426` renders "Any $5+ amount joins the ladder — $N grabs #1 right now. Exact ties are rejected, so stand $1 clear." whenever the caller is below the take price. On `Ar` at the $5 floor that is false in two directions: $5 is refused (`TIE`, X4/X8) and $6 was refused by the hold while it lived (X3/X5). The same copy is shown to the incumbent, whose only remedy for a live hold is to wait (X6).
- **Reproduction.** X4/X8 against `components/Modals.tsx:414-426`; the copy is static, so the check is the message text versus the 409 body.
- **Proposed fix.** Derive the sentence from `stakeQuote` (`need`, `belowNeed`, `takeQuoted`) instead of a fixed "$5+": state the smallest acceptable amount for *this* bidder and, when a hold is live, the amount and the expiry. Test: `lib/claimFace.test.ts` (the batch-1 R05-1/R05-4 file) extended with the floor-plus-hold case.

### R09-7 — A dethroned holder with no email address is never told they lost #1

- **Severity.** P3
- **Category.** ops
- **Evidence.** `lib/settle.ts:222-233` enqueues the outbid mail only `if (victim?.email)`; nothing else records the event for the victim — the activity feed row and the audit row are operator/public surfaces, not notifications (doc `08` §5, `lib/settle.ts:203-256`). The address is optional at intake (`components/Modals.tsx:236-256` sends `email?`), and in the seed 10 of 40 startups have none. Observation: `e1` (who had an address) received `outbid … Er 3` at 10:19:16Z, while Z2's victim and X10's displaced leader were both reachable only because those probes supplied addresses.
- **Reproduction.** Compare `lib/settle.ts:222-233` with `select count(*) from "Startup" where email is null or email = ''` and the absence of any alternative channel in `app/api/outbox`-adjacent code (doc `10`'s inventory).
- **Proposed fix.** Product decision, then either require an address to hold a stake (intake `06`), or send the "you lost #1" notice to the address on the *payment* that funded the stake (the `Payment.email` that is already stored, `prisma/schema.prisma:171-199`), or accept that an anonymous holder learns from the board. Test: `lib/settle.test.ts` case where the victim has no `Startup.email` but its funding payment has one, asserting the chosen behaviour.

## 8. Acceptance criteria

- [x] An ownership rule a support agent can apply without reading code — §3.1, one row per question, each with `file:line`.
- [x] A reclaim is defined and its arithmetic checked against a live payment — §3.1 and Z3 ($2 accepted), Y4/`lib/email.ts:85`.
- [x] The $5-floor-versus-$4-mail question answered explicitly — §3.1 row 4, with ZB as the case where the floor *does* apply.
- [x] Where a displaced holder's money goes, stated and observed — §3.1 row 8, Z3/ZD (`w` parked at $6, rank 2, reclaim intact).
- [x] Ties: rule, reachable violation, and the resulting board — §5.6, R09-3.
- [x] Self-outbid ruled out with the arithmetic, not by test — §3.1 row 6, `lib/pricing.ts:119-127`.
- [x] Two simultaneous buyers covered with the observed outcome and the concurrency machinery named — §5.4, §5.6, §3.2 (`pg_advisory_xact_lock`, `Serializable` + retry, unique-violation replay).
- [x] Whether the outbid email can arrive pre-filled — yes: `lib/links.ts:17-23` builds `/?el=<sym>&stake=<reclaim>&r=<victimDomain>`, `app/page.tsx:118-161` parses those three parameters, `components/Modals.tsx:95-129` seeds the domain, the amount (minted, so it keeps tracking the board until edited) and the tab, and Z3 shows the mailed figure is an amount the server takes. The step that is broken in this class of link is the *preview* the modal wants for the domain (`app/api/emails/preview` 500, doc `10`), not the prefill.
- [ ] R09-1's hold state rendered to the buyer — needs the fix, not a doc (operator decision, §9 Q1).
- [ ] R09-2's lapsed-take rule — product decision (operator decision, §9 Q2).

## 9. Open questions

1. **Should a live hold be visible to the competitor at all?** Today the incumbent and every newcomer learn about it only from a rejection (X3/X4/X5), and on a floor-priced tile that rejection is the tie message, which is unactionable (R09-1). Showing "$6 held until 10:16:37 by a rival" makes the wait rational; hiding it is defensible only if takes are expected to complete in seconds. Operator call.
2. **What should happen to a take that settles after its hold lapses?** Applying it at the stale amount (today) honours the money and keeps the ledger clean, but sells a rank the buyer did not choose and the receipt misstates it. Refusing it needs a refund path the ledger does not have for a `PENDING` payment (`08`). Operator call; the current behaviour is at least deterministic.
3. **Is the $5 first-join floor meant to apply to a bidder returning after a refund?** Today it does (ZB), while their old row remains visible and their last mailed quote may have been below $5 (R09-5). If refunded bidders are meant to be able to reclaim at the mailed figure, the classifier needs a "has history on this element" flag separate from `amountUsd > 0`.
4. **Should an unpaid hold be considered abuse?** A `$6` claim costs nothing until it is paid (X2) and can freeze an element's top of the ladder for 15 minutes. Nothing rate-limits reservations beyond the 5/hour intake limit (`app/api/checkout/route.ts:116-119`), and the reservation rows are cheap.

## 10. Cross-references

- `04` §7 R04-1/R04-2 — the quote derivation and `prices.boardComplete` this doc builds on (cited, not re-opened).
- `06` §7 R06-3 — the two `409`s that both announced "Price moved"; §7 R06-1 the silent-bail intake; §7 R06-7 the provider failure that leaves a `Payment` row.
- `08` §7 R08-2 — reversal sends the buyer nothing; §7 R08-4 the dead `lib/applyPayment.ts`; §6 the terminal-rejection rows this doc's `RESERVATION_CONFLICT` is *not* part of.
- `10` — the outbid and receipt templates referenced here (`lib/email.ts:85`, `emails/outbid.tsx`, the receipt subject).
- `12` — concealment (`moderationState: "HIDDEN"`) as an ownership modifier.
- `doc/PROD-READINESS-CHECKLIST.md` — the settled production/environment facts cited in the probe table.

## 11. Change log

- 2026-09-15 — authored 2026-09-15 against 9681bdcbff2435ef258224c52000e0f8d6089f5c. First pass: 12 sections, R09-1…R09-7, U09-1…U09-4.

## 12. UNKNOWN log

| Id | Unknown | What settles it |
| --- | --- | --- |
| U09-1 | How often R09-1's floor-plus-hold lockout is hit by real buyers | A production read of `ClaimReservation` joined to the leader's amount at the same instant — e.g. `select count(*) from "ClaimReservation" r join "Element" e on e.id = r."elementId" where r.status = 'ACTIVE' and exists (select 1 from "Stake" s where s."elementId" = e.id and s."amountUsd" = 5)` run against the production replica, or a week of `ActivityLog` `CHECKOUT_*` rows carrying `code: RESERVATION_CONFLICT` |
| U09-2 | Whether a real (test-mode Stripe) buyer has ever settled a take whose reservation had expired | A read of the Stripe test account's `payment_intent` timeline against `Payment.paidAt` for rows whose `ClaimReservation.expiresAt < Payment.paidAt`, e.g. `select count(*) from "Payment" p join "ClaimReservation" r on r."paymentId" = p.id where p.path = 'TAKE' and p.status = 'PAID' and r.status = 'EXPIRED' and r."expiresAt" < p."paidAt"` against a database with paid rows |
| U09-3 | What the applied rank was at the moment a late take settled (the rank is not recorded) | Adding the settled rank to the settlement detail, or a one-off back-fill: the `ActivityLog`/`AuditLog` rows written at settle carry the amount but not the rank — inspect `select type, detail from "AuditLog" where type like '%PAYMENT%' order by "createdAt" desc limit 20` on a production-like database to see whether the rank can be reconstructed from the timestamps |
| U09-4 | Whether the tie guard can be bypassed a second time on an element that already carries a tied pair | Re-run the two-simultaneous-claims probe of `09` §5.7 against a database where `Ho` already carries two equal rows: two `POST /api/checkout` calls at the same amount from different IPs, both paid through `POST /api/dev/pay`, then read `GET /api/elements/Ho` for a third equal row; no production data is touched by the local run |
