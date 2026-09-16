# Refunds, chargebacks and dispute evidence

Finding: R17-3 (the one line that used to exist for this was
`ops/rollback.md:54`, "refund via provider dashboard (Stripe)"). Read
`README.md` first for the credentials.

Two rules frame everything here:

- **The money moves in Stripe.** Our code never issues a refund call. It
  *records* what the provider reports.
- **The evidence lives in Postgres.** `Payment`, `ProviderEvent`, `Stake`,
  `FirstClaim` and `AuditLog` are never deleted by the product, including when a
  listing is hidden (moderation touches visibility only). The one tool that would
  destroy it is `launch-seed --fresh`, which now refuses a non-loopback database
  without two explicit flags (`database.md`).

**Who may approve a refund, from which console, and what the standard response to
a chargeback is — operator decision `D17-5`** (`doc/review/FINDINGS.md`; `17`'s own
decision list numbers it `D14`, which is what this file used to cite). This runbook
does not invent that answer; it gives the steps and the evidence once the decision
says to proceed.

**Nothing here has been done with real money yet** (R20-10, `checklist:310`). What
*is* proven is the code half, in `lib/webhook.test.ts` ("webhook refund /
chargeback unwind", `:214`): a `charge.refunded` delivery removes the stake, the
element's pool and the crown, writes the `refund` activity row, the `ProviderEvent`
and the `PAYMENT_REVERSED` audit row; a duplicate delivery is a no-op and a
*different* event id for an already-reversed payment answers `already-reversed`;
a dispute withdrawal on it changes nothing further; a partial refund still unwinds
the full charged amount; and a never-applied payment closes `refunded` without
touching the pool. The `REFUND_EMAIL` enqueue that rides with it is pinned by
`lib/phase8.test.ts:259` rather than by the webhook suite. Run the same assertions
against the payment you are refunding (steps 4 and 5 below, plus the `EmailLog`
row for `refund-<paymentId>`) rather than trusting them. What has never happened is
a refund on a card payment a human made: the first one is the drill, and it is the
same event as the first real payment.

## Refund a charge

1. Find the payment. There is no payer lookup in the product (R16-5), so start
   from the buyer's mail or the dashboard:

   ```sh
   psql "$DATABASE_URL" -c "
   SELECT id, status, \"amountUsd\", provider, \"providerRef\", email, \"paidAt\", \"refundedAt\"
   FROM \"Payment\" WHERE email = '<address>' ORDER BY \"createdAt\" DESC LIMIT 10;"
   ```

   `status` must be `PAID` for a refund to unwind anything. A `PENDING` row whose
   session expired is abandoned-checkout work, not a refund (`payments-stuck.md`).

2. Refund in the Stripe dashboard, in full or in part. Stripe is the source of
   truth for the amount.

3. The provider then sends `charge.refunded` (or a `refunded` status), and the
   reversal path runs: the payment becomes `REFUNDED` with `refundedAt` set, the
   stake is unwound, the element's pool/count/leader are recomputed and its
   aggregates are rewritten as part of the same transaction, and the buyer is
   told. A partial refund only reduces what the stake holds; the payment row still
   closes.

4. Confirm it landed:

   ```sh
   curl -sS -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/jobs/reconcile" \
     | jq '{ok, divergent, unapplied, aggregate}'
   psql "$DATABASE_URL" -c "
   SELECT status, \"refundedAt\" FROM \"Payment\" WHERE id = '<paymentId>';"
   psql "$DATABASE_URL" -c "
   SELECT \"providerEventId\", \"eventType\", outcome, detail FROM \"ProviderEvent\"
   WHERE \"paymentId\" = '<paymentId>' ORDER BY \"createdAt\" DESC LIMIT 5;"
   ```

   **Done looks like:** `Payment.status = 'REFUNDED'` with `refundedAt`, the
   newest `ProviderEvent` at `outcome = 'REFUNDED'`, `reconcile.ok = true` and
   `aggregate.count = 0` (a reversal that left the element's totals stale is
   exactly what that block catches; a non-zero count is a repair, not a retry).

5. Deliberately *not* part of the procedure: hand-editing `Payment.status`. The
   payment, the stake and the aggregates are written together
   (`MONEY_TX` in `lib/settle.ts`) and the schema has CHECK constraints pairing
   `refundedAt` with the status. A half-written repair is worse than a missing one
   and `reconcile.aggregate` will find it for you the next morning.

A refund of a payment that was never applied (`reversed-before-paid`) closes the
payment `REFUNDED` and records the event, so a late paid delivery cannot apply it.
That is intentional, and `reconcile` stays green.

## A chargeback or a dispute arrived

`charge.dispute.created` and `charge.dispute.funds_withdrawn` are classified as
reversals, so **the stake is already unwound by the time you read the dashboard
notice** — our ledger has removed the money. What is left is the dispute itself:

1. **The clock is Stripe's.** Dashboard → **Payments → Disputes** shows the status
   and `evidence_due_by` for each open dispute. The product has no reminder; put
   the deadline in whatever the operator actually checks (calendar, issue tracker
   — that habit is part of `D17-1`/`D17-5`, not something this repo can enforce).

2. **Assemble the evidence pack** (§below) and submit it through the dashboard's
   dispute response form. Submit the provider's own identifiers first: a bank
   reads `providerRef`, the amount and the date before it reads our prose.

3. **The standard reply, in one paragraph:** what was sold (a paid listing on a
   specific element of the public table), when (the receipt's `createdAt`), the
   amount in whole dollars, that the buyer received the listing and the receipt
   mail, and that no subscription or recurring charge exists. Attach the receipt
   as sent (`EmailLog` for `receipt-<paymentId>`) and the `Payment` row.

4. **Funds withdrawn before capture**: `reversePayment` handles it
   (`reversed-before-paid`) — the payment closes `REFUNDED` and `reconcile`
   reports nothing, which is correct; the dispute is then purely a provider-side
   matter.

5. If the dispute is lost, nothing further changes in our systems: the stake is
   already unwound. If it is won back, re-applying is a fresh charge by the buyer,
   not a state edit.

## The evidence pack

Run this once per dispute and keep the output with the response. Every value here
is evidence the provider or a bank can be shown; the audit rows are the only place
operator action is recorded, so they are part of the pack, not decoration.

```sh
P=<paymentId>

# 1. The charge: amount, provider id, timestamps, consent trail.
psql "$DATABASE_URL" -c "
SELECT id, status, \"amountUsd\", provider, \"providerRef\", \"providerEventId\",
       \"providerAmount\", \"providerCurrency\", idempotency_key, email,
       \"createdAt\", \"paidAt\", \"appliedAt\", \"refundedAt\",
       \"consentVersion\", \"consentTextHash\", \"consentAt\"
FROM \"Payment\" WHERE id = '$P';"

# 2. Every delivery about it, with the raw payloads the disputes call answers:
#    our copy of what the provider said, including what we recorded and ignored.
psql "$DATABASE_URL" -c "
SELECT \"providerEventId\", \"eventType\", outcome, detail, \"createdAt\"
FROM \"ProviderEvent\" WHERE \"paymentId\" = '$P' ORDER BY \"createdAt\";"

# 3. What the money bought: the stake, its rank, and which element it held.
psql "$DATABASE_URL" -c "
SELECT s.id, s.\"elementId\", s.\"amountUsd\", s.rank, s.\"isLeader\",
       s.\"clicksDelivered\", s.\"createdAt\",
       e.symbol, e.\"totalPoolUsd\", e.\"stakeCount\"
FROM \"Stake\" s JOIN \"Element\" e ON e.id = s.\"elementId\"
JOIN \"Payment\" p ON p.\"stakeId\" = s.id WHERE p.id = '$P';"

# 4. The ownership claim the listing was sold against (first-claim provenance).
psql "$DATABASE_URL" -c "
SELECT f.\"elementId\", f.source, f.confidence, f.\"claimedAt\"
FROM \"FirstClaim\" f JOIN \"Payment\" p ON p.\"stakeId\" = f.\"stakeId\"
WHERE p.id = '$P';"

# 5. Operator and system actions around it (the trail that proves who did what).
psql "$DATABASE_URL" -c "
SELECT action, \"actorType\", \"actorRef\", detail, \"createdAt\"
FROM \"AuditLog\" WHERE \"paymentId\" = '$P' ORDER BY \"createdAt\";"

# 6. The receipt as the buyer received it (or why they did not).
psql "$DATABASE_URL" -c "
SELECT to, template, status, detail, \"providerMessageId\", \"providerStatus\",
       \"dedupeKey\", \"createdAt\"
FROM \"EmailLog\" WHERE \"dedupeKey\" = 'receipt-$P' ORDER BY \"createdAt\";"
```

Reading notes:

- `EmailLog.status` distinguishes the cases that look alike in a queue:
  `sent` (provider accepted), `error` (failed — retry with
  `POST /api/admin/outbox/retry {"dedupeKey":"receipt-<paymentId>"}`),
  `logged` (no `RESEND_API_KEY`, so nothing left the building — `email.md`), and
  `suppressed:<reason>` (the address refused mail — `takedown.md`).
- `consentVersion`/`consentTextHash`/`consentAt` are the record of what the buyer
  agreed to at checkout. `lib/consent.ts` carries the current statement; a
  mismatch between hash and version is a fact worth checking before quoting the
  rules at a bank.
- `ProviderEvent.detail` and the payload are our copy of the provider's side.
  Stripe's dashboard has the same objects in their original form — attach both.

## After either procedure

- Triage the *report* side if a complaint produced it (`takedown.md`) — a refund
  does not by itself hide or restore a listing, and a listing that was hid for the
  same reason stays hidden until someone restores it.
- A hidden listing still counts in `/api/stats` (`stakeCount`/`totalStakedUsd` are
  hidden-inclusive by design): do not tell a complainant the public numbers moved.
- Record date, payment id, provider event id, decision and who decided, in the
  incident note. Disputes are the one place where "who approved this" is asked
  months later, which is why `D17-5` has to have an answer.
