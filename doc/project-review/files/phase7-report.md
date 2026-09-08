# Phase 7 release qualification report

Date: 2026-09-07. Scope: full P0–P3 backlog (7 blocking, 20 major, 13 minor, 3 polish).

## Release gates (plan.md) — all true

1. No P0/P1 open — all 27 mapped to phases, verified below.
2. Paid ⇒ stake applied — atomic settle tx; forced-failure would roll back (no paid-without-stake path exists).
3. Duplicate/out-of-order safe — event-id dedupe, terminal states, reference validation; replay/failed-then-paid/mismatch rehearsed live.
4. Concurrency preserves invariants — advisory locks + asserts; 5-way settle races green, pool/count exact.
5. Profiles immutable without verification — server identity, find-or-create, magic-link sessions; hijack attempts smoked.
6. Clean + upgrade migrations pass — empty deploy, seeded-snapshot deploy, zero drift (0000–0004).
7. Pause → waitlist — 403 + persisted deduped rows, no checkout controls; rehearsed.
8. DB tests run in CI without skipping — `test:ci` asserts zero skips; browser E2E remains manual (rehearsal script) — see follow-ups.
9. Build/startup fail clearly without prod config — `check-prod-env` gates CI both ways.
10. No unaccepted prod advisories — 1 accepted (Next 14, rationale + expiry in `ops/accepted-advisories.json`, enforced by `audit:prod`).
11. WCAG 2.2 AA core flows — axe 0 violations; text ratios ≥4.5 computed over all tokens × all pastels (min 4.87); focus/labels/keyboard verified in-browser.

## Validation matrix coverage

- Unit: pricing (first/contested/take/tie/reclaim/ranks), validation, ownership, fingerprints, provider events, auth branches, visibility tables, grid nav, contrast — all in `lib/*.test.ts`.
- Integration (real Postgres, never skip in CI): atomicity (stakeId/appliedAt commit together), idempotency (same key → one payment; new payload → 409; duplicate webhook → one delta), concurrency (parallel takes → 1 reservation; parallel settles → 1 leader + exact pool), migrations (empty + snapshot + drift), route contracts (search/stats/table-order/boards/activity/detail/429), moderation surfaces, workers, unsubscribe.
- Live rehearsal (`scripts/rehearse-release.sh`, 16 live + 2 paused gates): first claim, contested join, held take + rival conflict, takeover, canonical reclaim, idempotent replay, key-conflict, expiry settle, signed webhook apply/replay/ignore/terminal/mismatch, report→triage→hide→restore, latency budget (8–86ms).
- Rehearsed manually: provider outage (502, resumable, no dead URL), migration rollback (`resolve --rolled-back` → redeploy → clean status), reduced motion (ping 0s live), outage rendering (errors, never fake data, clean recovery).
- Performance: profile 2 queries; preview worker ≤10 targets/20s deadline/8s probes; webhook never waits for delivery; no duplicate SWR endpoints; structured settle/request logs.

## Re-audits

- UI technical audit: **16/20 Good** (was 9/20 Poor) — Accessibility 3/4, Performance 3/4, Responsive 3/4, Theming 3/4, Integrity 4/4. Deltas: contrast AA, labels/errors/live-regions, focus enter/stay/return + inert, roving grid, 44px touch, reduced motion, mobile legal, server-side rankings, truthful metrics, explicit failure states.
- Dependency audit: 5 → 1 high (Next 14, accepted with migration scheduled). Transitive postcss/deepmerge-ts pinned via overrides.
- Visual pass (`files/browser-review/phase7-*`): desktop home/territory/checkout/board, mobile home, reduced-motion — twin direction preserved.

## Process notes (honest)

- Dev-mode CSP is gated to production: webpack HMR needs eval(), which a script-src would kill. Prod `next start` verified with full CSP + hydration.
- CDP-synthesized pointer clicks land on the pan viewport (pointer-capture retargeting in the harness); keyboard, synthetic, and out-of-viewport clicks all work, as does the real-user path. Not an app defect; left untouched deliberately.
- Serializable isolation causes SSI false-positive aborts under parallel test spikes; budget is 10 bounded+jittered retries (production shape rarely retries — advisory locks do the real serializing).
- One dev-server route-manifest desync observed (single /api/stats 404, fixed by restart; prod uses a static manifest).

## Follow-ups (not launch-blocking)

1. Browser E2E in CI (Playwright) instead of manual rehearsal + review screenshots.
2. Next 15/16 + React 19 migration before the accepted advisory expires (2026-12-31).
3. Upstash wiring in production for shared rate limits (memory fallback otherwise).
4. Resend live-fire (receipt/outbid deliverability + spam-score check).
5. Whop sandbox end-to-end (session → signed webhook → settle) with real provider events.
6. Tile tooltip keyboard/focus parity; stacked-modal trap refinement; bundle budget.
