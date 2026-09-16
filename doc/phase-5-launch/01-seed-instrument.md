# 01 — Seed Content & Instrumentation

**Parent:** Phase 5 README · **Covers:** ROADMAP §14 metrics

Status 2026-09-16 (R19-8): the seed half is **implemented and runnable** — the boxes
below describe what `prisma/launch-seed.ts` already does, and they are left unticked
because running it against production is the operator's launch step, not a code
task. The analytics half is **switched off by design** until the domain variable is
set (R19-1, U19-3): the script is consent-gated, so "Plausible live" and the funnel
dashboard are not true until then.

## Seed (dogfood before strangers)
- [ ] 18 seats for six real companies with real domains, logos, pitches — `prisma/launch-seed.ts:45-63`; `seed-list.csv` is the same table, and a test keeps the two from drifting (`lib/launchReadiness.test.ts`)
- [ ] One seat per element, every one at the `$5` floor — so a captured tile quotes exactly `$6` and no tile carries a ladder too tall for that price (`lib/launchInventory.test.ts`)
- [ ] Activity backlog: one row per seat, stamped 1–35h back, no city and no clicks on the row — the feed is non-empty because the seats are
- [ ] Concierge reclaim test: outbid a founder friend, verify email + top-up — operator step, unrun
- [ ] The board says what a seat is: not ownership, not an endorsement, not a payment from the company — one honest sentence on the About page and in the FAQ, plus "every seat is a dollar over its holder" (`lib/legalDocs.ts`, `lib/faqDocs.ts`)
- [ ] Stored logos point at our own proxy, not at the icon service — `npm run db:backfill-logos` (dry run first, then `-- --apply --allow-remote`); rendering does not depend on it (`logoSrc` rewrites legacy URLs on the way out), so it is housekeeping for the *stored* value
- [ ] The live board still matches the price claim — `npm run db:check-board` (read-only, safe against prod, exit 0 = every unpaid seat is inventory at the floor and alone on its tile). **Run this at T-30m, right before the seed step below and again right after it:** a seed can be correct in the repo and wrong in the database, and the operator only finds out from a visitor otherwise (`lib/launchBoard.ts`)
- [ ] Seed policy decided: **seed before announcing** (2026-09-16, `doc/review/19-launch-and-marketing-readiness.md` §9 Q1 → D19-1) — the operator runs `tsx prisma/launch-seed.ts --fresh --allow-remote --confirm=<host>` at T-30m, undo is `npx tsx scripts/clear-launch-inventory.ts` (dry-run first)

## Analytics
- [ ] Plausible pageviews + custom events: `tile_click, drawer_open, search_submit, checkout_start, checkout_paid, reclaim_click, go_click` — the seven events exist and are pinned (`lib/analytics.ts`, `lib/phase5.test.ts:27-31`); **nothing is collected** until `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is set *and* the visitor accepts the notice (R18-13, `lib/analyticsConsent.ts`)
- [ ] Funnel dashboard: `tile_click → drawer_open → checkout_start → paid` + `outbid_sent → open → reclaim_paid` — unbuilt; Plausible's own funnel view over the seven events is the fallback
- [ ] North star widgets: `totalPoolUsd`, colonization `% (staked/122)`, top-10 contested — `/api/stats` and the board serve all three; the Plausible widgets are not built

## Acceptance
- [ ] Fresh visitor sees ≥6 colored tiles incl. 1 exotic + 1 elite + full activity feed — the seeded board satisfies this (§5.5 of `19` records the pre-seed state); verify on the deployed build
- [ ] Events fire in staging (Plausible debug) for all 7 actions — untested, and gated on the same domain variable

## Files
- `prisma/launch-seed.ts`, `lib/analytics.ts`, `doc/phase-5-launch/seed-list.csv`
