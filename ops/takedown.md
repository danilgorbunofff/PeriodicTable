# Takedown Playbook

Index and auth: `ops/README.md`. Every call below is an admin call, authenticated
with `Authorization: Bearer $ADMIN_TOKEN` — or with a named token from
`ADMIN_TOKENS` (`name:token`), in which case the name is what the audit row
records and the body's `operator`/`reviewedBy` cannot override it. Without a valid
token every endpoint answers **403** (even in development). A wave rather than a
single report: `ops/abuse-wave.md`.

## The daily sweep (R20-9)

Both clocks this playbook publishes start when something *arrives*, not when
somebody reads it — a complete rights complaint is "actioned within 72 hours"
(`/legal/contact`) and any other mail is answered "within a few business days" —
and the report queue is a **pull** surface that notifies nobody
(`app/api/admin/reports/route.ts`). So the watching is a schedule, not a habit:

- **Once a day, every day:** read the queue's own numbers (`X-Report-Queue-Open`
  / `-Overdue` / `-Oldest-Hours`, §Triage step 1) and open the one inbox the site
  publishes — `info@periodictable.lol`, which is `lib/legal.ts`'s `SUPPORT_EMAIL`,
  so this line cannot drift from the pages that name it. Everything arrives
  there: reports and rights complaints (72 h), payment questions, privacy
  requests, and the replies to our own mail. An empty day is a ten-second check;
  what it buys is that nothing ages unread while a page promises a turn-around.
- **Friday, and the day before any planned absence:** sweep, and act the *same
  day* on anything DMCA-shaped or lawyer-shaped. A Friday rights complaint read on
  Monday is already at the 72-hour promise, and moderation is reversible, so
  containment (hide with the factual reason, §Contain) is the cheap first move,
  and the reviewer's decision can follow it.
- **If a week is going to be best-effort:** change the published window for it
  rather than missing it. A missed promise on the contact or rules page is a
  worse failure than a modest one, and the sentences that publish these windows
  are in the legal corpus (`lib/legalDocs.ts`), not in this file.

## Intake
- Report button on every rank row → `POST /api/report { stakeId, reason }` → `Report{status: OPEN}` row.
- Rate limit: 10/IP/hr (shared store when Upstash is configured; per-instance and
  fail-open until then — an open production finding, D15). Valid reports
  always 200 to the reporter (even when rate-limited); malformed JSON → 400.
- The report is durable the moment the row exists. The notification mail to
  `REPORT_NOTIFY_EMAIL` goes through the outbox and can lag or fail without the
  report being lost (`ops/email.md`).

## Triage (<24h, promise 72h)

1. **Read the queue's own numbers first** — they say whether the wave is real
   before anyone reads a single report:

   ```sh
   curl -sS -D - -o /tmp/reports.json \
     -H "Authorization: Bearer $ADMIN_TOKEN" "$APP_URL/api/admin/reports?status=OPEN" \
     | grep -i '^X-Report-Queue-'
   ```

   `X-Report-Queue-Open`, `-Overdue` (0 whenever the promise holds, so **this is
   the one to act on**), `-Promise-Hours` (72), and `-Oldest-Hours`/`-Oldest-At`.
   The headers, not the body: the body stays a bare array so it pipelines
   (`doc/review/16` R16-12).

2. **Page through it, oldest last.** The list is newest-first, `take: 50`, and a
   fifth of an abuse wave can hide the oldest reports — the ones ageing toward
   the promise. When there are 50 rows, continue with the last id:

   ```sh
   curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
     "$APP_URL/api/admin/reports?status=OPEN&before=<last-id-from-previous-page>"
   ```

   An unknown `?status=` is a **400** (`BAD_STATUS`), not an empty queue, so `[]`
   really means none.

3. Verify URL vs claim (phishing, trademark, malware).
4. Record the decision (state + operator detail — stakes are never touched):

   ```sh
   curl -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d '{"status":"TRIAGED","note":"phishing — hiding","reviewedBy":"ops"}' \
     "$APP_URL/api/admin/reports/<id>"
   ```

   Statuses: OPEN, TRIAGED, ACTIONED, DISMISSED (any order accepted today;
   follow OPEN → TRIAGED → ACTIONED | DISMISSED by convention). With a named
   token the PATCH's actor is the token's name; `reviewedBy` is only used when
   the token has no name.

## Contain (hide / unlist / restore)
- Hide (phishing/malware/DMCA): removes the listing from tiles, drawers,
  search, boards, table order, and profile (404s); stops /go redirects and
  clears the stored preview.
  ```sh
  curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
    -d '{"state":"HIDDEN","reason":"phishing — <rule>","operator":"ops"}' \
    "$APP_URL/api/admin/startups/<domain>/moderate"
  ```
