# Webhooks stopped working

Finding: R17-2. Rotation of the secret is `secrets.md`; this file is the
diagnosis. Alarm thresholds and the retention limit that makes a log line a bad
witness are in `alerts.md` (class 3, and §"Log retention").

One endpoint takes provider deliveries: `POST /api/webhooks/stripe`
(`app/api/webhooks/stripe/route.ts`). It verifies `stripe-signature`
(HMAC-SHA256 over `t.<raw body>`, 300 s tolerance) against the raw bytes before
anything else, so a delivery either authenticates and is recorded, or is refused
with `401 {"error":"bad signature"}` and **leaves no row at all**.

## 1. Which failure is it?

```sh
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "$APP_URL/api/jobs/reconcile" | jq '.unapplied, .divergent, .paidTotal'
```

| Reading | Meaning | Go to |
| --- | --- | --- |
| `unapplied.count > 0` | Deliveries authenticate but end in ERROR — money captured and not applied, or a reversal that never unwound. The samples carry the event id and detail. | §3 |
| `divergent.count > 0` | A `PAID` row contradicts the provider's own figure. | §3, then `08` |
| Both 0, but buyers are complaining | The deliveries are probably not authenticating: a 401 stores nothing. | §2 |
| `paidTotal` stopped rising | Captures are not reaching us at all. | §2 |

`ok` and the HTTP status follow the first two rows only — 503 when either is
non-zero.

## 2. Nothing authenticates (the 401 class)

The dashboard is the only record; ours starts after the signature check.

Dashboard → **Developers → Webhooks → your endpoint**:

- **Recent deliveries** — a run of `401` responses with no successful delivery
  after them means the endpoint's signing secret and `STRIPE_WEBHOOK_SECRET` no
  longer agree. Fix it with the rotation procedure in `secrets.md` (the code now
  accepts `STRIPE_WEBHOOK_SECRET_OLD` as well as the current secret, so an
  overlap is a supported state, not a hack).
- A run of `5xx` responses is our own retryable failure — the route answers
  non-2xx on purpose so Stripe redelivers ("Stripe's own retry behaviour is the
  only thing bounding the loss", R17-2). It resolves itself if the cause was
  transient; if it does not, treat it as §3.
- **The endpoint disabled** (Stripe disables an endpoint after days of failures):
  re-enable it, then use **Resend** on the failed events. Replay is safe — see
  §4.
- Nothing delivered at all, ever: the endpoint URL is wrong, or the account's
  live/test mode does not match the key in `STRIPE_SECRET_KEY`.

Confirmation from our side that the endpoint is *reachable* is not possible
unauthenticated: it answers 401 to everything without a valid signature, which is
the correct fail-closed behaviour, not a fault.

## 3. Deliveries authenticate but end in ERROR

```sh
psql "$DATABASE_URL" -c "
SELECT \"providerEventId\", \"eventType\", outcome, detail, \"createdAt\"
FROM \"ProviderEvent\"
WHERE outcome = 'ERROR' AND \"createdAt\" > now() - interval '7 days'
ORDER BY \"createdAt\" DESC LIMIT 20;"
```

| `detail` / shape | What it means |
| --- | --- |
| amount/currency mismatch | The charge does not match the `Payment` row. This is the acceptance rule doing its job; it never becomes success on redelivery. Investigate the row before touching money (`payments-stuck.md` §4). |
| ledger-invariant rejection | The delivery was applied and refused inside the transaction; a human must decide. |
| `unknown-payment` / `no-paymentId` | *Not* an error: those are recorded as `outcome = 'IGNORED'` with 200, by design (an unrelated account event must never apply a stake). Seeing them is normal. |

`reconcile.unapplied` filters these to the ones that matter (payment still
`PENDING`, or `PAID` with the ERROR arriving after `paidAt`) and ignores
rejections younger than an hour, because a retry may still be in flight. A row
that stays in that list for more than an hour is a person's problem.

## 4. Re-delivering

Dashboard → Webhooks → endpoint → the event → **Resend**. Replaying is always
safe and always the same operation:

- same `providerEventId` (`eventId` from the payload, or a hash of the raw body)
  → a completed row is **never** rewritten and answers `200
  {"outcome":"duplicate"}` or `"already-settled"`;
- an `ERROR` row **is** superseded by a later successful delivery for the same
  event — that is how a transient failure heals.

**Done looks like:** a new successful delivery in Stripe's log, and the payment's
`ProviderEvent` rows showing `APPLIED`/`REFUNDED` as the newest, with
`reconcile` back to `ok: true`.

## 5. Ordering, and what a delivery is allowed to do

- Reversals (refund / chargeback / dispute) are classified **before** paid/failed
  and win: a payload carrying both a paid type and a refunded status unwinds the
  stake rather than settling it. A refund arriving before the capture is recorded
  as `reversed-before-paid` and closes the payment `REFUNDED`, so the late paid
  delivery cannot apply it.
- A statusless or unknown event type is recorded `IGNORED` with 200. It must
  never settle anything (P0-03).
- Terminal ledger refusals answer **200** with an ERROR row on purpose: a
  redelivery loop cannot fix a mismatch, and 200 stops Stripe from trying for
  days while the row routes to a human. Retryable failures answer **5xx** so
  Stripe does retry.
- Every delivery writes a `ProviderEvent` row, and a bad signature now logs a
  throttled one-line reason rather than one line per attempt (`R18-2`). The rows,
  not the lines, are what `alerts.md` class 2/3 counts — the lines expire with
  the hour.

## 6. The other webhook

`POST /api/webhooks/resend` (bounces/complaints) is authenticated by Resend's
Svix signature and needs `RESEND_WEBHOOK_SECRET`. Without it every delivery is
refused 401 and nothing flips automatically — bounces then live only in Resend's
dashboard. Details and the suppression semantics are in `takedown.md`
§"Addresses we may not mail".
