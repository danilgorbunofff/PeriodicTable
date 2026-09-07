# 03 — Right Rail: Territory Inspector

**Parent:** Phase 1 README · **Covers:** ROADMAP §1.6, §7.4, DESIGN-SYSTEM §6 · **Priority: highest in Phase 1**
**Depends on:** `05-world-order-rail.md` (same shell; this file is the Territory state)

## Objective
Territory conversion surface. Same persistent rail as World Order. Tile click swaps content to UNCLAIMED / CLAIMED. Never `translate-x-full` on desktop home.

## Shell
- `Rail.tsx`: fixed right, ~400px, white, large radius, `shadow-card`. Always mounted on desktop.
- Header actions: ⤢ expand + ✕ (✕ returns to World Order, does not unmount the rail)
- Autopan: if `gridCol >= 15`, table `translateX(-120px)` while Territory is showing
- Sticky bottom CTA (`sticky bottom-0 bg-white pt-2`)
- **No** “or join from $5” secondary link

## UnclaimedView
Eyebrow `UNCLAIMED TERRITORY` (tracking-widest muted 11px) → `C Carbon` (symbol 800 32px + name) → sub `BE THE FIRST · $5` → cream card `? No bids yet — plant your flag for $5. Yours until someone outbids you.` → CTA `[ Be the first — from $5 ]` → micro `plant your flag · rank is your total stake`

## ClaimedView
Header `CLAIMED TERRITORY` → `C Carbon` → gold sub `10 bidding · #1 pays $50` → #1 gold-wash row (`bg-[#FFF5DB]`, 👑 only) + logo + domain + pitch 1 line + money `#C8892A` → quiet #2…#N → sticky chunky `[ Claim a spot — for $51 ]` → micro `rank is your total stake · top up to climb`. Clicks belong on the **hover preview**, not as a loud badge on every #1 row.

## HoverPreview
- On row hover (debounce 150ms): floating card left of rail `w-64`: 16:9 screenshot or `loading preview…`, full pitch, chain + gold URL, green clicks, **`View profile →`** (routes to `/s/[domain]`). Hidden on touch (tap row → expand inline).

## Acceptance
- [ ] Both views render from `mocks/drawer.json` (1 unclaimed + 1 contested 3-row)
- [ ] Autopan verified on He/Ne/Ar (col 18) screenshots
- [ ] Playwright stub: open/close/Esc/backdrop covered (real assertions in Phase 4)

## Files
- `components/Drawer.tsx`, `UnclaimedView.tsx`, `ClaimedView.tsx`, `RankRow.tsx`, `HoverPreview.tsx`
