# 08 — Settlement and ledger integrity

| Field | Value |
| --- | --- |
| Phase · batch | 08 · 2 |
| Status | draft |
| Date reviewed | 2026-09-15 |
| Commit reviewed | `9681bdcbff2435ef258224c52000e0f8d6089f5c` |
| Reviewer | review agent |

How this doc was produced: read-only inspection of `app/api/webhooks/stripe/route.ts`,
`lib/settle.ts`, `lib/money.ts`, `lib/recompute.ts`, `lib/txn.ts`, `lib/reservations.ts`,
`lib/audit.ts`, `lib/applyPayment.ts`, `app/api/jobs/reconcile/route.ts`, `prisma/schema.prisma`
and `prisma/migrations/`, plus live probes on 2026-09-15 against a scratch Postgres
(container `ptl-review-batch2-pg`, port 55499, migrations 0000–0006 deployed, `prisma/seed.ts`
loaded: 122 elements / 8 startups / 26 stakes / 26 activity rows) with Next dev servers run from
isolated copies of this commit (see 06 §4 for why the copies exist). Every delivery quoted below was
sent to `POST /api/webhooks/stripe` with a valid HMAC signature over that body; every DB line is the
literal output of a `psql` read against that scratch database. No production system was touched and
no application code was changed. Batch-1 settled facts are cited, never re-derived.

Probes run (all 2026-09-15):

| # | Probe | Result |
| --- | --- | --- |
| P1 | Signature family: missing header, wrong scheme, tampered body, 6-minute-old timestamp, valid | 401 / 401 / 401 / 401 / 200 |
| P2 | Malformed JSON body with a valid signature | 400 `bad json` |
| P3 | Ten-delivery state machine per payment (`evt2_*`): applied, applied-replay, amount mismatch, currency mismatch, reference-mismatch, reference-claimed, expired-then-paid, failed-intent, refund, dispute, double refund, refund-before-paid, settle 500 then retry | 200/200/200/…/500 — see §5.2 |
| P4 | `ProviderEvent` + `Payment` dump after P3 | §5.2, §5.3 |
| P5 | Same event id delivered twice with a payment already terminal | `applied` row rewritten to `duplicate` (§5.4) |
| P6 | `GET /api/jobs/reconcile` on a converged DB, then after a hand-written divergence | `200 ok:true divergent 0` / `503 divergent 1` |
| P7 | Reversal walk: `charge.refunded` on a PAID row, then replay, then `charge.dispute.created` on a second row | §5.6 |
| P8 | Delete a `Payment` row and re-read its `ProviderEvent` | `paymentId` → `NULL` (§5.7) |

| Probe not run | Why | Residue |
| --- | --- | --- |
| A signed delivery from Stripe's own servers (CLI `stripe trigger`) | No Stripe account or CLI session in this checkout; the endpoint only needs a valid HMAC, which is what P1–P3 supply | Whether Stripe's real payloads carry fields this route does not read (e.g. `charge.refunded` with a partial amount) — U08-2 |
| Real provider retry cadence (`settle-retryable` 500 → redelivery) | Requires a live endpoint URL registered in a Stripe dashboard | The exact number of redeliveries and the 3-day window are Stripe-documented, not measured here (§5.9) |
| A webhook delivery into a database that has been failed over mid-transaction | Requires managed Postgres failover | Behavior of `MONEY_TX` under connection loss — U08-3 |

---

## 1. Scope

In scope: the async half of S6 and all of S7 — signature verification, event classification order,
money and reference validation, duplicate/out-of-order handling, the settle transaction, the reversal
transaction, the ledger invariants enforced before commit, the `ProviderEvent` record, `Payment`
status transitions, and the reconciliation job. Out of scope: the buyer-facing checkout (doc 06), the
provider-mode gate and rotation procedures (doc 07), who owns an element and what a reclaim costs
(doc 09), and the mail that settlement enqueues (doc 10 — this doc only records that the outbox rows
are written in the same transaction).

## 2. Actors

- **Stripe** — sends signed deliveries, retries non-2xx for days, never redelivers a delivery that
  was answered 2xx.
- **The webhook route** (`app/api/webhooks/stripe/route.ts:38`) — verifies, classifies, records,
  delegates to `settlePayment`/`reversePayment`, and chooses the HTTP status that decides whether
  Stripe will come back.
- **`settlePayment`** (`lib/settle.ts:107`) — the only writer of `PaymentStatus.PAID` and the only
  creator of a stake from money.
- **`reversePayment`** (`lib/settle.ts:317`) — the only writer of `PaymentStatus.REFUNDED`.
- **`applyStakeTx` / `reverseStakeTx`** (`lib/recompute.ts:27`, `:132`) — recompute the three
  denormalized aggregates inside the caller's transaction and assert the invariants before commit.
- **The operator** — the only reader of `ProviderEvent`. A terminal rejection (`rejected`) is
  answered 200, so the record is the entire signal.
- **`/api/jobs/reconcile`** (`app/api/jobs/reconcile/route.ts:46`) — read-only recomputation of the
  PAID ledger; 503 when a PAID payment's stake does not match what the ledger says.

## 3. Intended behaviour

Read from the code and its comments (the route header `app/api/webhooks/stripe/route.ts:26-36` and
the `lib/settle.ts` header `:1-18` state the contract):

1. Every delivery is recorded exactly once per `providerEventId`, whatever its outcome
   (`prisma/schema.prisma:326` `@unique`).
2. A delivery that cannot be tied to a payment is recorded and answered 200 — Stripe must not retry
   a delivery that will never become actionable.
3. Money-reversing types are classified **before** paid/failed, because one payload can carry both
   (`app/api/webhooks/stripe/route.ts:77-100`).