- Unlist (trademark dispute, low confidence): direct links keep working;
  discovery surfaces exclude it. Same call with `{"state":"UNLISTED", …}`.
  `reason` is required for both (`REASON_REQUIRED`) and is stored on the listing
  as well as in the audit row — write the factual reason.
- **Restore**: `{"state":"VISIBLE","operator":"ops"}` (reason optional). The
  listing returns with its `moderatedBy`/`moderatedReason`/`moderatedAt` intact
  and `restoredAt` stamped. A `HIDDEN` listing's **preview does not come back on
  its own** — see below.
- **Many at once**: `POST /api/admin/startups/moderate-batch`
  (`{"state","reason","domains":[…]}`, up to 50, same rules and same write
  function, one `PROFILE_MODERATED` row per domain). The answer's
  `changed`/`unchanged`/`unknown`/`lost` lists are the whole point; the procedure
  is `ops/abuse-wave.md`.
- Inspect current state:
  ```sh
  curl -H "Authorization: Bearer $ADMIN_TOKEN" "$APP_URL/api/admin/startups/<domain>/moderate"
  ```
  The GET reports `operatorIdentity` (the resolved token name, or null with the
  shared token) and the moderation columns, so "who hid this and why" is readable
  without SQL.
- Every action writes an `AuditLog{action: PROFILE_MODERATED, actorType: operator}`
  row; the batch writes one per domain.

### Preview backfill after a restore
A `HIDDEN` listing lost its cached preview (retention policy nulls
`previewImgUrl`), and moderation is idempotent, so re-hiding is not needed —
refill it instead:

```sh
# Batched, via the screenshot job (bounded to 50 per call, enqueues outbox rows):
curl -X POST -H "Authorization: Bearer $CRON_SECRET" -H 'Content-Type: application/json' \
  -d '{"backfill":true,"limit":10}' "$APP_URL/api/jobs/screenshot"

# Or directly for a short list (needs DATABASE_URL; VISIBLE + preview-less only):
npx tsx scripts/backfill-previews.ts --limit=50
```

Then let the outbox drain (`ops/email.md`). A restored tile with a stale preview
is worse than an empty one, so restore in the same order the wave was contained.

## Reading the audit trail (`R18-5`)

Every action in this playbook writes an `AuditLog` row, and before phase 18 those
rows had no reader: `REPORT_TRIAGED`, `PROFILE_MODERATED`, `PAYMENT_REVERSED` and
the rest were visible to `psql` and to nobody else. There are now two readers.

**The API**, which needs no SQL and no `DATABASE_URL`:

```sh
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$APP_URL/api/admin/audit?action=PROFILE_MODERATED"
```

| Parameter | Use |
| --- | --- |
| `action=` | One action from `lib/audit.ts`. An unknown value is **400 `BAD_ACTION`** — a typo must not read as "nothing happened". |
| `startup=` | One listing's rows, for "what happened to this domain". |
| `payment=` | One payment's rows, for §"Ledger-crossing actions" in `refunds-and-disputes.md`. |
| `before=` | Cursor: pass the last row's id to get the next 50, newest first. |

Counts come back as headers, so one call answers "what happened" and "how much of
it": `X-Audit-Window-Days`, `X-Audit-Payment-Reversed`,
`X-Audit-Profile-Moderated`, `X-Audit-Report-Triaged`, `X-Audit-Operator-Writes`.

**SQL**, when the question is not one of those four. `actorType` is `system` by
default, so a row with no `actorRef` was written by the product (a webhook, a
worker, a payment settling) and not by a person:

```sh
psql "$DATABASE_URL" -c "SELECT \"createdAt\", action, \"actorType\", \"actorRef\", \"startupId\", \"paymentId\", detail FROM \"AuditLog\" WHERE action IN ('PAYMENT_REVERSED','PROFILE_MODERATED','REPORT_TRIAGED') ORDER BY \"createdAt\" DESC LIMIT 50;"
```

| Question | Action | Extra columns that carry the answer |
| --- | --- | --- |
| Who hid or unlisted which domain, and why? | `PROFILE_MODERATED` | `actorRef` (token name, or null with the shared token), `startupId` → domain, `detail` = the reason given |
| Who read the report queue, and what did they decide? | `REPORT_TRIAGED` | `actorRef` = `reviewedBy`, `detail` = `<status> — <note>` |
| Why did money move backwards? | `PAYMENT_REVERSED` | `paymentId`, `detail` = `charge.refunded removedUsd=… remainingUsd=…` |

The domain for a listing row comes from the join, not from the row:

```sh
psql "$DATABASE_URL" -c "SELECT a.\"createdAt\", s.domain, a.\"actorRef\", a.detail FROM \"AuditLog\" a JOIN \"Startup\" s ON s.id = a.\"startupId\" WHERE a.action = 'PROFILE_MODERATED' ORDER BY a.\"createdAt\" DESC LIMIT 20;"
```

