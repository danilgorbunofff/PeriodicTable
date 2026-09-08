# periodictable.lol — Architecture & Operations Record
### Phase 7 remediation artifact. Code is truth; this file is the map.

Product: King-of-the-Hill staking ads on a 122-tile periodic table.
Visual twins spec: `doc/DESIGN-SYSTEM.md`. Release gates: `doc/project-review/plan.md`.
Executable proof: `scripts/rehearse-release.sh` (live + paused) + `npm test`.

---

## 1. Money flow (the only path that moves dollars)

```
browser → POST /api/checkout → locked quote tx → provider session → pay
   webhook / dev-sim → settlePayment (ONE tx) → outbox rows → drain/worker
```

**Checkout** (`app/api/checkout/route.ts`): guards → validate input → server-derived
identity → idempotency lookup (fingerprint-bound replay) → advisory-locked
quote tx (re-read leaderboard, classify+validate, reservation check, create
startup/payment/[reservation]) → provider session (`providerCheckoutUrl`
stored; 502 retryable on provider failure, never a dead URL).

**Settlement** (`lib/settle.ts`): event-dedupe → pending recheck under an
element advisory lock → reservation consume/expire → `applyStakeTx` (upsert,
deterministic rerank, aggregates, activity, FirstClaim) → paid-transition
(`stakeId` + `appliedAt` + provider audit) → outbox enqueues. Serializable
isolation with bounded retry (`lib/txn.ts`, P2034/40001/40P01 only).

**One payment applies at most one delta**: unique provider-event ids +
under-lock pending recheck + cumulative upserts. Duplicates and replays are
deterministic 2xx; unexpected failures are non-2xx so providers redeliver.

## 2. Ledger invariants (asserted pre-commit, `assertLedgerInvariants`)

- Exactly one leader iff stakes exist; `currentLeaderId` = sole `isLeader`.
- `totalPoolUsd` = Σ stakes; `stakeCount` = row count; ranks gap-free 1..n.
- Rank order total: amount desc → earliest `createdAt` → id (never flips).
- Pricing (`lib/pricing.ts`): $5 floor; contested $5+ joins land below #1;
  ties rejected at checkout (`TIE`); reclaim delta = `(leader+1) − yours`
  floored at $1; takes need the reserved total (`RESERVATION_CONFLICT`
  otherwise). Settlement-order ties (validation races) resolve by createdAt.

## 3. Ownership

Checkout derives identity server-side and never mutates existing profiles
(`findOrCreateCheckoutStartup`). Profile changes require an email magic-link
session (`/api/manage/*` → `PATCH /api/startups/[domain]`). Every mutation
writes `AuditLog`. Unsubscribe is POST-first (RFC 8058); no emails in URLs.

## 4. Reservations (take-lead quotes, P0-05)

Contested takes hold one ACTIVE reservation per element (partial unique
index), 15-min TTL (`RESERVATION_TTL_MS`, overridable for rehearsal),
quoted leader + reserved total stored. Joins below reserve and owner top-ups
pass; anything reaching the reserve conflicts. Expiry is lazy (readers treat
expired as released; writers flip to EXPIRED). Settlement consumes valid
quotes atomically, settles expired ones as ordinary stakes.

## 5. Provider events & webhook contract

Every delivery → `ProviderEvent` (unique `provider:event-id`, outcome
RECEIVED/APPLIED/DUPLICATE/IGNORED/FAILED/ERROR). Paid ONLY on allowlisted
status/event signals; statusless/unrelated → IGNORED (payment untouched);
explicit failures → FAILED (terminal); amount/currency/reference validated
before settling (mismatches → operator-visible ERROR, no retry storm).

## 6. Migrations (all in `prisma/migrations/`)

| Migration | Content |
|---|---|
| `0000_baseline` | Full schema snapshot (empty-DB deploys) |
| `0001_phase1_ownership` | Enums (lowercase labels, USING casts), nullable relational `stakeId`, `Stake.createdAt` + trust-ordered backfill, unsub dedupe, leader repair, report attribution, FirstClaim seed, partial reservation index |
| `0002_phase2_webhook` | `ProviderEvent` table |
| `0003_phase3_activity` | Activity delta/result/payment linkage + backfill |
| `0004_phase6_ops` | `Report.note` |