4. Amount and currency are compared against the amount the buyer was charged by us, not against the
   payload (`lib/money.ts:33-53`).
5. A provider reference (`providerRef`) can be claimed by one payment only (`prisma/schema.prisma:182`
   `@unique`); a second payment claiming it is a loud, terminal error.
6. A stake is applied, the payment becomes PAID, the reservation is consumed and the outbox rows are
   written in **one** transaction under a per-element advisory lock (`lib/settle.ts:142-258`).
7. A reversal unwinds the stake and the aggregates in one transaction, writes REFUNDED and an audit
   row, and can never leave the ledger half-reversed (`lib/settle.ts:357-402`).
8. Deterministic rejections are terminal and answered 200; only retryable failures get a 5xx
   (`app/api/webhooks/stripe/route.ts:184-192`).

## 4. The path, walked

`POST /api/webhooks/stripe` (`route.ts:38`)

1. Signature check with the raw body (`route.ts:39-41`) → 401 `{error:"bad signature"}`.
2. Parse JSON (`route.ts:44-51`) → 400 `{error:"bad json"}`.
3. Extract `eventId`, `eventType`, `paymentId`, `providerRef`, amount/currency from the payload
   (`route.ts:53-56`, `:76-115`). No `paymentId` → upsert `IGNORED / no-paymentId` → 200
   (`route.ts:58-63`). Payment row missing → upsert `IGNORED / unknown-payment` → 200
   (`route.ts:68-74`).
4. Reversal classification (`route.ts:81-100`): a reversal type calls `reversePayment`. `rejected`
   → 200 `{ok:false,error}`; otherwise 200; a throw → 500 `reverse-retryable`.
5. Non-money events: `payment_intent.payment_failed` → `IGNORED / unrelated-event` → 200
   (`route.ts:107-115`); `checkout.session.expired` and `async_payment_failed` are treated as a
   failed payment (`route.ts:117-123`).
6. Money validation (`route.ts:125-137`): `validateProviderMoney` (`lib/money.ts:44-53`) returns
   `currency-mismatch:` / `amount-mismatch:` / `absent` / `ok`. Rejected → `ERROR` row + **200**.
7. Reference checks (`route.ts:139-161`): a payload reference that differs from the stored one →
   `reference-mismatch:`; a reference already held by a different payment → `reference-claimed:`;
   both `ERROR` + 200.
8. Terminal-status guard (`route.ts:162-169`): a payment that is not PENDING → `DUPLICATE /
   already-<status>` → 200.
9. `settlePayment(paymentId, {…, amountUnverified: check.status === "absent"})` (`route.ts:171-189`);
   `rejected` → 200 `{ok:false,error}`; otherwise 200; a throw → 500 `settle-retryable`
   (`route.ts:190-192`).

Inside `settlePayment` (`lib/settle.ts:107-300`): duplicate-event guard (`:108-119`) → unknown payment
(`:123`) → non-PENDING → `already-<status>` (`:127`) → `!paid` → `updateMany` to FAILED with
`failedAt` (`:130-138`) → `withTxnRetry(MONEY_TX)` (`:142`): advisory lock on the element (`:146`),
re-read the payment and return `lost-settle-race` if another settle won (`:258-264`), consume or
expire the reservation and refuse a short payment (`:150-168`, `take-below-reserve:` at `:162`),
`applyStakeTx` (`:170`), then one `payment.update` writes `status: PAID`, `paidAt`, `stakeId`,
`appliedAt`, `providerRef`, `providerAmount`, `providerCurrency`, `providerEventId` (`:181-200`),
then the four outbox rows (`RECEIPT_EMAIL` `receipt-${paymentId}`, `OUTBID_EMAIL`
`outbid-${paymentId}`, `PREVIEW_GENERATE` `preview-${payer.id}`, `STAKE_ANALYTICS`
`analytics-${paymentId}`). After commit: `recordEvent APPLIED` (`:267-272`), then a bounded inline
mail drain (`:282`, budget `SETTLE_MAIL_DRAIN_BUDGET_MS`, 10 rows, receipt+outbid only) inside a
try/catch that cannot turn a durable settle into a 5xx (`:279-288`).

## 5. Live evidence

### 5.1 Signature and body handling (P1, P2)

| Delivery | Status | Body |
| --- | --- | --- |
| No `stripe-signature` header | 401 | `{"error":"bad signature"}` |
| `stripe-signature: v1=deadbeef` | 401 | `{"error":"bad signature"}` |
| Valid signature over a body with one byte changed | 401 | `{"error":"bad signature"}` |
| Valid signature, timestamp 6 minutes old | 401 | `{"error":"bad signature"}` |
| Valid signature, fresh timestamp | 200 | per-event |
| Valid signature over `{` (truncated) | 400 | `{"error":"bad json"}` |

Tolerance and scheme live in `lib/stripe.ts` (`verifyWebhook`); the route only reports the outcome.
No delivery in the family produced a `ProviderEvent` row (the upserts are all after verification),
which is the correct behaviour — an unsigned caller cannot write to the audit table.

### 5.2 The ten-delivery state machine (P3) and the register it left (P4)

Deliveries issued in order, each with a fresh event id unless noted; `evt2_1`…`evt2_17` are the event
ids used. Observed `providerEventId | eventType | outcome | detail` rows, verbatim from the dump:

