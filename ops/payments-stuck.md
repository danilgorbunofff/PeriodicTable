# A payment took money and nothing changed

Finding: R17-1. Read `README.md` first for the two credentials and the clock.

The buyer's screen said paid and their element did not move: either the capture
never happened, or it happened and our side never applied it. Nothing in the
product re-settles a payment — settlement is driven by the provider's delivery
alone (`app/api/webhooks/stripe/route.ts` → `lib/settle.ts`) — so the procedure
ends at the provider's dashboard, not here.

## 1. Ask the ledger what it thinks

```sh
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "$APP_URL/api/jobs/reconcile" | jq .
```

Read four fields (the full body is documented in the route and in `webhooks.md`):

| Field | Reading |
| --- | --- |
| `ok` | `false` = at least one of `divergent`/`unapplied`/`aggregate` is non-zero. This is the one that pages. |
| `unapplied.count` | A delivery ended in ERROR and was never superseded, on a payment still `PENDING` (money captured, nothing applied) or still `PAID` (a reversal that never unwound). **This is the stuck-payment shape.** |
| `divergent.count` | A `PAID` row whose stored provider figure contradicts the charge. Impossible by construction — if it is non-zero, stop and read `doc/review/08-settlement-and-ledger-integrity.md`. |
| `stale.count` | `PENDING` past the 24 h session lifetime: no delivery is coming. Operator work, listed with `providerCheckoutUrl`. |

A 503 with `ok:false` is the same answer with an alarm attached; the body still
carries the samples. `unapplied.samples[]` gives you
`{event, eventType, detail, at, payment}` — the provider event id and the payment
row, which is what the next two steps need.

**The trap:** if the delivery was rejected for a bad signature, it was refused
*before* any write, so there is no `ProviderEvent` row and no count anywhere. A
`unapplied.count` of 0 does not prove the webhook is healthy — check the Stripe
dashboard's delivery log (step 2) as well.

## 2. Find the charge on the provider side

Dashboard → **Payments**, search by amount, date or the buyer's receipt address.
There is no payer lookup in the product (R16-5: no statement descriptor, no
email-to-payment index), so this is the only place the two halves are joined.

Note the payment intent / charge id and its status (`succeeded`, `refunded`,
`disputed`). If Stripe shows `succeeded` while our row is `PENDING`, the capture
is real and only the delivery is missing — go to step 3.

## 3. Read what we recorded, and why it failed

```sh
psql "$DATABASE_URL" -c "
SELECT id, status, amount_usd, provider, provider_ref, idempotency_key, paid_at
FROM \"Payment\" WHERE id = '<paymentId>';"
psql "$DATABASE_URL" -c "
SELECT id, \"providerEventId\", \"eventType\", outcome, detail, \"createdAt\"
FROM \"ProviderEvent\" WHERE \"paymentId\" = '<paymentId>'
ORDER BY \"createdAt\" DESC LIMIT 10;"
```

- No rows at all → the delivery never authenticated (step 2's delivery log shows
  401s) or was never sent; treat it as `webhooks.md` §"nothing arrives", and finish
  with step 4.
- `outcome = 'ERROR'` with a `detail` → the delivery was refused on purpose
  (amount/currency mismatch, ledger invariant). The detail is the reason; it will
  not fix itself on redelivery.

## 4. Apply the one remedy that exists: re-deliver from Stripe

Dashboard → **Developers → Webhooks → your endpoint → the failed event →
Resend**. Stripe re-signs and re-posts the same event id.

This is safe to repeat: `ProviderEvent.providerEventId` is the replay key, a
completed row is never rewritten, and a true duplicate answers `200
{"outcome":"duplicate"}` / `"already-settled"` rather than applying twice.

Then re-run step 1. **Done looks like:** `ok: true`, and for the payment in
question either `Payment.status = 'PAID'` with `paidAt` set and its
`ProviderEvent` row now `APPLIED`, or the ERROR row superseded by a later
successful delivery for the same payment.

If the redelivery cannot succeed (a deterministic ERROR detail), the money is
captured and the ledger says so — that is an operator decision, not a retry:
either refund the charge in the dashboard (`refunds-and-disputes.md`) or settle
its effect by hand in a reviewed transaction and say so in the incident note.
Never hand-edit `Payment.status` alone: the stake, the element aggregates and the
`Payment` row are written together on purpose (`MONEY_TX` in `lib/settle.ts`),
and `reconcile.aggregate` will catch a half-written repair.

## 5. Tell the buyer, and mind the difference

- `POST /api/admin/outbox/retry {"dedupeKey":"receipt-<paymentId>"}` re-sends the
  **receipt mail**. It is a mail action and settles nothing — at 03:00 this is the
  easiest mistake in this runbook. It also writes an `OUTBOX_RETRY` audit row
  naming the operator.
- A refund's own message is sent by the reversal path; do not send a receipt for
  a refunded charge.
- The receipt only exists as a row if a mail row was enqueued; check
  `EmailLog` for the key before promising the buyer anything.

## 6. Leave a trace

Post the reconcile body before and after, the Stripe event id, and the decision,
into the incident note (or `doc/`, whichever the incident already uses). The
next responder needs the provider event id, not a narrative.

## What is still missing

- Reconcile rides the ten-minute tick, which is not ten minutes in practice
  (measured 5 % of nominal, worst gap 6 h 40 m). A stuck payment can therefore sit
  until the next tick that actually runs. The alarm channel's adequacy is
  `doc/review/18`'s finding, not this runbook's.
- `unverified.count` (a `PAID` row the provider never stated an amount for) is
  advisory and has a recorded baseline in `.github/workflows/outbox-tick.yml`. A
  rise is new coverage gap, not new money.
