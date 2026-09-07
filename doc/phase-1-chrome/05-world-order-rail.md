# 05 — World Order Rail (desktop default)

**Parent:** Phase 1 README · **Covers:** screenshot 094055 · DESIGN-SYSTEM §6
**This is not The board modal.** Trophy → modal. This rail is the home right column.

## Objective
Desktop home must never have an empty right side. Mount `Rail` with `state=world-order` on load.

## Spec (match 094055)
- Eyebrow `THE TABLE · LIVE` (11px tracking muted)
- Title: flask/globe icon + **Table Order** (800)
- Gold sub `TOP 10 · MOST SPENT`
- Top-right ⤢
- #1 gold-wash row: 👑, logo, domain, `{n} elements · 👑 {c}`, money right
- #2… scroll: rank, logo, domain, `{n} elements · 👑 {c}`, money
- Footer muted `total staked across every element · click one to stake`
- Click a row → open that startup’s biggest-stake Territory (or profile — pick Territory for MVP)

## Behavior
- Tile click → swap to Territory (03)
- Territory ✕ / Esc → back here
- Mobile: hidden until FAB `Order` or after first tile tap (bottom sheet)

## Acceptance
- [ ] Cold load 1440px: World Order visible without clicking anything
- [ ] Side-by-side with 094055: same hierarchy, gold #1, footer line
- [ ] Switching Territory → Order does not remount stats/hero

## Files
- `components/Rail.tsx`, `components/WorldOrder.tsx`