```
stripe:evt2_1|checkout.session.completed|duplicate|already-paid
stripe:evt2_3|checkout.session.completed|duplicate|already-paid
stripe:evt2_4|checkout.session.completed|error|amount-mismatch:9
stripe:evt2_5|checkout.session.completed|error|reference-claimed:cs2_a
stripe:evt2_6|checkout.session.completed|applied|-
stripe:evt2_7|checkout.session.expired|failed|checkout.session.expired
stripe:evt2_8|checkout.session.completed|duplicate|already-failed
stripe:evt2_9|payment_intent.payment_failed|ignored|unrelated-event
stripe:evt2_10|charge.refunded|refunded|type:charge.refunded
stripe:evt2_12|charge.refunded|refunded|already-reversed:type:charge.refunded
stripe:evt2_13|charge.dispute.created|refunded|type:charge.dispute.created
stripe:evt2_14|charge.refunded|refunded|already-reversed:type:charge.refunded
stripe:evt2_15|charge.refunded|refunded|reversed-before-paid:pending:type:charge.refunded
stripe:evt2_16|checkout.session.completed|applied|-
stripe:evt2_17|checkout.session.completed|duplicate|already-paid
```

What each line proves, in the order the code decides it:

- `evt2_6` and `evt2_16` are the two deliveries that applied money; both are `applied` with no
  detail, i.e. `amountUnverified` was false and the provider figure agreed (`lib/money.ts:33-53`).
- `evt2_4` — a signed `checkout.session.completed` whose `amount_total` was 9 for a $7 payment —
  was rejected `amount-mismatch:9` and answered **200**, so Stripe will never redeliver it. The
  record is the only trace.
- `evt2_5` — a reference already held by another payment — `reference-claimed:cs2_a`, 200, terminal.
- `evt2_8` — a paid-type delivery arriving after `checkout.session.expired` had already failed the
  payment — `duplicate / already-failed`, 200. The expiry signal wins over a late completion.
- `evt2_9` — `payment_intent.payment_failed` — `ignored / unrelated-event`. A genuinely failed card
  therefore leaves the payment PENDING (see §5.3 and R08-6).
- `evt2_10` / `evt2_13` — the two reversals that unwound a paid stake; `evt2_12` / `evt2_14` are the
  replays and are refused as `already-reversed` (nothing unwound twice).
- `evt2_15` — a refund arriving for a payment that had never been paid — closed the payment
  `reversed-before-paid:pending:type:charge.refunded`.

### 5.3 The payment ledger as it stands (P4)

```
status | count
pending  | 21
paid     |  6
refunded |  3
failed   |  1
(total 31 rows)
```

The 21 pending rows include 19 that were never sent to a provider (they are the rejection-matrix and
502 probes of doc 06/07) and the two `$9` rows of the 3214 runtime-key probe (doc 07 §5.4) that each
have a real Stripe session attempt behind them and no `providerRef`. Two facts matter for settlement:

- **`PaymentStatus.CANCELED` is written by no code path.** The enum member exists
  (`prisma/schema.prisma:43`, with the comment at `:37` reserving it "for Phase 2 (expired
  reservations)"), but a repo-wide read of every `PaymentStatus.` writer finds only `FAILED`
  (`lib/settle.ts:134`, `lib/applyPayment.ts:27`) and `REFUNDED` (`lib/settle.ts:343`, `:373`). The
  only `cancel` in the application is the Stripe `cancel_url` (`app/api/checkout/route.ts:66`), which
  is a browser redirect — nothing on the server observes it. So an abandoned checkout is
  indistinguishable in the DB from a checkout that was never started, and both are
  indistinguishable from one whose session creation 502'd.
- A PAID row is always applied: `status: PAID`, `paidAt`, `stakeId` and `appliedAt` are written in
  the same `payment.update` (`lib/settle.ts:181-200`), and no other code path writes `paidAt`. There
  is no shape "PAID but not applied" to reconcile for — which is also why the reconcile job (§5.5)
  cannot see the failure mode in §5.9.

### 5.4 The applied-delivery record is not durable (P5)

`recordEvent` is an upsert keyed on the event id with an unconditional update of both mutable fields
(`lib/settle.ts:89-105`):

```
update: { outcome: params.outcome, detail: params.detail ?? null },
```

The webhook route performs the same upsert for the statuses it decides itself
(`app/api/webhooks/stripe/route.ts:163-168`):

```
update: { outcome: "DUPLICATE", detail: `already-${payment.status.toLowerCase()}` },
```

The dump in §5.2 shows the consequence: `stripe:evt2_1` — the delivery that applied $5 on payment
`cmu2dt1yt000db4mwztd3sb7i`, a row that was later REFUNDED by `evt2_10` — now reads
`duplicate|already-paid`, while `evt2_16`, whose payment has not been replayed, still reads
`applied`. Same for `evt2_3`, a second replay of the first event id. Two things are lost:

1. **Which delivery applied the money.** After any later delivery that reaches the terminal-status
   guard with the same event id, the row says the event was a duplicate. The audit trail of the
   application is gone; the only surviving pointer is `Payment.providerEventId` (`:183`, "last
   applied provider event"), which is itself overwritten per apply and NULLed by `onDelete: SetNull`
   (§5.7).
2. **`detail` is wiped when a later caller omits it.** `detail: params.detail ?? null` turns an
   absent detail into an explicit NULL — the `applied` record of `evt2_6` reads `-` (NULL), as does
   `evt2_16`. A repair would have to keep the first detail for an outcome that is already terminal.

Severity is P1 rather than P0 because no money is lost: the ledger itself is intact (§5.3), and
`Payment.providerEventId` still points at the applying event until a later delivery rewrites it. What
is lost is the operator's ability to answer "did this event apply, and was the amount verified?"

### 5.5 Reconcile (P6)

`GET /api/jobs/reconcile` (`app/api/jobs/reconcile/route.ts:46`), authorised by `jobAuth`
(`:48`), reads only PAID rows (`:51-56`) and recomputes each one against the ledger. Baseline on the
converged DB:

```
{"ok":true,"paidTotal":2,"divergent":{"count":0},"unverified":{"count":1,"groups":[{"provider":"DEV","n":1}],"samples":[…]}}
```

After a hand-written ledger divergence (one PAID payment's stake total edited in SQL so the
recomputed pool disagreed with the stored aggregates) the same call answered:

```
HTTP 503 {"ok":false,"paidTotal":2,"divergent":{"count":1,"samples":[…]}}
```

The same endpoint on the production-flagged probe process (doc 07 §5.2) answered
`{"ok":true,"paidTotal":5,"divergent":{"count":0},"unverified":{"count":4,…}}` — four free DEV stakes
counted as amount-unverified, which is exactly what `amount-unverified` is for
(`lib/settle.ts:267-272`). `unverified` is a count, not a failure; only `divergent` sets the 503.

Two limits confirmed by reading the code: it is **PAID-only** (a payment that never reached PAID is
never inspected, `:51-56`) and it is **read-only** (no update statement in the file; the response is
the whole behaviour). `POST` delegates to `GET` on purpose and is deliberately absent from the cron
list — the comment at `:96-100` says so out loud.

### 5.6 The reversal walk (P7)

`charge.refunded` on a PAID $5 payment:

```
before: cmu2dt1yt000db4mwztd3sb7i | paid   | 5 | 5 | usd | stripe:evt2_1
after:  cmu2dt1yt000db4mwztd3sb7i | refunded | 5 | 5 | usd | stripe:evt2_1
audit:  PAYMENT_REVERSED | type:charge.refunded removedUsd=5 remainingUsd=0
```

`charge.dispute.created` on the second PAID row ($6, payment `cmu2dt2kw000lb4mwpz5ypdac`):

```
audit:  PAYMENT_REVERSED | type:charge.dispute.created removedUsd=6 remainingUsd=0
```

Both reversals wrote `REFUNDED` (`lib/settle.ts:343` / `:373`), unwound the stake through
`reverseStakeTx` (`lib/recompute.ts:132`), wrote exactly one audit row (`lib/settle.ts:376`) and
records `RemainingUsd=0` — the element's pool was left with nothing from that stake, i.e. the
denormalized aggregates moved with the stake. Replays were refused (`already-reversed`, §5.2). A
refund for an already-pending payment took the `reversed-before-paid` branch (`:346-353`) and closed
it REFUNDED without touching any stake.

What the walk did **not** produce: any outbound mail. `reversePayment` enqueues nothing — its only
side effects are `reverseStakeTx`, the status update and `audit(...)`. The DB confirms the
asymmetry: `EmailLog` holds completed `receipt` rows for the three paid payments (Mg, Al, S) and no
row of any template for the two reversed ones. The buyer who is charged and then refunded hears
nothing from the app (R08-2).

### 5.7 The event register is not durable against a payment delete (P8)

`ProviderEvent.paymentId` is `onDelete: SetNull` (`prisma/schema.prisma:323-330`). Proved by
deleting the `FAILED` probe payment and re-reading its event:

```
before: dev-cmu2d4i2d001bb4s4cabkiq7c-fail | dev.simulated-failure | failed  | paymentId=cmu2d4i2d001bb4s4cabkiq7c
after:  dev-cmu2d4i2d001bb4s4cabkiq7c-fail | dev.simulated-failure | failed  | paymentId=NULL
```

The row survives with no subject. `ProviderEvent.providerEventId` is the only unique key
(`:326`), and for DEV events it embeds the payment id — which is how the orphan was still findable
here. For STRIPE events the id is the provider's own (`stripe:evt2_*`), so once the payment is gone
the record cannot be tied back to a buyer at all.

### 5.8 The invariant list, as enforceable statements

Each line is a statement the code is supposed to guarantee, with the code that enforces it. These are
the checks to re-run after any change to the money path.

| # | Invariant | Enforced by |
| --- | --- | --- |
| I1 | A stake exists iff a PAID payment backs it | `lib/settle.ts:170-200` — `applyStakeTx` and the PAID/`paidAt`/`stakeId`/`appliedAt` write are one `withTxnRetry` transaction (`lib/settle.ts:142`); `paidAt` has no other writer |
| I2 | A payment applies at most once, even under concurrent delivery | `prisma/schema.prisma:326` (`providerEventId @unique`), the duplicate guard `lib/settle.ts:108-119`, the per-element `pg_advisory_xact_lock` `lib/settle.ts:146`, the PENDING re-read → `lost-settle-race` `lib/settle.ts:258-264` |
| I3 | A provider reference belongs to one payment | `prisma/schema.prisma:182` (`providerRef @unique`) + `reference-claimed:` `app/api/webhooks/stripe/route.ts:148-161` |
| I4 | The provider's money must agree with ours, or be recorded as unverified | `lib/money.ts:33-53`; rejection → `ERROR` + 200 `app/api/webhooks/stripe/route.ts:127-137`; agreement missing → `amount-unverified:provider-stated-none` `lib/settle.ts:267-272` |
| I5 | A payment cannot take an element for less than the element's live hold | `take-below-reserve:${amountUsd}<${reservedTotal}` `lib/settle.ts:156-162`; terminal on redelivery `lib/settle.ts:294-296` |
| I6 | A reversal unwinds the stake before the payment reads REFUNDED | `reverseStakeTx` + REFUNDED + audit in one transaction `lib/settle.ts:357-402`; `ledger-invariant:reverse-no-stake:` `lib/recompute.ts:145`; `ledger-invariant:reverse-below-zero:` `lib/recompute.ts:147` |
| I7 | A stake can never exist without a ranked leader | `ledger-invariant:apply-without-leader` `lib/recompute.ts:212` |
| I8 | The three denormalized aggregates are never half-written | recompute + assert inside the same `MONEY_TX` transaction (`lib/recompute.ts:27-130`, asserts at `:95-97`), retried by `withTxnRetry` `lib/txn.ts:40` with `MONEY_TX` `lib/txn.ts:29` |
| I9 | Reconcile can never change a status | `app/api/jobs/reconcile/route.ts` — read-only file, PAID-only filter `:51-56`, no write statement |
| I10 | A retryable failure is retried, a deterministic one is not | `app/api/webhooks/stripe/route.ts:184-192` (200 for `rejected`) vs `:190-192` (500 for a throw); terminal reasons `lib/settle.ts:294-296`, `:415` |

### 5.9 What happens to a customer whose payment settles while the stake application fails

Walked through the code paths, in order:

1. The card is charged by Stripe and the buyer is redirected to `/?paid=<sym>`
   (`app/api/checkout/route.ts:65`). The money is real from this moment; the webhook has not run yet.
2. The webhook arrives. If `applyStakeTx` throws a retryable error (connection loss, serialization
   failure after `TXN_MAX_ATTEMPTS = 10` retries, `lib/txn.ts:10,40`), `settlePayment` records
   `ERROR` (`lib/settle.ts:291`), the route answers **500** `settle-retryable`
   (`app/api/webhooks/stripe/route.ts:190-192`) and Stripe redelivers. The payment row is still
   PENDING, the stake is still absent, the buyer sees a §-/board unchanged.
3. A redelivery that succeeds applies the stake late — at the price the buyer paid, not the live
   price, because the amount is taken from the payment row. The only user-visible residue is the
   delay.
4. If the delay outlives the element being taken — or if the failure is deterministic
   (`take-below-reserve:` or `ledger-invariant:`, `lib/settle.ts:294-296`, `:415`) — the route
   answers **200** `{ok:false,error}` (`app/api/webhooks/stripe/route.ts:186-189`). Stripe stops
   retrying, having been told the delivery was handled.
5. From then on: the payment stays PENDING with the money captured, no stake exists, no receipt or
   outbid mail is enqueued (they are enqueued inside the settle transaction, which rolled back),
   nothing auto-refunds, and no alert fires. `PaymentStatus` never gets a value that says "captured
   but unapplied"; `CANCELED` is unwritten (§5.3) and `FAILED` means a provider failure, not ours.
6. The only detector is the operator running `/api/jobs/reconcile` — and it is structurally blind to
   this shape: it filters PAID rows (`app/api/jobs/reconcile/route.ts:51-56`). A PAID row always has
   `appliedAt` (I1), so a captured-but-unapplied payment is never in its input set. Nor is it on a
   cron (`vercel.json` schedules `/api/jobs/outbox` and `/api/jobs/screenshot` only), so even the
   divergence case would be discovered by hand.

The honest one-sentence answer: **money can be taken with the stake never applied, and the app has no
automatic anything for that case — no refund, no mail, no status, no scheduled detector; the record
lives in one `ERROR` `ProviderEvent` row that an operator must go looking for.** The customer's
recourse is a support request; the mitigation is a manual Stripe refund plus a manual stake decision.
Batch-1/checklist facts already settled — the queue for provider work, the launch posture — are cited
in §10, not repeated here.

## 6. Failure and edge matrix

| # | Situation | Observed behaviour | Status | Row left behind | Acceptable? |
| --- | --- | --- | --- | --- | --- |
| 1 | Missing/invalid/stale signature | 401 `bad signature`; nothing recorded | 401 | none | Yes |
| 2 | Signed but truncated body | 400 `bad json` | 400 | none | Yes |
| 3 | Signed, well-formed, no payment id | 200 `{ok:true,note:"no paymentId in payload"}` | 200 | `IGNORED / no-paymentId` | Yes — Stripe should not retry |
| 4 | Payment id unknown to us | 200 `{ok:true,note:"unknown payment"}` | 200 | `IGNORED / unknown-payment` | Yes |
| 5 | Amount disagrees with our charge | 200 `{ok:false,error:"amount-mismatch:9"}` | 200 | `ERROR`, detail `amount-mismatch:9` | Terminal by design; **nothing alerts** (R08-3) |
| 6 | Currency not USD | 200 `{ok:false,error:"currency-mismatch:eur"}` | 200 | `ERROR` | as #5 |
| 7 | Payload reference ≠ stored reference | 200 `{ok:false,error:"reference-mismatch:…"}` | 200 | `ERROR` | as #5 |
| 8 | Reference already claimed by another payment | 200 `{ok:false,error:"reference-claimed:cs2_a"}` | 200 | `ERROR` | as #5 |
| 9 | Duplicate delivery, payment PENDING | `duplicate` outcome, no second apply | 200 | reuses the row | Yes (I2) |
| 10 | Duplicate delivery, payment terminal | `already-paid` / `already-failed` / `already-reversed` | 200 | **rewrites the earlier row** (R08-1) | No — audit lost |
| 11 | Paid-type delivery after expiry | `duplicate / already-failed` | 200 | `DUPLICATE` | Yes |
| 12 | Element taken since checkout (`take-below-reserve`) | settle throws, `ERROR` row, **200** `{ok:false}` | 200 | `ERROR`, terminal | No — buyer paid for nothing (§5.9) |
| 13 | Ledger invariant fails | `ERROR` `ledger-invariant:…`, **200** `{ok:false}` | 200 | `ERROR`, terminal | No — same, plus operator work |
| 14 | Transient failure (DB, serialization) | `ERROR` + 500 `settle-retryable` | 500 | `ERROR` (retryable on redelivery) | Yes |
| 15 | Reversal of a PAID payment | stake unwound, REFUNDED, audit | 200 | `REFUNDED` | Yes except: buyer not told (R08-2) |
| 16 | Reversal replay | `already-reversed` | 200 | `DUPLICATE` | Yes |
| 17 | Reversal of a PENDING payment | `reversed-before-paid:pending:…`, REFUNDED | 200 | `REFUNDED` | Yes |
| 18 | Reversal retryable failure | 500 `reverse-retryable` | 500 | `ERROR` | Yes |
| 19 | Failed card (`payment_intent.payment_failed`) | `ignored / unrelated-event`; payment stays PENDING | 200 | `IGNORED` | No — no failure state, buyer sees nothing (R08-6) |
| 20 | Session expired | payment FAILED | 200 | `failed` | Yes |
| 21 | Provider down at checkout | 502 at checkout, payment row already PENDING, no `providerRef` | 502 | `PENDING` forever (doc 06 R06-7, doc 07 R07-4) | No — see R08-5 |
| 22 | Refund for a payment we never marked paid | REFUNDED from PENDING | 200 | `refunded` | Yes |
| 23 | Deleting a payment row | its events survive with `paymentId = NULL` | — | orphan `ProviderEvent` | No (R08-7) |

## 7. Findings

### R08-1 — A replay overwrites the record of the delivery that applied the money

- **Severity.** P1
- **Category.** correctness
- **Evidence.** `lib/settle.ts:89-105` — `recordEvent` upserts on `providerEventId` and updates both
  mutable fields unconditionally: `update: { outcome: params.outcome, detail: params.detail ?? null }`
  (`:100`). `app/api/webhooks/stripe/route.ts:163-168` performs the same upsert with
  `outcome: "DUPLICATE", detail: \`already-${payment.status.toLowerCase()}\``. Observed
  `ProviderEvent` dump (2026-09-15): the event that applied payment
  `cmu2dt1yt000db4mwztd3sb7i` reads `stripe:evt2_1|checkout.session.completed|duplicate|already-paid`,
  and echoed again as `stripe:evt2_3|…|duplicate|already-paid`; the event that applied payment
  `cmu2dt4sa0019b4mwld37g97b`, not since replayed, still reads `stripe:evt2_16|…|applied|-`. The
  applied records for `evt2_6`/`evt2_16` carry `detail = NULL`, i.e. `detail: undefined` was written
  as an explicit NULL by the same expression.
- **Reproduction.** Deliver a signed `checkout.session.completed` for a PENDING payment (row reads
  `applied`), then deliver the same event id again (payment is now PAID → the terminal-status guard
  runs) and read the row: outcome `duplicate`, detail `already-paid`.
- **Proposed fix.** Make the register append-only per delivery: either key events on
  `(providerEventId, attempt)` or guard the update so a terminal outcome is never downgraded
  (`update: { outcome: undefined, detail: undefined }` when the stored outcome is already
  `APPLIED`/`REFUNDED`), and never write `null` for an absent detail — leave the stored detail alone.
  Test: settle then replay; assert the row still reads `applied` and its detail is unchanged.
- **Status.** open

### R08-2 — A reversed payment sends the buyer nothing

- **Severity.** P2
- **Category.** money
- **Evidence.** `lib/settle.ts:317-417` — `reversePayment` writes `reverseStakeTx`, the REFUNDED
  status (`:343`, `:373`) and `audit(PAYMENT_REVERSED)` (`:376`); there is no `enqueueOutbox` call in
  the function, while `settlePayment` enqueues four rows (`lib/settle.ts:203-256`). Observed DB:
  `EmailLog` has a completed `receipt` row for each of the three paid probe payments (Mg $5, Al $6,
  S $9) and **no** row of any template for the two reversed payments
  (`cmu2dt1yt000db4mwztd3sb7i`, `cmu2dt2kw000lb4mwpz5ypdac`); `AuditLog` has
  `PAYMENT_REVERSED | type:charge.refunded removedUsd=5 remainingUsd=0` and
  `| type:charge.dispute.created removedUsd=6 remainingUsd=0`.
- **Reproduction.** Refund a paid probe payment (`charge.refunded`) and query `EmailLog` for the
  buyer address: no row.
- **Proposed fix.** Enqueue a `REFUND_EMAIL` inside the reversal transaction (dedupe
  `refund-${paymentId}`) stating the amount, the provider reference and that the listing is down;
  drain it on the same bounded inline path settle uses. Test: reverse a paid payment, assert one
  queued row and one delivered row, and that a replay enqueues no second mail.
- **Status.** open

### R08-3 — Reconcile is not scheduled and nothing alerts on a terminal rejection

- **Severity.** P2
- **Category.** ops
- **Evidence.** `vercel.json` crons: `/api/jobs/outbox` at `0 4 * * *` and
  `/api/jobs/screenshot` at `30 4 * * *` only. `app/api/jobs/reconcile/route.ts:46` exposes GET; the
  comment at `:96-100` says POST is intentionally not in the cron list. Terminal rejections reach the
  operator only as `ERROR` rows: `app/api/webhooks/stripe/route.ts:127-137` (money), `:139-161`
  (references), `:186-189` (`settle` rejected) — all answered 200, so the provider will not retry and
  cannot page anyone. Observed divergence probe: a hand-written ledger divergence made
  `GET /api/jobs/reconcile` answer `503 {"ok":false,…,"divergent":{"count":1,…}}`; nothing in the
  repo polls that endpoint (no cron, no monitor config, no alerting code).
- **Reproduction.** Break one PAID payment's ledger in SQL, call the endpoint by hand, watch the 503
  never being requested again.
- **Proposed fix.** Add the job to `vercel.json` (it is cheap and read-only) and point an uptime/
  alerting check at the 503 — or have the route emit an operator notification on divergence. Test:
  a divergent DB produces a non-200 that the monitor sees.
- **Status.** open

### R08-4 — The failure-cleanup helper exists and is wired to nothing

- **Severity.** P2
- **Category.** correctness
- **Evidence.** `lib/applyPayment.ts:24-29` — `markFailed(paymentId)` conditionally sets
  `PaymentStatus.FAILED` + `failedAt` for a PENDING payment; `:12-21` `markPaidAndApply` delegates to
  `settlePayment` with a `dev-manual-${paymentId}` event. A repo-wide read finds no importer of
  either symbol outside its own file: the only references are `doc/project-review/files/review-
  findings.md` (three lines) and `doc/review/00-REVIEW-PLAN.md:38,113`, which names it as part of L3.
  The 502 path (`app/api/checkout/route.ts:367`, doc 07 R07-4) leaves the payment PENDING; the 21
  pending rows in §5.3 include those. Related: `lib/idempotency.ts` and `lib/reconcile.ts` **do not
  exist** in this tree although `lib/idempotency.test.ts` and `lib/reconcile.test.ts` do, and the
  plan (§2) names them as sources to inspect.
- **Reproduction.** `Get-ChildItem -Recurse -Include *.ts,*.tsx -Path lib,app | Select-String
  'applyPayment'` → no hits outside `lib/applyPayment.ts`'s doc references; `Get-ChildItem lib -Filter
  'idempot*'` → `idempotency.test.ts` only.
- **Proposed fix.** Decide per symbol: delete `markPaidAndApply` (superseded by the webhook path),
  and call `markFailed` from the checkout failure path so a 502 that never reached the provider
  closes its own row; if a sweep is preferred, add a job that fails PENDING rows with no
  `providerRef` older than the reservation TTL. Then either implement or delete the two test files
  whose modules are missing, and correct the plan's L3/§2 source list. Test: force a checkout 502 and
  assert the row does not remain PENDING.
- **Status.** open

### R08-5 — `PaymentStatus.CANCELED` is unreachable, so abandoned checkouts have no shape

- **Severity.** P3
- **Category.** data
- **Evidence.** `prisma/schema.prisma:37-43`: the enum member exists, with the comment "CANCELED is
  reserved for Phase 2 (expired reservations)". A repo-wide search for writers finds `FAILED`
  (`lib/settle.ts:134`, `lib/applyPayment.ts:27`) and `REFUNDED` (`lib/settle.ts:343`, `:373`) only;
  the sole `cancel` token in the application is the Stripe `cancel_url`
  (`app/api/checkout/route.ts:66`), a browser redirect nothing observes. Observed ledger: 21 PENDING
  rows, of which the two that reached Stripe (`cmu2h636w0005b4tsyg9yui8n`,
  `cmu2hgrnb0009b4tsj1jn0yp0`, both `$9`, both `stripe|pending`, no `providerRef`) will stay PENDING
  until either a webhook or a human arrives; their reservations are already `expired`
  (`lib/reservations.ts:14-17` TTL, status read as `expired`).
- **Reproduction.** Abandon a Stripe checkout (browser back from the session page) and query the row:
  `pending`, unchanged forever; no CANCELED anywhere in the table history.
- **Proposed fix.** Either implement the abandoned-checkout transition the enum was reserved for
  (cancel_url → a server callback, or a sweep: PENDING + no `providerRef` + reservation expired →
  CANCELED) or drop the enum member so the schema stops advertising a state that cannot occur. Test:
  a row that never reached a provider ends in a terminal status within one TTL.
- **Status.** open

### R08-6 — A failed card is not a failure state

- **Severity.** P3
- **Category.** correctness
- **Evidence.** `app/api/webhooks/stripe/route.ts:107-115` — `payment_intent.payment_failed` is
  recorded `IGNORED / unrelated-event` and answered 200. Observed row:
  `stripe:evt2_9|payment_intent.payment_failed|ignored|unrelated-event|cmu2dt4am0011b4mwzxuvncfj`,
  and that payment was still PENDING at that point (it was closed later only because a refund was
  delivered: `stripe:evt2_15|charge.refunded|refunded|reversed-before-paid:pending:…`). By contrast
  `checkout.session.expired` and `async_payment_failed` **do** fail the payment
  (`route.ts:117-123`, observed `evt2_7|checkout.session.expired|failed`). So a card declined at the
  payment-intent stage leaves the row PENDING and the buyer with no failure state in the app.
- **Reproduction.** Deliver a signed `payment_intent.payment_failed` for a PENDING payment whose
  marker is the payment id; the row's `<Payment>.status` stays `pending`.
- **Proposed fix.** Classify `payment_intent.payment_failed` as a failure when the payload carries a
  payment id we recognise (and keep `unrelated-event` for the rest), so the row terminates like the
  expired-session case; surface the failed state on `/pay/{id}`. Test: failed intent → payment
  FAILED, no stake, one `FAILED` event row.
- **Status.** open

### R08-7 — Deleting a payment orphans its provider-event history

- **Severity.** P3
- **Category.** data
- **Evidence.** `prisma/schema.prisma:323-330` — `ProviderEvent.paymentId` is
  `onDelete: SetNull`. Proved live: deleting `Payment cmu2d4i2d001bb4s4cabkiq7c` left
  `dev-cmu2d4i2d001bb4s4cabkiq7c-fail|dev.simulated-failure|failed` in place with `paymentId` now
  NULL. For DEV events the id embeds the payment id; for STRIPE events the id is the provider's
  (`stripe:evt2_*`), so the row becomes unattributable to any buyer or element.
- **Reproduction.** `DELETE FROM "Payment" WHERE id='…'` then select the event by
  `providerEventId`: `paymentId` is NULL, outcome unchanged.
- **Proposed fix.** Either `onDelete: Restrict` (a payment with any recorded delivery cannot be
  deleted) or copy `elementId`/`startupId` onto `ProviderEvent` so the record keeps a subject after
  the payment is gone. Test: attempted delete with events present is refused (or the event still
  names its element).
- **Status.** open

## 8. Acceptance criteria

- [ ] I1–I10 in §5.8 each still hold after any change to `lib/settle.ts`, `lib/recompute.ts`,
      `lib/money.ts` or the webhook route; each row names the enforcing line so the check is a read,
      not a re-derivation.
- [ ] A replayed delivery never changes the outcome recorded for the delivery that applied money
      (R08-1), because that row is the only record of which delivery applied it.
- [ ] A deterministic rejection (`take-below-reserve:`, `ledger-invariant:`, money/reference
      mismatch) reaches a human: the operator is paged or the job that finds it runs on a schedule
      (R08-3), because the buyer's money is already captured by then (§5.9).
- [ ] The reconcile job is reachable without hand-typing a secret (cron or monitor) and its 503 is
      what alerts.
- [ ] Every terminal `Payment` shape an operator can encounter has a stated action — PENDING with no
      `providerRef`, PENDING with one, FAILED, REFUNDED, CANCELED — and the table in §5.3 can be read
      against it (R08-4, R08-5).
- [ ] A buyer whose payment reverses is told, in mail, in the same transaction that reverses it
      (R08-2).
- [ ] No source list in `doc/review/00-REVIEW-PLAN.md` names a module that does not exist
      (`lib/idempotency.ts`, `lib/reconcile.ts`), and no module that exists but is wired to nothing
      is left undocumented (R08-4).

## 9. Open questions

**Q1 — Is `amount-unverified` an acceptable steady state?** Four free DEV stakes were counted as
unverified on the production-flagged probe process (doc 07 §5.2), and the reconcile response
currently reports them as a plain count. If the Stripe path can ever settle without a provider
figure (the `absent` branch, `lib/money.ts:44-53` → `lib/settle.ts:270-271`), an operator needs a
rule for how many unverified rows are tolerable. Only the operator can set that threshold.

**Q2 — Which terminal rejection must be a refund?** `take-below-reserve:` means the buyer paid for an
element someone else took first. The code's answer is "record it and move on" (§5.9). Refunding
automatically, refunding by hand, or applying the stake anyway are all defensible and mutually
exclusive; the choice is the operator's, and the current behaviour is the third one's opposite.

**Q3 — Should the 200-for-terminal-rejection answer stay?** It is deliberate (a redelivery can never
succeed) and it is also why the operator never hears about it. If R08-3's alerting lands, 200 stays
correct; without it, a 5xx would at least make Stripe retry for days.

## 10. Cross-references

- 06 §5 / §7 — the synchronous half of the same flow: what the buyer sees before any of this runs,
  including the 502 that leaves a PENDING row (R06-7) and the unreachable `?canceled=` surface
  (R06-8).
- 07 §5.2 / §5.4 — provider posture that decides whether this route is ever reached with real money
  (R07-1, R07-2, R07-4), and the rotation procedures that keep the webhook secret fresh.
- 09 — what happens to ranks and holders when a reversal unwinds a stake (the displaced-holder and
  reclaim rules).
- 10 — the mail enqueued inside the settle transaction (receipt, outbid) and its suppression rules;
  R08-2's missing reversal mail is registered there too.
- `doc/PROD-READINESS-CHECKLIST.md` §5 — provider configuration and the launch posture; cited, not
  re-derived.
- Batch-1 05 §7 R05-8 — the `/pay/[paymentId]` provider-mode gate, which decides whether a buyer ever
  reaches Stripe at all.

## 11. Change log

- authored 2026-09-15 against `9681bdcbff2435ef258224c52000e0f8d6089f5c`
- first pass: no fix verification section (that is a later pass, per the review plan §4)

## 12. UNKNOWN log

| Id | Phase | Category | Unknown | What settles it |
| --- | --- | --- | --- | --- |
| U08-1 | 08 | ops | Whether a real Stripe endpoint retries the 500s this route returns, for how long, and whether the dashboard's endpoint view shows the failures an operator would need to see | A Stripe dashboard reading of the endpoint's delivery attempts after one forced `settle-retryable` 500, or `stripe events resend` against a registered endpoint |
| U08-2 | 08 | correctness | Whether real Stripe payloads for `charge.refunded` / `charge.dispute.created` carry a *partial* amount, and whether this route would treat a partial refund as a full unwind (`lib/settle.ts:317-417` has no partial path) | A live refund for less than the captured amount, or Stripe CLI `stripe trigger charge.refunded` with an edited amount, then a read of the resulting stake totals |
| U08-3 | 08 | robustness | Whether `MONEY_TX` behaves as designed when the database connection drops mid-transaction on the deployed provider (Neon), i.e. whether the buyer's delivery is retried or the reservation is left decayed | A managed-Postgres failover during a settle probe, or a connection-kill test against the production-shaped database |
| U08-4 | 08 | data | How many `ProviderEvent` rows in production are `ERROR` today, and which reasons dominate | A production DB read of `ProviderEvent` grouped by outcome/detail — needs credentials no review session holds |
