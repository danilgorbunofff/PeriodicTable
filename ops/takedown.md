# Takedown Playbook (Phase 6 — matches implemented endpoints)

Operator auth: `Authorization: Bearer $ADMIN_TOKEN` on every call below.
Without it every endpoint answers 403 (even in development).

## Intake
- Report button on every rank row → `POST /api/report { stakeId, reason }` → `Report{status: OPEN}` row.
- Rate limit: 10/IP/hr (shared store when Upstash is configured). Valid reports
  always 200 to the reporter (even when rate-limited); malformed JSON → 400.

## Triage (<24h)
1. List the queue:
   `curl -H "Authorization: Bearer $ADMIN_TOKEN" "$APP_URL/api/admin/reports?status=OPEN"`
2. Verify URL vs claim (phishing, trademark, malware).
3. Record the decision (state + operator detail — stakes are never touched):
   `curl -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d '{"status":"TRIAGED","note":"phishing — hiding","reviewedBy":"ops"}' \
     "$APP_URL/api/admin/reports/<id>"`
    Statuses: OPEN, TRIAGED, ACTIONED, DISMISSED (any order accepted today;
    follow OPEN → TRIAGED → ACTIONED | DISMISSED by convention).

## Contain (hide / unlist / restore)
- Hide (phishing/malware/DMCA): removes the listing from tiles, drawers,
  search, boards, table order, and profile (404s); stops /go redirects and
  clears the stored preview. Stakes, payments, and pool/count aggregates are
  preserved untouched.
  `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
    -d '{"state":"HIDDEN","reason":"phishing — <rule>","operator":"ops"}' \
    "$APP_URL/api/admin/startups/<domain>/moderate"`
- Unlist (trademark dispute, low confidence): direct links keep working;
  discovery surfaces exclude it.
  Same call with `{"state":"UNLISTED","reason":"…","operator":"ops"}`.
- Restore: `{"state":"VISIBLE","operator":"ops"}` (reason optional).
- Inspect current state:
  `curl -H "Authorization: Bearer $ADMIN_TOKEN" "$APP_URL/api/admin/startups/<domain>/moderate"`
- Every action writes an `AuditLog{action: PROFILE_MODERATED, actorType: operator}` row.

## Failed deliveries
- A mail that failed keeps `lastError` on its outbox row and an
  `EmailLog{status: "error"}` row with the same `dedupeKey`; retry one delivery
  with the key:
  `curl -X POST -H "Authorization: <admin bearer>" -H 'Content-Type: application/json' \
    -d '{"dedupeKey":"receipt-<paymentId>"}' \
    "$APP_URL/api/admin/outbox/retry"`
- Rows written *before* the R10-1 fix are the exception: a provider refusal was
  reported without failing its row, so such a row reads **completed with
  `attempts = 0` and no `lastError`**, and a retry used to answer
  `409 ALREADY_DONE`. The retry now accepts exactly that row — completed, zero
  attempts, and an `EmailLog{status:"error"}` row for the same key — and refuses
  every other completed row, so it cannot be used to send a delivered mail twice.
- Health: `GET /api/jobs/config` (job auth) returns
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

## Rollback of a bad moderation
- Re-run the moderate call with `VISIBLE`; history is intact by design.
- DB-level restore follows `ops/rollback.md` (Neon branch PITR).

## Comms
- Reporter: no PII back. Owner: exact rule violated + reclaim/refund path.
- Operator detail lives in `Report.note` (+ `reviewedBy/reviewedAt`), not in free-form text.
