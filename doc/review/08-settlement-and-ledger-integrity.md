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
and `prisma/migrations/` — this list is the reviewed commit's, and `lib/applyPayment.ts` was
deleted by the fix pass (§5.10) — plus live probes on 2026-09-15 against a scratch Postgres
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
  (`lib/settle.ts:134`, `lib/applyPayment.ts:27`, the latter's file since deleted — §5.10) and
  `REFUNDED` (`lib/settle.ts:343`, `:373`). The only `cancel` in the application is the Stripe
  `cancel_url` (`app/api/checkout/route.ts:66`), which is a browser redirect — nothing on the server
  observes it. So an abandoned checkout is
  indistinguishable in the DB from a checkout that was never started, and both are
  indistinguishable from one whose session creation 502'd.
  *Post-fix (§5.10): CANCELED now has a writer — the 24 h sweep in `lib/abandonedCheckouts.ts`,
  reached from `app/api/jobs/abandoned-checkouts` — so the three shapes this bullet says are
  indistinguishable have distinct rows after the TTL. The `FAILED` writer it names is still
  `lib/settle.ts:134` and nothing else: the sweep writes CANCELED, deliberately, because "never
  paid" is not "payment failed".*
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
the checks to re-run after any change to the money path. Line numbers are as of the §5.10 fix pass;
the fix pass changed the enforcing lines for I1, I2, I4, I5, I6, I10 and the citations were re-read
rather than carried over — the invariants themselves are unchanged.

| # | Invariant | Enforced by |
| --- | --- | --- |
| I1 | A stake exists iff a PAID payment backs it | `lib/settle.ts:219-280` — `applyStakeTx` (`:245`) and the PAID/`paidAt`/`stakeId`/`appliedAt` write (`:272-274`) are one `withTxnRetry` transaction (`:219`); `paidAt` has no other writer in `lib`/`app` |
| I2 | A payment applies at most once, even under concurrent delivery | `prisma/schema.prisma:326` (`providerEventId @unique`), the duplicate guard `lib/settle.ts:203-205`, the per-element `pg_advisory_xact_lock` `lib/settle.ts:223`, the PENDING re-read → `lost-settle-race` `lib/settle.ts:226`, `:340` |
| I3 | A provider reference belongs to one payment | `prisma/schema.prisma:182` (`providerRef @unique`) + `reference-claimed:` `app/api/webhooks/stripe/route.ts:176-192` |
| I4 | The provider's money must agree with ours, or be recorded as unverified | `lib/money.ts:33-53`; rejection → `ERROR` + 200 `app/api/webhooks/stripe/route.ts:148-161`; agreement missing → `amount-unverified:provider-stated-none` `lib/settle.ts:348` |
| I5 | A payment cannot take an element for less than the element's live hold | `take-below-reserve:${amountUsd}<${reservedTotal}` `lib/settle.ts:239`; terminal on redelivery `lib/settle.ts:371-373` |
| I6 | A reversal unwinds the stake before the payment reads REFUNDED | `reverseStakeTx` (`:447`) + REFUNDED (`:452-455`) + audit (`:457-466`) in one `withTxnRetry` transaction (`:438`); `ledger-invariant:reverse-no-stake:` `lib/recompute.ts:145`; `ledger-invariant:reverse-below-zero:` `lib/recompute.ts:147` |
| I7 | A stake can never exist without a ranked leader | `ledger-invariant:apply-without-leader` `lib/recompute.ts:212` |
| I8 | The three denormalized aggregates are never half-written | recompute + assert inside the same `MONEY_TX` transaction (`lib/recompute.ts:27-130`, assert at `:97`), retried by `withTxnRetry` `lib/txn.ts:40` with `MONEY_TX` `lib/txn.ts:29` |
| I9 | Reconcile can never change a status | `app/api/jobs/reconcile/route.ts` — read-only file, PAID-only filter `:83`, no write statement |
| I10 | A retryable failure is retried, a deterministic one is not | `app/api/webhooks/stripe/route.ts:222-228` (200 for `rejected`, 500 for a throw); terminal reasons `lib/settle.ts:371-373`, `:534-537` |

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

### 5.10 Fix verification

2026-09-15, this worktree, after the §11 fix pass. Unlike doc 07's pass, this one ran against a real
Postgres: a `postgres:16-alpine` container (`ptl-fix08-pg`, under colima) published on port `55433` —
the port `.github/workflows/ci.yml` uses — with every migration applied by `npx prisma migrate
deploy`. The DB-gated suites this doc's evidence came from therefore executed instead of skipping.
Two limits stand exactly where doc 07 stated them: there is no Stripe account reachable from here, so
nothing below is a real delivery *from* Stripe — each one is a signed request built locally and sent
through the real route handler, or a real row in the real schema.

```
TEST_DATABASE_URL=… npm run test:ci → 45 files passed (45); 647 passed, 0 failed, 0 skipped (647)
npx vitest run (no database)        → 39 passed, 6 skipped (45); 565 passed, 82 skipped (647)
npx tsc --noEmit                    → clean
npx eslint lib app                  → clean
```

The first line is the CI-shaped run, and it satisfies CI's own gate (`.github/workflows/ci.yml` fails
the build when the log contains a skipped test; the grep against it finds nothing). The second is the
shape §5.1-§5.9 were written from, and it is the honest bound on what a checkout with no database
proves: 6 files and 82 tests skip there — every DB suite, including the two this pass added. The pass
added 35 tests: `lib/phase8.test.ts` (24, pure), `lib/abandonedCheckouts.test.ts` (7, DB — new here),
and four in `lib/reconcile.test.ts` (DB).

