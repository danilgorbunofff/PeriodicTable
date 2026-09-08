# PeriodicTable phased remediation design

## Phase 0 — Contain risk and create a reproducible baseline

### Goals

- Prevent accidental live payment activation.
- Remove known vulnerable runtime versions.
- Make CI and environment failures explicit.
- Establish a deployable schema baseline before functional migrations.

### Changes

1. Change production flag semantics so payments are enabled only by an explicit valid configuration.
2. Add a central server environment parser that distinguishes development, test, preview, and production.
3. Require production values for database, provider key/secret, webhook secret, app URL, Turnstile, click salt, cron secret, and email sender configuration.
4. Upgrade Next.js, Prisma, and affected transitive packages to supported patched versions, with framework migration changes kept separate from business changes.
5. Create a Prisma baseline migration from the current schema.
6. Add CI jobs for install, Prisma generation/validation, lint, type/build, unit tests, database integration tests, and dependency audit.
7. Replace the generic README with exact local setup, database creation, migration, seed, environment, test, build, and runbook instructions.

### Acceptance

- A production process cannot start with partial provider configuration or default-live payments.
- `prisma migrate deploy` builds an empty database matching the application schema.
- CI does not skip database integration tests.
- Production build emits no hidden Prisma configuration errors.
- No unaccepted high/critical runtime advisories remain.

## Phase 1 — Model ownership, reservations, and durable work

### Schema changes

1. Add `Stake.createdAt` and retain `updatedAt`.
2. Replace unconstrained payment `status`, `path`, and `provider` strings with enums or database constraints.
3. Make `Payment.stakeId` nullable and relational; remove the `"pending"` sentinel.
4. Add `Payment.appliedAt`, `failedAt`, `providerCheckoutUrl`, `requestFingerprint`, and provider event audit fields.
5. Add `ClaimReservation`:
   - element relation
   - payment/startup relation
   - quoted leader/version
   - reserved amount
   - expiry
   - active/completed/cancelled status
   - uniqueness preventing overlapping active take reservations per element
6. Add email magic-link management records:
   - hashed one-time token
   - startup relation
   - target email
   - purpose
   - expiry and consumed timestamp
7. Add `WaitlistEntry` with normalized email/domain, source, consent timestamp, and uniqueness policy.
8. Add `OutboxEvent` with type, payload, dedupe key, attempts, next-attempt time, completion time, and failure detail.
9. Add moderation fields or records that support hidden/unlisted state, operator, reason, timestamps, and restoration.
10. Add missing foreign keys for click, report, payment, element, startup, and stake audit records.
11. Make unsubscribe tokens unique and migrate existing values safely.

### Ownership behavior

1. The server derives canonical domain and social identity; it ignores caller-provided canonical identity.
2. A checkout for a new startup may create its initial immutable public profile.
3. A checkout for an existing startup may add stake but may not update URL, title, pitch, link type, logo, or notification email.
4. Profile changes require a verified short-lived email magic-link session.
5. Every mutation writes an audit entry.

### Migration strategy

1. Backfill `Stake.createdAt` from the earliest trustworthy evidence: payment paid time, activity log, startup claim time, then a clearly documented fallback.
2. Backfill payment/stake relations only where the mapping is provable; retain unresolved legacy rows for audit instead of guessing.
3. Create early-adopter records after the timestamp backfill and record confidence/source.
4. Test migration against an empty database and a sanitized production-like snapshot.

## Phase 2 — Rebuild checkout, provider, and webhook correctness

### Checkout transaction

1. Parse and validate a shared request schema.
2. Derive canonical startup identity server-side.
3. Resolve idempotency key before any mutable operation.
4. Compare the stored request fingerprint on retries; reject key reuse with a different payload.
5. For `join`, enforce first-stake minimum `$5`.
6. For `take`, acquire an element lock and create a short-lived reservation for the quoted winning total.
7. Create the pending payment and provider session, storing the provider reference and resumable checkout URL.
8. If provider session creation fails, mark the attempt retryable without changing startup profile data or leaving an unusable dev URL.

### Reservation semantics

1. Reservation duration is explicit and displayed in checkout.
2. Only one active take reservation may own an element quote at a time.
3. Join payments remain allowed if they cannot invalidate the reserved winning total; otherwise the rule is explicit and tested.
4. Expired reservations release automatically and cannot settle as guaranteed takeovers without a new quote.
5. Successful settlement consumes the reservation in the same transaction as stake application.

### Webhook handling

1. Verify the official signature format against raw bytes.
2. Parse only documented event versions.
3. Whitelist successful payment event names and statuses.
4. Validate provider reference, currency, amount, and local payment identity.
5. Record every provider event with a unique event ID and processing outcome.
6. Atomically:
   - claim the event
   - validate/consume reservation when applicable
   - apply stake
   - persist exact rank/leader/aggregates
   - set `Payment.status=paid`, `stakeId`, and `appliedAt`
   - enqueue receipt, outbid, analytics, and preview outbox events
7. Return deterministic 2xx responses for true duplicates and explicit non-2xx responses for retryable failures.

### Dev simulator

1. Use the same payment application service as production.
2. Disable it from one centralized provider-mode decision.
3. Handle non-2xx responses and terminal states in the UI.
4. Align failure copy and retry behavior with the actual state machine.

## Phase 3 — Make ledger invariants concurrency-safe

### Pricing

1. Split validators into:
   - first join
   - ordinary top-up
   - reclaim
   - guaranteed take reservation
2. Accept `$5+` for a new contested-tile join.
3. Reject any resulting tie with another startup.
4. Calculate reclaim from persisted current leader and the startup’s persisted total.
5. Treat incoming payment amount as a delta and expose both delta and resulting total.

