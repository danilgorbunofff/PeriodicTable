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
- Terminal outbox failures keep `lastError` on the row. Retry one delivery:
  `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
    -d '{"dedupeKey":"receipt-<paymentId>"}' \
    "$APP_URL/api/admin/outbox/retry"`

## Rollback of a bad moderation
- Re-run the moderate call with `VISIBLE`; history is intact by design.
- DB-level restore follows `ops/rollback.md` (Neon branch PITR).

## Comms
- Reporter: no PII back. Owner: exact rule violated + reclaim/refund path.
- Operator detail lives in `Report.note` (+ `reviewedBy/reviewedAt`), not in free-form text.