Two readings that are easy to get wrong:

- `PAYMENT_REVERSED` is written by *settlement*, not by the operator: `actorType`
  is `system` and there is no `actorRef`, because the refund was clicked in
  Stripe's dashboard and the webhook is what we saw. "Who" lives in Stripe; "what"
  lives here (`refunds-and-disputes.md` §"Ledger-crossing actions").
- The trail is the record, not the log. Runtime logs last about an hour
  (`ops/alerts.md` §"Log retention"); `AuditLog` rows do not expire, so an
  incident note that has to survive the week quotes these rows.

## Which public numbers do not change
Hiding, unlisting and restoring move **visibility only**. Stakes, payments,
claims, `Element.totalPoolUsd`, `Element.stakeCount` and the leader are all
untouched, and `/api/stats` is hidden-inclusive by design — so a moderation call
never changes the public totals and cannot be used, or blamed, for a number moving.
The batch endpoint states this in its own response
(`publicNumbersUnchanged: true`). Money never moves from here: a refund is a
provider-side action with its own approval rule (`ops/refunds-and-disputes.md`,
`D17-5`), per payment, never a side effect of a hide.

## Failed deliveries
- A mail that failed keeps `lastError` on its outbox row and an
  `EmailLog{status: "error"}` row with the same `dedupeKey`; retry one delivery
  with the key:
  ```sh
  curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
    -d '{"dedupeKey":"receipt-<paymentId>","operator":"ops"}' \
    "$APP_URL/api/admin/outbox/retry"
  ```
  The retry writes an `OUTBOX_RETRY` audit row naming the operator (R14-9); the
  token's name wins over the body's. It re-sends **mail only** — it settles
  nothing (`ops/payments-stuck.md` says so three times for a reason).
- Rows written *before* the R10-1 fix are the exception: a provider refusal was
  reported without failing its row, so such a row reads **completed with
  `attempts = 0` and no `lastError`**, and a retry used to answer
  `409 ALREADY_DONE`. The retry now accepts exactly that row — completed, zero
  attempts, and an `EmailLog{status:"error"}` row for the same key — and refuses
  every other completed row, so it cannot be used to send a delivered mail twice.
- A `409 ALREADY_DONE` refusal names `delivery`
  (`sent` | `logged` | `suppressed:<reason>` | `none`) because "complete" hides
  two different histories: a provider-accepted send and a `logged` one, where
  `RESEND_API_KEY` was missing and nothing left the building. The table is in
  `ops/email.md` §3.
- Health: reconcile's `outbox` block (`due`, `exhausted`, `failed`, `oldestKey`,
  `oldestDueHours`, `lastDeliveredAt`) and `GET /api/jobs/config`'s
  `mail: { failedCount, oldestUnretriedKey }` — mail that failed with no later
  successful row for the same key. A rising `failedCount` is the alert;
  `oldestUnretriedKey` is the row to retry above. `null` means the database could
  not answer.
- A *suppressed* send is not a failure: the address asked us to stop, so there is
  nothing to retry (see below).

## Addresses we may not mail
- `EmailAddress` holds one row per address; `reason` is why we refuse it
  (`unsubscribe` — the person asked, `complaint` — their provider did,
  `bounce`/`invalid` — the address cannot receive mail, `manual` — ops).
  `reason = null` means mail is allowed; the row is kept either way because it
  also carries that address's unsubscribe-link token.
- What each reason stops: every refusal stops listing mail (receipts, outbid
  notices, waitlist confirmations). `unsubscribe`, `complaint` and `manual`
  still allow the money mail that follows a reversal, and `unsubscribe` outranks
  any later provider signal. `bounce` and `invalid` stop everything addressed
  there, because nothing can be delivered.
- To refuse an address by hand:
  `UPDATE "EmailAddress" SET reason = 'manual', source = 'ops', detail = '<why>',
  "updatedAt" = NOW() WHERE email = '<address>';`
  Prefer the product's own paths: the person's link writes `unsubscribe`, and the
  provider webhook below writes `bounce`/`complaint`.
- To lift a refusal, the person uses the link on any message they still hold
  (`POST /api/unsubscribe`, `?resubscribe=1`); it sets `reason = null` and writes
  an `EMAIL_RESUBSCRIBED` audit row. Lifting `bounce`/`invalid` by hand is safe
  only once the mailbox is known to work again — otherwise the next send returns
  the same bounce.
- Every flip is audited (`EMAIL_UNSUBSCRIBED` / `EMAIL_RESUBSCRIBED` /
  `EMAIL_UNDELIVERABLE`), and a *refused* send leaves
  `EmailLog{status: "suppressed:<reason>"}` with the reason in `detail`, so "why
  did this person never get their receipt" is answerable from the log alone.