Rules: additive + reviewed; data repairs precede the constraints they serve;
backfills prefer honest NULLs over guesses; `migrate diff` from history must
stay empty (CI-adjacent check). Rollback: `migrate resolve --rolled-back`
+ Neon PITR branch (`ops/rollback.md`); restore = redeploy + reseed
(idempotent seeds).

## 7. Outbox processing

Financial txs enqueue `RECEIPT_EMAIL / OUTBID_EMAIL / PREVIEW_GENERATE /
STAKE_ANALYTICS` with dedupe keys. Delivery: post-commit inline `drainDue`
(best-effort) + authenticated workers (`/api/jobs/outbox`, `/api/jobs/screenshot`):
atomic `SKIP LOCKED` claims, bounded batches, 20s deadlines, per-target
timeouts, exponential backoff, persisted `lastError`, operator retry at
`POST /api/admin/outbox/retry`. Previews are remote URLs of public listings
(retained until hide clears them); rows keep id + source URL only.

## 8. Abuse controls & moderation

Rate limits (`rateLimitAsync`) share atomic storage via Upstash REST when
configured, memory otherwise (fails open, warns in prod). Client IP:
Cloudflare → Vercel → XFF-leftmost (documented trust). Listing URLs reject
credentials, IPs, localhost/metadata. CSP + hardening headers in
`next.config.mjs` (script-src keeps `unsafe-inline` for Next hydration —
no nonce plumbing yet). Reports → triage states + operator notes; HIDE
removes all surfaces + stops `/go` + clears preview; UNLIST drops discovery
only; financial history is never deleted (`ops/takedown.md` is executable).

## 9. Read APIs (product truth)

Contracts in `lib/api.ts`; `fetchJson` throws structured `ApiError` so
failures render as errors, never business state. Rankings computed
server-side (`lib/boards.ts`): Table Order sums all VISIBLE stakes (tile
pool/count includes hidden spend; leaderboard excludes hidden — money is never
deleted); By Element ranks leader single-stakes; Crowns count-then-spend;
Early Adopter counts FirstClaim medals. Stats report exact units. Search rows
carry destinations. Element-detail failure ≠ unclaimed (explicit error panel).

## 10. Accessibility posture

Modals trap/inert/own-Esc/restore-trigger; checkout is a labeled form with
described errors + live announcements; grid is one tab stop (arrows/Home/End,
Esc to search); small text uses AA `*-ink` tokens (full pastel matrix in
`lib/a11y.test.ts`; browser axe 0-violations required pre-release);
44px coarse targets; reduced-motion kills camera/ping/modal movement; legal
on every viewport. Guarded by `lib/a11y.test.ts`.

## 11. Recovery matrix

| Incident | Control |
|---|---|
| Payments incident | `PAYMENTS_LIVE=false` → 403 waitlist + stored entries (<2min env redeploy) |
| Bad deploy | Vercel rollback; DB via Neon PITR; `migrate resolve` per runbook |
| Bad migration | Mark rolled-back, fix forward, `migrate deploy`; snapshot rehearsal in `scripts/` |
| Provider outage | Checkouts 502 retryable (same key resumes); webhooks redeliver; no dead URLs |
| Webhook storm | Event-id dedupe; terminal states ignore replays |
| Abuse/spam | Report → triage → hide/unlist (runbook), shared rate limits |
| Lost notifications | Outbox rows persist; worker redelivers; operator retry endpoint |
| Key leak (admin/cron) | Rotate env, redeploy; tokens are bearer-only, never logged |

## 12. Environment reference

Required in production (`check-prod-env` fails closed): `DATABASE_URL`,
`WHOP_API_KEY` + `WHOP_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL` (https),
`TURNSTILE_SECRET`, `CLICK_SALT` (private), `CRON_SECRET`, `RESEND_API_KEY`,
`EMAIL_FROM`. Optional: `UPSTASH_REDIS_REST_URL/TOKEN` (shared limits —
without it limits are instance-local memory and fail open with a prod warning),
`ADMIN_TOKEN` (operator endpoints; 403 when unset, even in development), `PAYMENTS_LIVE` +
`NEXT_PUBLIC_PAYMENTS_LIVE` (explicit `"true"` + Whop keys, else waitlist),
`RESERVATION_TTL_MS` (rehearsal only), `NEXT_PUBLIC_PLAUSIBLE_DOMAIN`.