### Transaction strategy

1. Lock the `Element` row or take a transaction-scoped advisory lock keyed by element ID.
2. Use serializable isolation where supported and retry only recognized serialization/deadlock failures.
3. Upsert the cumulative stake.
4. Query all element stakes with a deterministic secondary order.
5. Persist ranks and exactly one leader.
6. Recompute pool and count from the same transaction snapshot.
7. Update the element aggregate.
8. Write activity with payment delta, resulting total, and payment ID.
9. Assert invariants before commit.

### Required invariants

- Exactly one leader when at least one stake exists.
- No leader when no stakes exist.
- `totalPoolUsd` equals the sum of persisted stakes.
- `stakeCount` equals the number of persisted stakes.
- `currentLeaderId` matches the sole `isLeader` row.
- Rank sequence is deterministic and gap-free.
- One provider payment applies at most one delta.

## Phase 4 — Repair API contracts and displayed product truth

### Shared API boundary

1. Define shared request/response schemas for search, element summary/detail, stats, activity, board, checkout, report, waitlist, and management links.
2. Introduce `fetchJson` that:
   - rejects non-2xx responses
   - captures structured error codes and request IDs
   - validates response shape
3. Make loading, error, empty, and populated states explicit in every SWR consumer.

### Search

1. Decide startup result destination: preferred active/leading element plus profile URL.
2. Return all fields the client renders.
3. Keep option indices consistent after deduplication.
4. Add loading and failure rows without retaining misleading previous data.

### Metrics

1. Stats:
   - total elements
   - claimed elements
   - unclaimed elements
   - stake/payment count
   - total staked USD
2. Table Order:
   - total cumulative spend across every startup stake
   - crown count
   - deterministic tie-break
3. Board:
   - By Element ranks leader single-stake totals
   - Crowns ranks crown count then cumulative spend
   - Early Adopter ranks first-claim medals from immutable claim data
4. Activity:
   - payment delta
   - resulting stake total
   - stable activity ID
   - truthful kind

### Profiles and outbound clicks

1. Fetch profile and all held-element boards in bounded queries.
2. Reuse canonical periodic-grid coordinates for the compact profile visual.
3. Route “Visit site” through a real stake redirect and preserve `Startup.url`.
4. Separate “View profile”, “Visit site”, and “Report” actions; do not nest controls.
5. Resolve the docs conflict by making profile navigation explicit and click attribution explicit rather than overloading the row.
6. Add profile metadata and sitemap policy.

## Phase 5 — Accessibility and responsive hardening

### Modal and focus behavior

1. Keep the close callback in a ref or otherwise prevent effect teardown on every render.
2. Make the application background inert and hidden from assistive technology while a modal is open.
3. Restore the exact triggering control on close.
4. Scope Escape handling to one overlay stack.
5. Disable camera keyboard handling while an overlay or non-camera interactive control owns focus.

### Forms

1. Use a semantic form with submit handling.
2. Add visible labels for URL/handle, startup name, pitch, email, and amount.
3. Connect help/error text with `aria-describedby`.
4. Set `aria-invalid`, required state, and field-specific server errors.
5. Preserve focus after value changes and price updates.
6. Announce provider/network/price movement states.

### Visual accessibility

1. Replace failing muted/money/live/sale text combinations with AA-compliant tokens.
2. Keep non-text decorative colors if desired, but do not use them as small-text foregrounds without sufficient contrast.
3. Increase touch controls to at least 44x44px on touch layouts.
4. Add a polite toast/status live region.
5. Respect reduced motion for camera transitions, ping animation, and all nonessential movement.
6. Expose legal/rules links on mobile and make checkout terms a real link.

### Table navigation

1. Implement `role=grid` semantics where appropriate.
2. Use roving tabindex so the table contributes one tab stop.
3. Support arrow movement, Home/End where useful, Enter/Space activation, and a documented way back to chrome.
4. Preserve custom pan/zoom while allowing browser-level accessibility zoom.

## Phase 6 — Move slow work and abuse controls out of request paths

### Outbox workers

1. Process receipt/outbid email, preview generation, and analytics from durable outbox rows.
2. Give every delivery a dedupe key and bounded exponential retry.
3. Store terminal failure detail and expose an operator retry path.

### Preview worker

1. Authenticate all invocations.
2. Claim a small batch atomically.
3. Apply per-target timeouts and global invocation deadline.
4. Persist retry count and next-attempt timestamp.
5. Store or reference the preview according to an explicit retention/privacy policy.

### Shared abuse controls

1. Move rate limiting to Redis/Upstash or equivalent atomic shared storage.
2. Use trusted platform client-IP extraction.
3. Require production Turnstile and private salts.
4. Expand URL/domain validation to reject credentials, disallowed IP/private targets, malformed hosts, and policy-blocked destinations.
5. Add security headers and an explicit CSP compatible with fonts, analytics, Turnstile, images, and provider navigation.

### Moderation

1. Store report processing state and detail.
2. Hide/unlist without deleting financial history.
3. Audit operator and timestamps.
4. Make the takedown runbook commands match the implemented model.

## Phase 7 — Release qualification and documentation

1. Run the validation matrix in `validation-matrix.md`.
2. Replace scaffold README content with real project instructions.
3. Document architecture, invariants, ownership, provider events, reservations, migrations, outbox processing, and recovery.
4. Rehearse:
   - payment pause and waitlist
   - expired reservation
   - duplicate/out-of-order webhooks
   - provider outage
   - database serialization retry
   - migration rollback/restore
   - moderation hide/restore
5. Run a bounded visual/browser pass at desktop, tablet, and mobile with normal and reduced motion.
6. Re-run the UI technical audit and dependency audit.

