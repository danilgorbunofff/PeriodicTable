# Mail is not arriving

Finding: R17-13. Related: `secrets.md` (`RESEND_API_KEY`), `takedown.md`
(suppression), `payments-stuck.md` §5 (the receipt-specific path), and
`alerts.md` for the two queue alarms that fire before anyone opens this file
(`outbox-depth` at 25 pending rows, `outbox-stale` at 120 minutes) and for
`mail-not-sending`, which is the alarm form of the `logged` driver below.

Mail never fails loudly on the way out: it is written to a durable outbox row
first, then delivered by the worker
(`POST /api/jobs/outbox`, drained by the ten-minute tick). "Not arriving" is
almost always one of four states: the row is waiting, the row is stuck, the
driver is `logged`, or the address is suppressed.

## 1. Ask the queue, and the register, at once

```sh
curl -sS -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/jobs/config" | jq '{mail, heartbeats}'
curl -sS -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/jobs/reconcile" | jq '{ok, outbox}'
```

`/api/jobs/config` → `mail`:

| Field | Reading |
| --- | --- |
| `driver: "logged"` | **No `RESEND_API_KEY` in this process.** `deliver()` writes `EmailLog.status = 'logged'` and sends nothing. Every "we sent it" claim is false until this changes. Rotate/fix per `secrets.md` and redeploy. |
| `driver: "resend"` | The key is present; mail leaves the building. Keep going. |
| `suppressed` | Addresses on the do-not-mail list (`EmailAddress.reason` is set: hard bounce, complaint or unsubscribe). `R17-13`. |
| `failedCount` / `oldestUnretriedKey` | Sends the provider refused, and the worst-offending dedupe key. A key that recovered by a later `sent` is not counted. |

`/api/jobs/reconcile` → `outbox` (advisory; it does not fail `ok` on purpose):

| Field | Reading |
| --- | --- |
| `due` | Rows whose `nextAttemptAt` has passed and that still have attempts left. A backlog that does not fall is a stopped tick, not a mail problem. |
| `exhausted` | Rows with `attempts >= OUTBOX_MAX_ATTEMPTS (5)`. **The worker will never touch these again** — they are waiting for a human (§3). This is the field that means "stuck". |
| `failed` | The count behind `/api/jobs/config`'s failure block, with `oldestKey` naming the worst-offending dedupe key. |
| `oldestDueHours` / `oldestDueAt` | How long the oldest undelivered row has been waiting. Hours, not minutes, is a stopped clock. |
| `lastDeliveredAt` | The newest successful delivery. If this is older than `oldestDueAt`, nothing is draining. |
| `pending` / `pendingByType` | Everything not yet delivered, by job type — `due` says what the worker will claim, this says how much is behind it (`R18-8`). |
| `oldestPendingMinutes` | The age of the oldest undelivered row, in minutes, which is the unit an alert needs (`outbox-stale`, `alerts.md`). |
| `driver` | The same reading as `/api/jobs/config`'s `mail.driver` (`R17-13`), repeated here so one call answers both questions. `logged` means every pass below is theatre. |

A single read of all of it, without a bearer token's worth of judgement calls,
is `GET /api/admin/ops` → `outbox` and `mail`, with the alarm list computed
for you; `ops/alerts.md` names every code and its threshold.

## 2. Is the clock even running?

`due` above 0 with `lastDeliveredAt` frozen is the tick's problem
(`README.md` §"The clock and the alarm"):

```sh
gh run list --workflow=outbox-tick.yml --limit 5
gh run view <run-id> --log | grep -E "Outbox|Reconcile"
```

A 401 in that log is a rotated `CRON_SECRET` in only one of the two consoles
(`secrets.md` §CRON_SECRET). Nothing that follows helps until the worker can
authenticate, so fix that first.

## 3. Drain or retry by hand

**Drain** — run the same worker the tick runs, with a bigger batch (default 5,
max 25) and the same backoff rules:

```sh
curl -sS -X POST "$APP_URL/api/jobs/outbox" \
  -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"limit":25}' | jq '{claimed, completed, failed, deferred, remaining}'
```

`remaining > 0` means call it again (the tick does the same in a loop until its
budget runs out). `deferred` is rows not yet due under backoff — they will drain
themselves.

**Retry a specific row** — the operator path, for rows the worker has given up on
(`exhausted` above, or a `failed` entry named by `oldestKey`):

```sh
curl -sS -X POST "$APP_URL/api/admin/outbox/retry" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"dedupeKey":"receipt-<paymentId>","operator":"<name>"}'
```

What it does and refuses, per the route:

- It resets `attempts`/`nextAttemptAt` so the next worker pass redelivers, and
  writes an `OUTBOX_RETRY` **audit row** naming the operator (`R14-9`).
- `404 NOT_FOUND`: no outbox row with that key — the mail was never enqueued, so
  this is not the lever; find out why the code path did not run.
- `409 ALREADY_DONE`: the row is complete. The refusal **names what the register
  saw** as `delivery`, because "complete" hides two different histories
  (`R13-1`):

  | `delivery` | Meaning |
  | --- | --- |
  | `sent` | The provider accepted it. If the buyer says otherwise, it is a delivery/address problem, not a queue one. |
  | `logged` | `RESEND_API_KEY` was missing: nothing was sent, ever — that is the driver fault in §1, not a lost mail. |
  | `suppressed:<reason>` | The address is on the do-not-mail list; check `takedown.md`. |
  | `none` | Complete with no evidence in the register — the `R10-1` shape, and the one case that is deliberately retryable. |

Keys are type-prefixed, so a key you can guess is checkable:
`receipt-<paymentId>`, `refund-<paymentId>`, the outbid/preview/analytics
variants, `report-<id>`, plus waitlist. `EmailLog.dedupeKey` is the register side
of the same key; both tables are indexed by it.

## 4. Read the register for the address

```sh
KEY='receipt-<paymentId>'
psql "$DATABASE_URL" -c "
SELECT to, template, status, detail, \"providerMessageId\", \"providerStatus\", error, attempts
FROM \"EmailLog\" WHERE \"dedupeKey\" = '$KEY' ORDER BY \"createdAt\" DESC LIMIT 10;"
```

- `status = 'error'` with `providerStatus`/`error`: the provider refused. 4xx
  usually means the address or the sender domain; 5xx is retryable through the
  queue rather than the operator path.
- `status = 'suppressed:*'`: a hard bounce or a complaint was recorded
  (`EmailSuppression`) — do not retry it, and read `takedown.md` for what the
  buyer must do to be contactable again.
- `status = 'sent'` and the buyer still has nothing: check spam, then the
  provider's own delivery log in the Resend dashboard (acceptance, then
  delivery, are different events).

## 5. When a whole class of mail is missing

- **Nothing at all, ever** — `driver: "logged"` (§1) or the outbox table is not
  being written. Check the account-level key and redeploy before anything else.
- **No bounce handling** — `POST /api/webhooks/resend` refuses 401 without
  `RESEND_WEBHOOK_SECRET`, so suppressed addresses are never recorded and we
  keep mailing them (`takedown.md`).
- **Receipts for new purchases only** — that is the settlement path, not the
  outbox: `payments-stuck.md`.
- **Everything >5 attempts old** — a burst of provider failures burned the retry
  ladder for every row in the window. Retry the keys that matter (`oldestKey`
  first), and prefer drain-by-hand while the provider is unhealthy.

## After the fix

Record what was queued, what was retried, and who authorised it, in the incident
note. A retried receipt is a mail the buyer receives twice if the first one *did*
leave the building — for anything money-shaped, check §4's register before
retrying, and never use the retry endpoint to "test" the mail path: use a
dedicated test address in development.