- **R08-1 — the register is append-only per delivery.** `providerEventUpdate()` (`lib/settle.ts:93`)
  is now the one expression that decides what a register row may become, and `recordProviderEvent()`
  (`:114`) is the one writer — the route's seven call sites
  (`app/api/webhooks/stripe/route.ts:59,75,126,150,165,182,195`), `recordEvent()` (`lib/settle.ts:176`)
  and both settle functions all pass through it, so the precedence rule cannot be applied
  inconsistently. The rule: a row whose stored outcome is anything but `ERROR` is terminal, the patch
  comes back `null`, and `recordProviderEvent` returns **before** the upsert — a replay of the
  delivery that applied the money is not a write at all, not even a `duplicate` row. An `ERROR` row
  stays replaceable, which is matrix row 14's retryable case, and `detail` is only overwritten when
  the new delivery states one, so `detail: undefined` can no longer land as an explicit `NULL`: the
  `applied | -` shape §5.4 read on `evt2_16`'s row cannot recur. `lib/phase8.test.ts` carries the
  outcome-pair table ("refuses the replay that used to erase the money-moving row",
  "lets a later attempt replace a failed one", "never erases the explanation of a failed attempt") and
  a static assertion that the app has exactly one `ProviderEvent` upsert; `lib/reconcile.test.ts`
  drives the DB half.
- **R08-2 — the reversal tells the buyer.** `reversePayment` now enqueues `REFUND_EMAIL`
  (`lib/settle.ts:478-479`, `dedupeKey: refund-${paymentId}`) inside the same `MONEY_TX` transaction
  that unwinds the stake and writes REFUNDED (`:501`), resolves the recipient the way settle does
  (`locked.email ?? startup.email`), and drains on the same bounded inline path
  (`:521-525`, `SETTLE_MAIL_DRAIN_BUDGET_MS`). The template is `emails/refund.tsx` behind
  `sendRefundEmail()` (`lib/email.ts:157`, `template: "refund"` at `:170`), wired into the outbox as
  its own type (`lib/outbox.ts:112-113`) — a receipt for money going back would document a purchase
  that no longer stands. `lib/phase8.test.ts` asserts the reversal transaction contains the enqueue,
  that no `RECEIPT_EMAIL` was added to it, that the template quotes the provider reference only when
  there is one, and that the buyer's own domain is escaped (`emails/refund.tsx`).
