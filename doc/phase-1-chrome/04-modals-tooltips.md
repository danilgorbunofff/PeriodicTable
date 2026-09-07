# 04 — Modals, Tooltips & Toasts

**Parent:** Phase 1 README · **Covers:** ROADMAP §1.7, §7.5, §7.6

## Objective
One shared modal primitive + 3 content modals (mock) + tile tooltip + toast stub.

## Shared `Modal.tsx`
- Backdrop `bg-slate-900/40 backdrop-blur-sm`, card white `rounded-3xl shadow-2xl max-w-md p-6`, open/close scale+fade 200ms
- Close: ✕ + Esc + backdrop. Focus trap, `aria-modal`, return focus. Mobile: bottom sheet (`rounded-t-3xl, max-h-85vh, swipe-down to close` stub)

## HowItWorks ((i))
Title `How` **claiming** `works` (yellow noun) + flask. Sub `Every element is an open leaderboard, ranked by total stake.` Three **icy** `#F2F7FC` cards with colored icon squares (flag / chart / recycle) + numbered titles — not an emoji wall. Footer disclaimer + chunky `[ Got it ]` + `About & disclaimer · Rules & payments`.

## CheckoutMock (`Stake on X`)
Header `Stake on` **Carbon** (yellow noun) + flag. Reminder muted. Icy segmented tabs `Product URL | @ Social`. Icy URL + icy stake with `$` prefix. Live `👑 $X takes #1 in Carbon!`. Chunky `[ Continue to checkout → ]` → toast in this phase. Whop line; `rules & terms` yellow. `maybe later` centered muted.

## BoardMock (`The board 🏆`)
Title `The` **board** (yellow noun) + trophy. Icy tabs are **three metrics**, not one list: By Element (biggest single-tile $) · #1 Crowns (crown count) · Early Adopter (first-claimer medals). Rows as screenshots 094610 / 095520 / 095541.

## Tooltip + toasts
- Tooltip: follows tile hover, `Symbol Name · #1 $X / Unclaimed · $5`, dark pill `bg-slate-900 text-white text-xs rounded-full px-3 py-1`
- Toasts: `sonner` or stub; messages `Staked! You're #1 in C 🎉` / `Outbid on C — reclaim for $2`

## Acceptance
- [ ] All 3 modals open from hero/drawer icons, close via trinity, no scroll leak behind
- [ ] Checkout live line updates per keystroke; invalid URL shows inline error
