# 01 — Scaffold & Design Tokens

**Parent:** Phase 0 README · **Covers:** ROADMAP §1.8, §6

## Objective
Bare Next.js 14 App Router shell with Tailwind, Plus Jakarta Sans, **near-black stage**, and floating-card primitives. Tokens come from `/doc/DESIGN-SYSTEM.md` — not the old `#0e1b2e` / `#fab828` guesses.

## Tasks
- [x] `npx create-next-app@14` (TS, App Router, no src/ split) + Tailwind — done, scaffold promoted to root as `periodictable-lol`
- [x] `next/font`: Plus Jakarta Sans 400/600/700/800 — done in `app/layout.tsx`
- [x] `tailwind.config`: DESIGN-SYSTEM §2 tokens (`stage #05070A`, `cta #FFC93C`, `ctaLip #8F6C17`, `icy #F2F7FC`, `money #C8892A`, `muted #8497AE`, `live #59C794`, `profileBg #EFF5FC`)
- [x] Radius/shadow + `ChunkyButton` 4px lip + `IconBtn` + `IcyInput` + `Card`
- [x] `app/page.tsx`: `bg-stage`, no desktop scroll, floating table shell ~960px
- [x] z-index CSS vars in `globals.css`
- [x] `npm run build` passes

## Acceptance
- [ ] Tokens compile; sample card on navy matches screenshot tone at a glance
- [ ] Desktop has no body scroll; mobile allows horizontal grid scroll only
- [ ] `npm run build` passes

## Pitfalls
- Don't invent extra colors. Don't use shadcn defaults (gray borders, ghost buttons).
- Don't add a navbar. Hero card IS the header.
- Yellow is only for claim/stake. Search submit is navy. Visit site (later) is navy.