- Provider evidence arrives at `POST /api/webhooks/resend`, authenticated by
  Resend's Svix signature. It needs `RESEND_WEBHOOK_SECRET` (the `whsec_…` value
  on the Resend dashboard's webhook page); without it every delivery is refused
  401 and *nothing* flips automatically — a bounce would then live only in
  Resend's dashboard, so treat this secret as part of the mail setup rather than
  an optional extra. A permanent bounce suppresses as `bounce`, a complaint as
  `complaint`, a failed send as `invalid`; a *transient* bounce is audited and
  otherwise ignored (a full mailbox is not a dead address).

## A buyer asks for a profile change
There is no client for this yet (`09` owns it; R17-7 reports the missing entry
point). `PATCH /api/startups/<domain>` exists, validates and audits, but it needs
a management session cookie and the flow that mints one — `POST /api/manage/request`
→ token → `POST /api/manage/verify` — is deliberately unshipped (the schema comment
says why: production sends nothing until the management UI exists), so anyone with
a text, link or logo change reaches us by mail (where that mail lands is D16).
Until the UI ships the operator *is* the client, and this is the whole procedure. Do
it with the audit row: a `prisma studio` edit or a one-off script leaves a listing
change nobody can attribute.

1. **Read the row and quote the change back** to whoever asked — the operator is
   the confirmation step, and the API replaces the whole profile, so an edit has to
   echo the fields it does not touch:

   ```sh
   psql "$DATABASE_URL" -c "SELECT domain, title, pitch, url, \"linkType\", \"logoUrl\", email, \"moderationState\" FROM \"Startup\" WHERE domain = '<domain>';"
   ```

2. **Check the values against the product's own bounds** (`lib/validate.ts` — the
   columns enforce widths and nothing else, so a bad value lands in the table *and*
   on the public drawer): `title` 2–32 characters, `pitch` 2–140, `linkType`
   `product`|`social`, `url` a full `https://` URL on a public host, `logoUrl` empty
   (leave it) or a full `https://` URL. Store what `normalizeUrl` would store — the
   scheme is added and the host lowercased. **`email` is not editable anywhere**
   (R10-2): the notification address is set at checkout and is final in v1, so an
   address change has no path — offer the unsubscribe link instead of promising one.

3. **Write it with the audit row, in one transaction.** `AuditLog.id` has no
   database default (Prisma mints the cuids), so supply one; a duplicate aborts the
   whole transaction, which is the loud failure we want:

   ```sh
   psql "$DATABASE_URL" <<'SQL'
   BEGIN;
   UPDATE "Startup"
      SET title = '<new title>', pitch = '<pitch unchanged>', url = '<url unchanged>'
    WHERE domain = '<domain>';
   INSERT INTO "AuditLog" (id, action, "startupId", "actorType", "actorRef", detail)
   SELECT 'profile-ops-' || to_char(now(), 'YYYYMMDDHH24MISS'), 'PROFILE_UPDATED',
          id, 'operator', '<you@where>', 'title'
     FROM "Startup" WHERE domain = '<domain>';
   COMMIT;
   SQL
   ```

   `detail` is the comma-separated list of changed fields, exactly what the owner
   path writes (`app/api/startups/[domain]/route.ts:73-78`): the trail then says
   *what* changed, and `actorType` says who could have done it (`owner` vs
   `operator`). An edit never touches listing state.

4. **Verify on the public surface**, not in the table: reload the element drawer
   for the listing's leader (`GET /api/elements/<sym>` carries its `title`, `pitch`,
   `logoUrl`, preview and `/go` URL) and confirm the new text renders and
   `moderationState` is still `VISIBLE` — a `HIDDEN`/`UNLISTED` listing accepts an
   edit and shows nothing, which is a confusing half-success.

Wanting the link *gone* is not an edit: that is `HIDDEN`/`UNLISTED` above, with a
reason, and it stays reversible.

## Rollback of a bad moderation
- Re-run the moderate call with `VISIBLE` (single or batch); history is intact by
  design and `restoredAt` records the reversal. Refill the preview with the
  `backfill` call above if the listing was `HIDDEN`.
- DB-level restore is a separate decision with its own procedure
  (`ops/database.md` §"Restore", D11) — hiding a listing is not a reason to
  branch the database.

## Comms
- Reporter: no PII back. Owner: exact rule violated + reclaim/refund path.
- Operator detail lives in `Report.note` (+ `reviewedBy/reviewedAt`), not in free-form text.
- Public/incident messaging (site down, degraded checkout, "your payment may have
  gone through") is `ops/comms.md`, including the templates and the claims the
  product can actually back up. Who publishes and where is D16.