- **R08-3 — the endpoint was already polled; what was missing was the answer.**
  *Evidence correction to §7 R08-3.* The finding says "nothing in the repo polls that endpoint". That
  was read from `vercel.json` alone and it is wrong: `.github/workflows/outbox-tick.yml` (committed
  `7ce73a9`, before this doc was authored) has polled `GET /api/jobs/reconcile` every ten minutes with
  `exit 1` on a non-200 since then. The missing halves were the route's answer for the shape §5.9
  describes and the workflow's own reading of it. Server side: `unapplied` (ERROR deliveries with no
  later success covering them, `app/api/jobs/reconcile/route.ts:131-143`), `stale` (advisory PENDING
  rows older than the provider session, `:144-154`), `failing = divergent || unapplied` (`:156`) →
  **503** (`:188`). Client side: the reconcile step runs before the config step only when not
  cancelled, saves the body, and fails the run with an `::error::` line naming both counts
  (`.github/workflows/outbox-tick.yml:83-104`) — a 200 carrying `divergent: 1` used to be a green run.
  *Not taken:* the finding's other arm, putting the job in `vercel.json`. Hobby allows two cron slots
  and both hold the daily mail jobs (`app/api/jobs/reconcile/route.ts:194`); a ten-minute tick is also
  better latency than a daily one. The four DB tests assert the grace window ("does not page on a
  rejected delivery that may still be retrying"), the live rejection ("fails ok on a rejected capture
  that was never applied"), the superseded-vs-live distinction on a PAID row, and that `stale` is
  advisory rather than failing.
- **R08-4 and R08-5 — the helper's two jobs, one deleted and one given a clock.**
  `lib/applyPayment.ts` is deleted, not deprecated: `markPaidAndApply` was a second route into
  `settlePayment` with no importers, and calling `markFailed` from the checkout failure path would
  close a row whose session is still payable at Stripe. The 502 path therefore still leaves the row
  PENDING on purpose — `resumeCheckoutUrl` makes it retryable, which is the behaviour doc 06 R06-7
  asked for — and R08-5's sweep is what closes it. `lib/abandonedCheckouts.ts` implements the
  transition `PaymentStatus.CANCELED` was reserved for: PENDING **and** no `providerCheckoutUrl`
  **and** no `providerRef` **and** older than `CHECKOUT_ABANDON_TTL_MS` (`:29`, 24 h) —
  `isAbandonable` `:34`, `abandonCutoff` `:48` — swept oldest-first (`:78`) in batches of
  `ABANDON_MAX_BATCH = 50` (`:31`), each row closed by a conditional `updateMany` that re-checks the
  status so a concurrent settle wins the race (`:91`), audited as `CHECKOUT_ABANDONED`
  (`:98`, `lib/audit.ts:27`) only when a row actually changed. It is reachable as an authenticated
  job (`app/api/jobs/abandoned-checkouts/route.ts:20,27`, `jobAuth`) and is called from the same
  ten-minute workflow tick (`.github/workflows/outbox-tick.yml:71`). `lib/abandonedCheckouts.test.ts`
  is the DB suite (7 tests): a 30-hour-old PENDING row is cancelled and audited; a row with a session
  URL, a row with a `providerRef`, a young row and a non-PENDING row are all left alone; the sweep is
  bounded and oldest-first and a replay cancels nothing; the reservation is left for its own TTL; and
  the same sweep works through the route. *Deliberately not taken:* cancelling reservations, failing
  the row instead of cancelling it, and sweeping rows that have a session URL (those are R08-3's
  `stale` list, because a session that exists may still be paid).
- **R08-6 — a declined attempt is recorded as declined.** `stripePayloadIsDeclined()`
  (`lib/stripe.ts:426`, `DECLINED_EVENT_TYPES` at `:424`) is applied in the webhook's `IGNORED` branch,
  so a declined card attempt reaches the register as `declined-attempt` instead of the generic
  `unrelated-event` (`app/api/webhooks/stripe/route.ts:126-133`) and the buyer's payment row is
  untouched. *Not taken:* the finding's other half — terminating the payment row on
  `payment_intent.payment_failed`. The event is not subscribed, and a declined *attempt* does not mean
  the session is dead: Stripe lets the buyer retry the card, so failing the row would close a checkout
  that can still be completed. The register now distinguishes "the buyer was refused" from "we do not
  know why this arrived" without asserting the second. §9 Q4 is where the terminal-state decision sits.
- **R08-7 — the delivery keeps its subject.** `ProviderEvent` carries `elementId`/`startupId`
  (`prisma/schema.prisma:336-337`), plain columns with no relation and no FK, so they survive any
  element or startup edit; `recordProviderEvent` resolves them from the payment at write time so no
  call site can forget (`lib/settle.ts:121-127`). Migration
  `prisma/migrations/0007_provider_event_attribution/migration.sql` adds them with a backfill in
  0003's shape (`:15-19`) and the index the reconcile report needs (`:23`,
  `@@index([outcome, createdAt])` at `prisma/schema.prisma:345`). The reproduction was re-run against
  the migration, on a scratch database holding migrations 0000-0006, a payment and a delivery row:

  ```
  before 0007:  mig-evt-8 | applied | paymentId=mig-p
  after  0007:  mig-evt-8 | applied | paymentId=mig-p | elementId=1 | startupId=mig-s
  after DELETE FROM "Payment" WHERE id='mig-p':
                mig-evt-8 | applied | paymentId=NULL | elementId=1 | startupId=mig-s
  ```

  §5.7's orphan is now attributable to its element and startup; rows whose payment was *already*
  deleted before the migration stay NULL, which is why the columns are also written at write time.
  *Not taken:* `onDelete: Restrict` — a payment with any recorded delivery would become undeletable,
  and demo cleanup is a real workflow in this repo.
- **The plan's source list (R08-4's tail).** `doc/review/00-REVIEW-PLAN.md` L3 (`:38`) and §2 (`:112-113`)
  named `lib/applyPayment.ts` (now deleted) alongside `lib/idempotency.ts` and `lib/reconcile.ts`,
  neither of which exists — `lib/idempotency.test.ts` and `lib/reconcile.test.ts` do, and both import
  only modules that are present (`./stripe`, `./rateLimit`, `./validate` and
  `../app/api/jobs/reconcile/route`, `./settle`). Both lists are corrected to name what the tree has;
  the two test files are left in place, because they are the coverage of the idempotency and reconcile
  contracts, not of a missing module.

**Still not measured.** No live Stripe delivery, so U08-1 (does Stripe retry this route's 500s, and for
how long) and U08-2 (does a real partial `charge.refunded` land as a full unwind) stand unchanged. No
managed-Postgres failover: U08-3 stands. No production read of `ProviderEvent`: U08-4 stands. And the
trade-offs this pass chose rather than proved are listed with their findings above: the row a 502
leaves is closed by a sweep and not by `markFailed`, the declined event keeps its session alive, the
sweep is reachable only from the ten-minute workflow tick or a hand-made request, and the register's
attribution is copied rather than joined, which is what makes it survive and what makes it stale if an
element is ever re-pointed.

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

**After the fix pass** (§5.10), the rows whose behaviour or visibility changed:

| # | Situation | Current behaviour | What the buyer sees | What the operator sees |
| --- | --- | --- | --- | --- |
| 5–8 | Deterministic rejection (amount, currency, reference, claimed) | unchanged: 200, terminal `ERROR` row | unchanged — the money is captured, so this is the operator's problem, not a retryable error | the count in `unapplied` fails `/api/jobs/reconcile` (503), and the ten-minute tick reds with both counts in the message — the "nothing alerts" cell is the one this pass fixed |
| 10 | Duplicate delivery, payment terminal | the earlier row is **not** rewritten; the later delivery is not recorded at all (single writer, terminal row refuses the patch) | unchanged | the register keeps the outcome of the delivery that applied the money, and with it the attribution and the payload that explain it |
| 12–13 | `take-below-reserve` / ledger invariant | unchanged: 200, terminal `ERROR` row, money captured | unchanged | same 503/red-run path as #5–8, so the window is ten minutes instead of "whenever someone reads the table" |
| 15 | Reversal of a PAID payment | refund mail enqueued **inside** the reversal transaction, drained inline | a refund notice naming the amount and the provider reference | one `REFUND_EMAIL` row; a replay adds no second |
| 19 | Failed card (`payment_intent.payment_failed`) | still `IGNORED / unrelated-event`, payment still PENDING and still payable | nothing new — deliberately, the card can be retried | the register row now carries detail `declined-attempt`, so a declined card is distinguishable from an unclassifiable delivery |
| 21 | Provider down at checkout | the PENDING row is closed by the sweep once it is 24 h old (`CHECKOUT_ABANDONED` audit, CANCELED) | `resumeCheckoutUrl` works until then; after it, the listing is gone and a new checkout starts clean | one audit row per closure, at most 50 per run |
| 23 | Deleting a payment row | the orphan `ProviderEvent` now names its element and startup directly | unchanged | an orphan row is still readable — `elementId`/`startupId` are copied at ingest, and migration 0007 backfills the rows whose payment still exists |

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
- **Fix.** The register is append-only per delivery. `providerEventUpdate()` (`lib/settle.ts:93`)
  decides what a row may become — `null` as soon as the stored outcome is anything but `ERROR` — and
  `recordProviderEvent()` (`:114`) is the only writer of a `ProviderEvent` row: the route's seven call
  sites, `recordEvent()` (`:176`) and both settle functions all pass through it, so the webhook's own
  terminal-status upsert (`app/api/webhooks/stripe/route.ts:195`) cannot downgrade a row the settle
  path wrote. `recordProviderEvent` returns *before* the upsert when the patch is `null`, so a replay
  of the delivery that applied the money performs no write at all — not even a `duplicate`. The
  anomaly §5.4 read (`applied|-`, i.e. `detail: undefined` landing as an explicit NULL) is now
  structurally impossible: detail is replaced only when the incoming delivery states one. An `ERROR`
  row stays replaceable, which matrix row 14 needs. Verified in §5.10 — `lib/phase8.test.ts` holds the
  outcome-pair table and the "exactly one upsert on ProviderEvent" assertion, `lib/reconcile.test.ts`
  drives a real settle then replay. *Consequence, deliberate:* the register answers "what did this
  delivery do", so a later delivery for an event id that already applied is not recorded at all; the
  operator's delivery counts live in Stripe's dashboard, and §5.4's `duplicate|already-paid` row was
  the defect, not the feature.
- **Status.** fixed

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
- **Fix.** `reversePayment` enqueues `REFUND_EMAIL` inside the same `MONEY_TX` transaction that unwinds
  the stake and writes REFUNDED (`lib/settle.ts:478-479`, `dedupeKey: refund-${paymentId}`; the
  transaction marker is `:501`), so the mail is durable exactly when the reversal is and a replay
  enqueues no second row. The recipient is resolved the way settle resolves it
  (`locked.email ?? startup.email`), and the payload carries the amount, the element, the buyer's
  domain, the unsubscribe token and `providerRef` — the reference a buyer quotes to their bank. The
  template is `emails/refund.tsx` behind `sendRefundEmail()` (`lib/email.ts:157`, `template: "refund"`
  at `:170`), wired as its own outbox type (`lib/outbox.ts:112-113`), and the reversal drains its mail
  on the same bounded inline path settle uses (`lib/settle.ts:521-525`,
  `SETTLE_MAIL_DRAIN_BUDGET_MS`). No `RECEIPT_EMAIL` and no `OUTBID_EMAIL` were added: nobody won
  anything, and a receipt would document a purchase that no longer stands. Verification is §5.10; the
  pure suite pins the enqueue's position inside the transaction, the template's two conditional
  sentences, the escaping of the buyer's own domain, and the absence of a receipt.
- **Status.** fixed

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
- **Fix.** The premise is corrected before the fix, because it was wrong: `.github/workflows/outbox-tick.yml`
  has polled `GET /api/jobs/reconcile` every ten minutes with `exit 1` on a non-200 since commit
  `7ce73a9` — before this doc was authored — so the endpoint was never unpolled and the 2026-09-15
  evidence behind this finding came from reading `vercel.json` and nothing else. What was genuinely
  missing is now in place on both sides. Route: `unapplied` (an `ERROR` delivery with no later success
  covering the same payment, `app/api/jobs/reconcile/route.ts:131-143`), the advisory `stale` block
  (`:144-154`) for PENDING rows older than their provider session, and `failing = divergent || unapplied`
  → **503** (`:156`, `:188`) — so §5.9's captured-but-unapplied shape is no longer invisible to a
  report whose input set was PAID rows only. Workflow: the reconcile step keeps
  `if: ${{ !cancelled() }}`, saves its body, and fails the run with an `::error::` line naming both
  counts (`.github/workflows/outbox-tick.yml:83-104`); before this, a 200 carrying
  `{"divergent":{"count":1}}` was a green run, which is the alerting half of the finding. *Not taken:*
  the finding's `vercel.json` arm — the Hobby plan allows two cron slots and both hold the daily mail
  jobs (`app/api/jobs/reconcile/route.ts:194`), and a ten-minute tick beats a third cron's latency
  anyway. §5.10 carries the four DB tests and the step-body harness that proves a failing body exits
  non-zero.
