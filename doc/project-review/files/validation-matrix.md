# PeriodicTable validation matrix

## Unit coverage

### Pricing

- Empty element first join at $5 succeeds.
- Empty element first join below $5 fails.
- Contested element new join at $5 lands below the leader.
- Guaranteed take requires exactly the reserved winning total or more.
- Existing top-up of $1 succeeds when it does not create an invalid tie.
- Existing top-up that ties another leader fails.
- Canonical reclaim delta is correct.
- Rank order is deterministic for every allowed input.

### Validation and ownership

- Product URL normalization derives one canonical domain.
- Caller-provided domain cannot override server-derived identity.
- Social handle normalization round-trips client/server.
- Existing profile fields remain unchanged without management verification.
- Magic-link token is hashed, expires, is single-use, and is purpose-bound.
- URL credentials/private targets/blocked domains are rejected.

### Provider events

- Only whitelisted paid event fixtures are accepted.
- Failed, pending, refunded, unrelated, malformed, and statusless events do not apply stake.
- Signature verification handles the provider’s exact header format.
- Amount, currency, provider reference, and payment ID mismatches fail safely.

## Database integration coverage

Run against a real disposable Postgres database in CI; these tests must not skip.

### Atomicity

- Forced failure during stake application leaves payment un-applied and retryable.
- Forced failure after outbox insertion rolls back the entire financial transaction.
- Email/preview worker failure does not roll back a paid stake.
- `Payment.stakeId`, status, and applied timestamp commit with the stake.

### Idempotency

- Two simultaneous checkout requests with the same key produce one payment/session.
- Same key plus different payload returns a conflict.
- Duplicate paid webhook applies one delta.
- Out-of-order failed then paid events follow the defined state machine.
- Duplicate outbox deliveries do not duplicate email or preview work.

### Concurrency

- Two startups joining one empty element concurrently preserve exact pool/count and one leader.
- Two concurrent take attempts produce one active reservation.
- Concurrent top-ups for different startups preserve all deltas.
- Concurrent top-ups for the same startup preserve all deltas.
- Reclaim racing a new takeover follows the reservation rule.
- Serialization/deadlock retry is bounded and observable.

### Migrations

- Baseline migration creates an empty working database.
- Upgrade migration preserves a production-like fixture.
- Stake creation times and early-adopter records backfill deterministically.
- Legacy unresolved payment/stake mappings remain auditable.
- Rollback/restore rehearsal matches the runbook.

## Route contract coverage

### Checkout

- Product and social modes accept valid canonical input.
- Existing unverified startup cannot be mutated.
- Paused payments return a waitlist response and no provider session.
- Reservation conflicts and expiries return stable machine-readable errors.
- Idempotent retry returns the original provider URL.

### Read APIs

- Element summary/detail schema matches the shared client contract.
- Element detail distinguishes error, empty, and populated state.
- Search startup result contains valid destination, symbol/profile data, logo, and amount.
- Stats units and values match database fixtures.
- Table Order sums all startup stakes.
- Board tabs implement their three distinct metrics.
- Activity exposes stable ID, delta, resulting total, and truthful kind.

### Jobs and moderation

- Production job endpoints reject missing/invalid authentication for every body shape.
- Worker batch size and deadline are bounded.
- Report UI only confirms a persisted report.
- Hide/unhide preserves financial history and public visibility rules.

## Browser E2E coverage

Run at desktop and mobile sizes.

### Money flows

- First claim at $5.
- Contested join at $5.
- Guaranteed take reservation and settlement.
- Expired reservation refresh.
- Reclaim using prior cumulative stake.
- Social checkout.
- Provider decline and retry.
- Duplicate browser submit.
- Payment paused to persisted waitlist.

### Discovery and public surfaces

- Search by element.
- Search by startup and open its intended destination.
- Open claimed and unclaimed territory states.
- Table Order ranking.
- All three board tabs.
- Profile “Visit site” click increments the correct stake.
- Activity reflects the actual payment delta.
- API outage shows an error, never an unclaimed or zero-data state.

### Accessibility

- Modal focus enters once, remains in the edited field, and returns to the trigger.
- Background controls are inert while modal is open.
- Every checkout field has a visible accessible label and associated errors.
- Toasts and async errors are announced.
- Table roving focus and arrow navigation work.
- Camera shortcuts do not run in modals or other controls.
- Contrast meets WCAG 2.2 AA.
- Touch targets meet the 44px target.
- Reduced-motion mode removes nonessential camera/ping/modal motion.
- Mobile users can reach legal, rules, contact, and privacy information.

## Performance and reliability coverage

- Profile query count remains bounded regardless of held-element count.
- Preview worker never exceeds configured batch/deadline.
- Webhook response does not wait for email or screenshot delivery.
- Main read APIs meet a documented latency budget on a production-size fixture.
- SWR polling does not duplicate equivalent requests.
- Provider/database/job failures emit structured logs with request, payment, event, and element identifiers.

## Final release commands and checks

Use the repository’s final scripts after implementation; add only the missing database/E2E tooling required by this plan.

1. Clean install from lockfile.
2. Prisma format, validate, generate, and migrate an empty database.
3. Run unit and non-skipping database integration tests.
4. Run route/provider contract tests.
5. Run browser E2E and accessibility checks.
6. Run lint and TypeScript/production build with valid production-like environment.
7. Run dependency audit and document any accepted advisory.
8. Run bounded desktop/mobile live QA and compare core screens against the incumbent design references.
9. Rehearse payment pause, provider outage, migration recovery, and takedown operations.

