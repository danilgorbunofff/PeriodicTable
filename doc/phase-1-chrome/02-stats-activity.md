# 02 — Stats Card & Live Activity

**Parent:** Phase 1 README · **Covers:** ROADMAP §1.3, §1.4, §7.2, §7.3

## Objective
Top-right social proof + bottom-left FOMO engine, both on mock data with tick simulation.

## Stats card
- Fixed top-right `rounded-2xl shadow-xl px-4 py-3 text-sm`, 3 rows: `🧪 122 elements live` / `💰 $1,397 in bids` / `{n} unclaimed · from $5`
- **Do not** ship `on sale · $3` until a sale rule exists (REVIEW.md §3).
- Props `{ elementsLive, totalBids, onSale }`; formats `$` with commas
- Mock tick: +$1–7 every 20s to prove optimistic update path (remove in Phase 2, replace with SWR poll)

## Activity card
- Fixed bottom-left `w-[300px] p-4 rounded-3xl shadow-2xl`
- Header: `🟢 Live activity` + rotating geo line (`Someone in {Prague,Singapore,São Paulo} is online`, rotate 5s fade)
- Feed rows (max 4): favicon 20px + `domain.com  $7(gold bold)` + sub `#1 in C Carbon · 1d ago` (muted 12px)
- Footer: `409 visitors · 72h   8 watching` (visitors static mock, watching ±1 tick)
- Relative time helper `relTime(ts)` — reused by drawer/board later

## Acceptance
- [ ] Cards never overlap drawer on 1280px; activity collapses to FAB under 768px (expand on tap)
- [ ] Feed row click → opens that element's drawer (deep-link proof)
- [ ] No websockets; `setInterval` ticks only

## Files
- `components/StatsCard.tsx`, `components/ActivityCard.tsx`, `lib/relTime.ts`, `mocks/activity.json`
