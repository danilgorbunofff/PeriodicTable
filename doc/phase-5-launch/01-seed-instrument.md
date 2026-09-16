# 01 — Seed Content & Instrumentation

**Parent:** Phase 5 README · **Covers:** ROADMAP §14 metrics

Status 2026-09-16 (R19-8): the seed half is **implemented and runnable** — the boxes
below describe what `prisma/launch-seed.ts` already does, and they are left unticked
because running it against production is the operator's launch step, not a code
task. The analytics half is **switched off by design** until the domain variable is
set (R19-1, U19-3): the script is consent-gated, so "Plausible live" and the funnel
dashboard are not true until then.

## Seed (dogfood before strangers)
- [ ] 12 startup stakes across 10 marquee elements, real companies with real domains, logos, pitches — `prisma/launch-seed.ts:40-53`; `seed-list.csv` is the same table, and a test keeps the two from drifting (`lib/launchReadiness.test.ts`)
- [ ] Contested ladder on C ($50 Stripe / $24 Adyen / $9 Square) so the drawer's ladder and the reclaim path are visible on day 1 — the same three rows
- [ ] Activity backlog: one row per seeded stake, stamped 1–50h back, cities on the row — the feed is non-empty because the stakes are
- [ ] Concierge reclaim test: outbid a founder friend, verify email + top-up — operator step, unrun
- [ ] Seeded rows are labelled `demo` on every surface and retire the label the moment a real payment exists — done in batch 4 (R16-9, `lib/demoLabels.ts`), and the About page admits these rows were never paid for
- [ ] Seed policy decided: **seed before announcing** (2026-09-16, `doc/review/19-launch-and-marketing-readiness.md` §9 Q1 → D19-1) — the operator runs `tsx prisma/launch-seed.ts` at T-30m, undo is `npx tsx scripts/clear-demo-data.ts` (dry-run first)

## Analytics
- [ ] Plausible pageviews + custom events: `tile_click, drawer_open, search_submit, checkout_start, checkout_paid, reclaim_click, go_click` — the seven events exist and are pinned (`lib/analytics.ts`, `lib/phase5.test.ts:27-31`); **nothing is collected** until `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is set *and* the visitor accepts the notice (R18-13, `lib/analyticsConsent.ts`)
- [ ] Funnel dashboard: `tile_click → drawer_open → checkout_start → paid` + `outbid_sent → open → reclaim_paid` — unbuilt; Plausible's own funnel view over the seven events is the fallback
- [ ] North star widgets: `totalPoolUsd`, colonization `% (staked/122)`, top-10 contested — `/api/stats` and the board serve all three; the Plausible widgets are not built

## Acceptance
- [ ] Fresh visitor sees ≥6 colored tiles incl. 1 exotic + 1 elite + full activity feed — the seeded board satisfies this (§5.5 of `19` records the pre-seed state); verify on the deployed build
- [ ] Events fire in staging (Plausible debug) for all 7 actions — untested, and gated on the same domain variable

## Files
- `prisma/launch-seed.ts`, `lib/analytics.ts`, `doc/phase-5-launch/seed-list.csv`