- **Status.** fixed

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
  *Post-fix reading of this evidence (§5.10): `lib/applyPayment.ts` no longer exists in the tree, so
  the `:24-29` and `:12-21` citations above are readable at the reviewed commit only
  (`git show 9681bdc:lib/applyPayment.ts`). The `lib/idempotency.ts` / `lib/reconcile.ts` half needs
  no such note — those files never existed, which is the point of that sentence.*
- **Reproduction.** `Get-ChildItem -Recurse -Include *.ts,*.tsx -Path lib,app | Select-String
  'applyPayment'` → no hits outside `lib/applyPayment.ts`'s doc references; `Get-ChildItem lib -Filter
  'idempot*'` → `idempotency.test.ts` only.
- **Proposed fix.** Decide per symbol: delete `markPaidAndApply` (superseded by the webhook path),
  and call `markFailed` from the checkout failure path so a 502 that never reached the provider
  closes its own row; if a sweep is preferred, add a job that fails PENDING rows with no
  `providerRef` older than the reservation TTL. Then either implement or delete the two test files
  whose modules are missing, and correct the plan's L3/§2 source list. Test: force a checkout 502 and
  assert the row does not remain PENDING.
- **Fix.** Decided per symbol, as proposed. `lib/applyPayment.ts` is **deleted**: `markPaidAndApply` was
  a second route into `settlePayment` with no importer outside its own file, and the webhook path is
  the one that has to be authoritative. `markFailed`'s call site is deliberately **not** taken — the
  502 path leaves its row PENDING because that row's Stripe session can still be paid, so failing it on
  the checkout's own error would close a checkout the buyer can still finish (`resumeCheckoutUrl` is
  the retry surface doc 06 R06-7 asked for). The "if a sweep is preferred" arm is the one that landed,
  and it is R08-5: `lib/abandonedCheckouts.ts` plus `app/api/jobs/abandoned-checkouts` close a PENDING
  row that never reached a provider once it is 24 h old. The tail of the finding is fixed as a
  correction rather than as code — `doc/review/00-REVIEW-PLAN.md` L3 (`:38`) and §2 (`:112-113`) no
  longer name `lib/applyPayment.ts` (deleted) or `lib/idempotency.ts`/`lib/reconcile.ts` (never
  existed); `lib/idempotency.test.ts` and `lib/reconcile.test.ts` are kept, because they import only
  modules that do exist and they are the coverage of the idempotency and reconcile contracts. §5.10
  has the verification: seven DB tests for the sweep, and no importer of the deleted symbols anywhere
  in `lib`/`app`.
- **Status.** fixed

### R08-5 — `PaymentStatus.CANCELED` is unreachable, so abandoned checkouts have no shape

- **Severity.** P3
- **Category.** data
- **Evidence.** `prisma/schema.prisma:37-43`: the enum member exists, with the comment "CANCELED is
  reserved for Phase 2 (expired reservations)". A repo-wide search for writers finds `FAILED`
  (`lib/settle.ts:134`, `lib/applyPayment.ts:27` — that file since deleted, §5.10) and `REFUNDED`
  (`lib/settle.ts:343`, `:373`) only; the sole `cancel` token in the application is the Stripe
  `cancel_url` (`app/api/checkout/route.ts:66`), a browser redirect nothing observes. Observed ledger: 21 PENDING
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
- **Fix.** The transition the enum was reserved for is implemented rather than the enum dropped.
  `lib/abandonedCheckouts.ts`: `isAbandonable()` (`:34`) requires PENDING, no `providerCheckoutUrl`,
  no `providerRef`, and a `createdAt` strictly older than `abandonCutoff()` (`:48`;
  `CHECKOUT_ABANDON_TTL_MS` at `:29` is 24 h, aligned with the reservation TTL);
  `sweepAbandonedCheckouts()` (`:61`) reads oldest-first (`:78`) in batches capped at
  `ABANDON_MAX_BATCH = 50` (`:31`), closes each row with a conditional `updateMany` that re-checks the
  status so a settle racing the sweep wins (`:91`), writes `failedAt` as the cancel timestamp (there is
  no `canceledAt` column) and audits `CHECKOUT_ABANDONED` (`:98`, `lib/audit.ts:27`) only when a row
  actually changed. The job surface is `app/api/jobs/abandoned-checkouts` (POST and GET, `jobAuth`,
  `:20-36`) and the ten-minute workflow tick calls it (`.github/workflows/outbox-tick.yml:71`).
  *Not taken:* the `cancel_url` server callback (a browser redirect nothing observes), failing the row
  instead of cancelling it, and cancelling reservations — they expire on their own TTL by design. Rows
  that carry a session URL are never swept; they are R08-3's `stale` advisory list, because a session
  that exists may still be paid. §5.10 has the seven DB tests, including the replay that cancels
  nothing.
- **Status.** fixed

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
- **Fix.** The register now says what it knows. `stripePayloadIsDeclined()` (`lib/stripe.ts:426`,
  `DECLINED_EVENT_TYPES` at `:424`) routes a `payment_intent.payment_failed` delivery to a
  `declined-attempt` detail in the webhook's `IGNORED` branch
  (`app/api/webhooks/stripe/route.ts:126-133`), so an operator reading `ProviderEvent` can tell a
  refused card from a delivery the app could not classify — with the payment row, deliberately,
  untouched. *Not taken: the rest of the proposed fix.* Terminating the payment on this event would be
  wrong on the provider's own terms: the intent is not the session, Stripe lets the buyer retry the
  card while the session is open, and failing the row would close a checkout that can still be paid.
  The event is also not subscribed, so the classification is defensive. A terminal state for a buyer
  whose card failed is therefore still missing, and it is §9 Q4 rather than a silent choice.
  Verification in §5.10: the classifier, the "not a failure, not a payment, not a reversal" case, and
  the delivery reaching the register with the row unchanged.
- **Status.** fixed

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
- **Fix.** Attribution is copied, not joined. `ProviderEvent.elementId`/`startupId`
  (`prisma/schema.prisma:336-337`) are plain nullable columns with **no** relation and no foreign key,
  so an element or startup edit can neither restrict nor null them; `recordProviderEvent` resolves both
  from the payment at write time (`lib/settle.ts:121-127`, so no call site can forget them), and the
  webhook's two pre-payment deliveries keep writing `paymentId: null` explicitly
  (`app/api/webhooks/stripe/route.ts:63,79`). Migration
  `prisma/migrations/0007_provider_event_attribution/migration.sql` adds the columns, backfills rows
  that still have a payment (`:15-19`, the shape 0003 used) and adds
  `ProviderEvent_outcome_createdAt_idx` for R08-3's scan (`:23`,
  `@@index([outcome, createdAt])` at `prisma/schema.prisma:345`). Proven re-runnably in §5.10: a row
  written before the migration gains `elementId=1 | startupId=mig-s`, and deleting its payment leaves
  both in place with `paymentId` NULL, so §5.7's orphan is attributable. *Not taken:*
  `onDelete: Restrict`, which would make a payment with any recorded delivery undeletable and break
  demo cleanup. Rows whose payment was deleted *before* the migration stay NULL — that is exactly why
  the columns are also written at ingest.
- **Status.** fixed

## 8. Acceptance criteria

Ticked boxes are verified by §5 as re-read on 2026-09-15 and by the fix pass's own run in §5.10 (the
DB half of which ran against a real Postgres, unlike doc 07's). Every box below was unticked in the
first pass.

- [x] I1–I10 in §5.8 each still hold after any change to `lib/settle.ts`, `lib/recompute.ts`,
      `lib/money.ts` or the webhook route; each row names the enforcing line so the check is a read,
      not a re-derivation — §5.8's citations were refreshed against the post-fix tree, and the DB
      suites that exercise I1/I2/I5/I6/I7/I8 (`settle`, `ledger`, `recompute`, `webhook`,
      `reconcile`) pass in §5.10.
- [x] A replayed delivery never changes the outcome recorded for the delivery that applied money
      (R08-1), because that row is the only record of which delivery applied it — one writer, a
      terminal row refusing the write before the upsert (§5.10).
- [x] A deterministic rejection (`take-below-reserve:`, `ledger-invariant:`, money/reference
      mismatch) reaches a human: the operator is paged or the job that finds it runs on a schedule
      (R08-3), because the buyer's money is already captured by then (§5.9) — `unapplied` in
      `/api/jobs/reconcile` fails `ok` (503) and the ten-minute workflow step turns that into a red
      run with both counts in the message.
- [x] The reconcile job is reachable without hand-typing a secret (cron or monitor) and its 503 is
      what alerts — the tick's bearer header, `jobAuth` fail-closed in production, and the `503` from
      `divergent || unapplied` (§5.10).
- [x] Every terminal `Payment` shape an operator can encounter has a stated action — PENDING with no
      `providerRef`, PENDING with one, FAILED, REFUNDED, CANCELED — and the table in §5.3 can be read
      against it (R08-4, R08-5) — the last of the five, CANCELED, now has a writer: the 24 h sweep.
- [x] A buyer whose payment reverses is told, in mail, in the same transaction that reverses it
      (R08-2) — `REFUND_EMAIL` enqueued inside the reversal transaction and drained on the bounded
      inline path.
- [x] No source list in `doc/review/00-REVIEW-PLAN.md` names a module that does not exist
      (`lib/idempotency.ts`, `lib/reconcile.ts`), and no module that exists but is wired to nothing
      is left undocumented (R08-4) — L3 and §2 corrected; `lib/applyPayment.ts` deleted rather than
      left wired to nothing.

**Fix-pass criteria** (2026-09-15, verified by §5.10):

- [x] The register has exactly one writer and refuses to rewrite a decision it already recorded
      (R08-1 — `providerEventUpdate`/`recordProviderEvent`, the static one-upsert assertion in
      `lib/phase8.test.ts`, the DB replay in `lib/reconcile.test.ts`)
- [x] A reversal enqueues its notice in the same transaction that unwinds the stake, and a replay
      enqueues nothing (R08-2 — `dedupeKey: refund-${paymentId}`)
- [x] A captured-but-unapplied charge and a reversal that never unwound both fail the reconcile
      report, and the ten-minute tick fails its run and names the counts (R08-3 — the 503 plus the
      workflow's `::error::` line, proven with a body-driven harness)
- [x] `PaymentStatus.CANCELED` is reachable, bounded, oldest-first, idempotent, and cannot race a
      settle onto a closed row (R08-5 — `lib/abandonedCheckouts.test.ts`, 7 DB tests)
- [x] A declined card attempt is distinguishable from an unclassifiable delivery, without pretending
      the buyer's checkout is over (R08-6)
- [x] A register row that outlives its payment still names its element and startup, and the migration
      backfills the rows that still have one (R08-7 — `elementId`/`startupId` copied at ingest,
      migration 0007's `UPDATE … FROM "Payment"` re-run on a scratch database at 0006)
- [x] The plan's source list names only modules that exist (R08-4's tail — L3 `:38`, §2 `:112-113`)

## 9. Open questions

**Q1 — Is `amount-unverified` an acceptable steady state?** Four free DEV stakes were counted as
unverified on the production-flagged probe process (doc 07 §5.2), and the reconcile response
currently reports them as a plain count. If the Stripe path can ever settle without a provider
figure (the `absent` branch, `lib/money.ts:44-53` → `lib/settle.ts:270-271`), an operator needs a
rule for how many unverified rows are tolerable. Only the operator can set that threshold.
*Untouched by the fix pass, and deliberately: `unverified` stays advisory (it does not fail `ok`),
because a count the operator has not set a threshold for must not page. The branch that produces it
was not narrowed either — `amountUnverified` is still recorded on the register and the `ERROR`-free
`applied` row still records `amount-unverified:provider-stated-none` (`lib/settle.ts:348`). What the
pass did change is that a count nobody set a threshold for is now visible beside two counts that do
fail the run, so the threshold is a decision with a number next to it.*

**Q2 — Which terminal rejection must be a refund?** `take-below-reserve:` means the buyer paid for an
element someone else took first. The code's answer is "record it and move on" (§5.9). Refunding
automatically, refunding by hand, or applying the stake anyway are all defensible and mutually
exclusive; the choice is the operator's, and the current behaviour is the third one's opposite.
*Unanswered — still the operator's call — but no longer silent: `take-below-reserve:` now lands in
`unapplied`, which fails the reconcile report and reds the ten-minute tick (§5.10), so the window
between "the money was captured" and "someone knows" is ten minutes rather than "until an operator
reads the table". No automatic refund was written: refunding on the app's own initiative needs a
provider call this checkout cannot exercise, and it is the option the finding puts last.*

**Q3 — Should the 200-for-terminal-rejection answer stay?** It is deliberate (a redelivery can never
succeed) and it is also why the operator never hears about it. If R08-3's alerting lands, 200 stays
correct; without it, a 5xx would at least make Stripe retry for days. *Closed by R08-3's fix: the 200
stays, because the alerting the question conditioned it on now exists — the register's `ERROR` row is
read by `unapplied` and the failing 503 reaches a red workflow run. `app/api/webhooks/stripe/route.ts:222-223`
is unchanged, and matrix rows 5, 6, 7, 8, 12 and 13 keep their 200.*

**Q4 — Should a declined card terminate the payment?** (Raised by R08-6's fix, which records the
attempt without changing the payment's state.) `payment_intent.payment_failed` is not in the
subscribed event set, the payment stays PENDING and still payable, and the register row now says
`declined-attempt`. The alternative — a FAILED status on the first decline, or after N declines — is
reachable (the `failedAt` column is there, and the FAILED writer at `lib/settle.ts:134` is the
session-expiry path) but it has to answer two things this pass could not: whether Stripe's own
session expiry already covers the case well enough, and whether a buyer who mistypes a card once
should come back to a dead checkout rather than a retryable one. The state the code sits in today is
the one that costs the operator rows, not the one that costs the buyer a purchase, so the decision is
recorded rather than taken.

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

- 2026-09-15 — authored 2026-09-15 against `9681bdcbff2435ef258224c52000e0f8d6089f5c`. First
  pass: sections 1-12, findings R08-1…R08-7, UNKNOWN U08-1…U08-4, and no fix-verification section —
  §5.10 was added by the same day's fix pass.
- 2026-09-15 (working tree) — fix pass for R08-1…R08-7, each cited in §7 with its verification in §5.10, the invariant table's citations refreshed against the post-fix tree (§5.8), the criteria in §8 ticked with a fix-pass block added, and §9 Q1-Q3 annotated and Q4 raised from R08-6's fix. `lib/settle.ts`: `providerEventUpdate()` (`:93`) as the single precedence rule for the register — a row whose stored outcome is anything but `ERROR` is terminal and the patch is `null`; `recordProviderEvent()` (`:114`) as the register's only writer (attribution resolved from the payment at `:121-127`, early return before the upsert at `:138`); `recordEvent()` (`:176`) reduced to a wrapper; `REFUND_EMAIL` enqueued inside the reversal transaction (`:478-479`, `dedupeKey: refund-${paymentId}`) and drained on the bounded inline path (`:521-525`). `app/api/webhooks/stripe/route.ts`: all seven register writes go through `recordProviderEvent`, the `IGNORED` branch tags a declined attempt (`:132`), and the two pre-payment deliveries keep `paymentId: null` (`:63,79`). `emails/refund.tsx` (new), `sendRefundEmail()` (`lib/email.ts:157`), outbox type `REFUND_EMAIL` (`lib/outbox.ts:112-113`). `app/api/jobs/reconcile/route.ts`: `unapplied` (`:131-143`), advisory `stale` (`:144-154`), `failing = divergent || unapplied` → 503 (`:156`, `:188`), the Hobby cron note (`:194`). `.github/workflows/outbox-tick.yml` (the correction to R08-3's premise — this workflow has polled reconcile every ten minutes since `7ce73a9`): the abandoned-checkout step (`:71`), the reconcile step with `if: ${{ !cancelled() }}` and jq body checks that fail the run with both counts (`:83-104`). `lib/abandonedCheckouts.ts` + `app/api/jobs/abandoned-checkouts/route.ts` (new; `CHECKOUT_ABANDON_TTL_MS` 24 h, `ABANDON_MAX_BATCH` 50, conditional `updateMany`, `CHECKOUT_ABANDONED` audit at `lib/audit.ts:27`). `lib/stripe.ts`: `DECLINED_EVENT_TYPES` (`:424`) and `stripePayloadIsDeclined()` (`:426`). Schema: `ProviderEvent.elementId`/`startupId` (`:336-337`) and `@@index([outcome, createdAt])` (`:345`), with migration `prisma/migrations/0007_provider_event_attribution/migration.sql` adding both columns, a `UPDATE … FROM "Payment"` backfill in 0003's shape, and the index. `lib/applyPayment.ts` deleted. Tests: new `lib/phase8.test.ts` (24), new `lib/abandonedCheckouts.test.ts` (7, DB), four additions to `lib/reconcile.test.ts` (DB), one migration-backfill replay on a scratch database. Verification §5.10: `TEST_DATABASE_URL=… npm run test:ci` 45 files / 647 passed / 0 skipped (CI's skip gate satisfied), plain `npx vitest run` 39 passed + 6 skipped files / 565 passed + 82 skipped, `npx tsc --noEmit` clean, `npx eslint lib app` clean, all against a local `postgres:16-alpine` on CI's port 55433. Deliberately not taken, each recorded with its finding: `markFailed` on the checkout failure path (R08-4 — the sweep closes that row instead), the finding's `vercel.json` cron arm (R08-3 — Hobby's two slots are taken), terminating the payment on `payment_intent.payment_failed` (R08-6 — the session can still be paid), `onDelete: Restrict` on the register (R08-7), cancelling reservations in the sweep (R08-5), and the `cancel_url` callback (R08-5). No live Stripe delivery: U08-1…U08-4 all stand.

## 12. UNKNOWN log

| Id | Phase | Category | Unknown | What settles it |
| --- | --- | --- | --- | --- |
| U08-1 | 08 | ops | Whether a real Stripe endpoint retries the 500s this route returns, for how long, and whether the dashboard's endpoint view shows the failures an operator would need to see | A Stripe dashboard reading of the endpoint's delivery attempts after one forced `settle-retryable` 500, or `stripe events resend` against a registered endpoint |
| U08-2 | 08 | correctness | Whether real Stripe payloads for `charge.refunded` / `charge.dispute.created` carry a *partial* amount, and whether this route would treat a partial refund as a full unwind (`lib/settle.ts:394-542` has no partial path) | A live refund for less than the captured amount, or Stripe CLI `stripe trigger charge.refunded` with an edited amount, then a read of the resulting stake totals |
| U08-3 | 08 | robustness | Whether `MONEY_TX` behaves as designed when the database connection drops mid-transaction on the deployed provider (Neon), i.e. whether the buyer's delivery is retried or the reservation is left decayed | A managed-Postgres failover during a settle probe, or a connection-kill test against the production-shaped database |
| U08-4 | 08 | data | How many `ProviderEvent` rows in production are `ERROR` today, and which reasons dominate | A production DB read of `ProviderEvent` grouped by outcome/detail — needs credentials no review session holds |

All four stand after the fix pass (§5.10, "Still not measured"). Three of them are reasons the pass
could not *test* its own work end to end rather than reasons the work is unproven: U08-1 is why the
500/503 answers are argued from the route and the workflow rather than from a delivery Stripe actually
retried, U08-2 is why the reversal path's "no partial" is stated as a limit instead of a check, and
U08-3 is why `MONEY_TX`'s failover behaviour is unchanged by the pass. U08-4 is the one with no
bearing on any fix: it is still the first thing to read when someone inherits this phase, because
`unapplied`'s whole job is to surface rows whose reasons today are only knowable from that read.
