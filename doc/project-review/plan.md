# PeriodicTable comprehensive review and remediation plan

## Problem statement

PeriodicTable has a coherent product concept and a largely consistent visual system, but it is not release-ready. The review found blocking defects in identity ownership, payment atomicity, webhook classification, quote settlement, contested-tile joining, rollback behavior, and database deployment. Several public metrics and search/profile flows also do not implement the documented product rules.

The remediation approach is to contain financial risk first, establish a reproducible schema and ownership model, repair the payment and ledger invariants, then fix API/product contracts, UI accessibility, asynchronous work, operations, and release gates.

## Confirmed product decisions

1. Existing startup profiles use email magic-link management.
2. Checkout may add stake to an existing startup but may not mutate its profile or notification address until the user is verified.
3. A quoted “take #1” price is guaranteed through a short-lived reservation with explicit expiry.
4. The plan covers the full P0-P3 release-readiness backlog, not only launch blockers.
5. Review and planning artifacts remain in the session workspace; repository files change only after approval.

## Review verdict

- **Release recommendation:** do not enable live payments yet.
- **UI technical audit:** 9/20, Poor.
- **Automated gates:** 36 unit tests pass, 3 database tests are skipped; lint and TypeScript/build compilation pass.
- **False-green risk:** the production build emits repeated missing-`DATABASE_URL` Prisma errors while still exiting successfully.
- **Dependency risk:** `npm audit --omit=dev` reports 5 high-severity vulnerable package nodes, including the direct Next.js dependency.
- **Deployment risk:** the runbook calls `prisma migrate deploy`, but the repository contains no Prisma migrations.
- **Live QA evidence:** stored under `files/browser-review/`; it confirms a failed element request is rendered as “unclaimed” and checkout amount edits move focus to the modal close button.

## Detailed artifacts

- `files/review-findings.md` — complete severity-ranked findings, evidence, impact, and recommendations.
- `files/remediation-phases.md` — implementation phases, affected components, migration strategy, and acceptance gates.
- `files/validation-matrix.md` — unit, integration, API, provider, browser, accessibility, performance, and operational coverage.

## Implementation phases

1. **Containment and reproducible baseline**
   - Default all production-sensitive features to fail closed.
   - Patch vulnerable runtime dependencies.
   - Add CI and make missing required production configuration fail explicitly.
   - Create and validate a baseline Prisma migration.

2. **Data model, ownership, and auditability**
   - Add email magic-link management without allowing unverified checkout mutations.
   - Add reservation, waitlist, outbox, and moderation/audit records.
   - Add missing relations, timestamps, enums, uniqueness, and indexes through reviewed migrations.

3. **Payment and webhook correctness**
   - Move idempotency ahead of side effects.
   - Guarantee take-lead quotes with expiring reservations.
   - Atomically transition payment state and apply stake.
   - Whitelist paid webhook events and validate provider references and amounts.
   - Make provider retries resume the correct checkout instead of opening the dev simulator.

4. **Ledger concurrency and pricing invariants**
   - Restore $5 contested-tile joins.
   - Reject all ties deterministically.
   - Serialize per-element recomputation with retryable transactions or database locking.
   - Return the persisted rank and maintain one leader plus correct aggregates under concurrency.

5. **API contracts and product truth**
   - Introduce shared request/response contracts and an error-aware client fetcher.
   - Repair search, stats, Table Order, board tabs, early-adopter data, activity amounts, profile links, and click attribution.
   - Render explicit loading, empty, and failure states without converting failures into business state.

6. **Accessibility, responsive behavior, and interaction integrity**
   - Stabilize modal focus, make background content inert, and scope camera shortcuts.
   - Add persistent form labels and associated validation feedback.
   - Correct failing color contrast, touch targets, toast announcements, mobile legal access, reduced-motion behavior, and table keyboard navigation.

7. **Asynchronous jobs, abuse controls, and operations**
   - Queue preview and email work; keep provider webhooks short and retry-safe.
   - Authenticate all job invocations, bound work per execution, and move rate limits to shared storage.
   - Implement the moderation states and audit trail described by the takedown runbook.
   - Align rollback, seed, environment, and recovery documentation with executable code.

8. **Release qualification**
   - Add database integration, route contract, provider-fixture, browser E2E, accessibility, and migration tests.
   - Prove clean-install deployment, upgrade deployment, rollback, payment-pause, concurrency, and webhook replay behavior.
   - Re-run lint, type checking, tests, production build, dependency audit, UI audit, and bounded desktop/mobile browser QA.

## Release gates

Live payments remain disabled until all of the following are true:

1. No P0 or P1 findings remain open.
2. A payment cannot become `paid` without the corresponding stake being durably applied.
3. Duplicate or out-of-order provider events cannot double-apply, fail a paid stake, or apply an unrelated event.
4. Concurrent joins, takeovers, reclaims, and top-ups preserve one leader, exact pool totals, and deterministic ranks.
5. Existing startup profile data cannot be changed without a verified management session.
6. The clean database migration and existing-data upgrade paths both pass.
7. The documented payment-pause flow stores a real waitlist entry and exposes no active checkout controls.
8. Database integration and browser E2E suites run in CI rather than skip.
9. Production build and startup fail clearly when required production configuration is absent.
10. Production dependency audit has no unaccepted high or critical runtime vulnerabilities.
11. Core flows meet WCAG 2.2 AA for contrast, names, focus, keyboard use, and status announcements.

## Notes and constraints

- Preserve the incumbent visual direction in `doc/DESIGN-SYSTEM.md`; this is a correctness and hardening program, not a redesign.
- Do not rewrite unrelated static element data.
- Migrations must preserve existing stakes, payments, clicks, reports, and email logs.
- Financial state changes require structured logs and durable audit records; notification failures must not roll back or ambiguously fail stake application.
- Every phase adds its own regression coverage rather than postponing all tests to the end.

