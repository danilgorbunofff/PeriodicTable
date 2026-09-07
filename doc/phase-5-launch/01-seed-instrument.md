# 01 — Seed Content & Instrumentation

**Parent:** Phase 5 README · **Covers:** ROADMAP §14 metrics

## Seed (dogfood before strangers)
- [ ] 8–12 friendly startups: Au (fintech), C (devtool), Si (chip/AI), Pt (infra), DM (security), H + He + Fe + O for breadth; use REAL domains + logos + 1-line pitches
- [ ] Contested demo: C with 3 stakes ($50/$24/$9) so drawer ladder + reclaim path visible on day 1
- [ ] Activity backlog: 6 rows over past 72h (varied cities) so feed isn't empty
- [ ] Concierge reclaim test: outbid a founder friend, verify email + top-up

## Analytics
- [ ] Plausible pageviews + custom events: `tile_click, drawer_open, search_submit, checkout_start, checkout_paid, reclaim_click, go_click`
- [ ] Funnel dashboard: `tile_click → drawer_open → checkout_start → paid` + `outbid_sent → open → reclaim_paid`
- [ ] North star widgets: `totalPoolUsd`, colonization `% (staked/122)`, top-10 contested

## Acceptance
- [ ] Fresh visitor sees ≥6 colored tiles incl. 1 exotic + 1 elite + full activity feed
- [ ] Events fire in staging (Plausible debug) for all 7 actions

## Files
- `prisma/launch-seed.ts`, `lib/analytics.ts`, `doc/phase-5-launch/seed-list.csv`
