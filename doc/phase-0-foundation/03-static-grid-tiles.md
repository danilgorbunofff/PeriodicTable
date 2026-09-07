# 03 — Static Grid & Tile States

**Parent:** Phase 0 README · **Covers:** ROADMAP §1.5, §5

## Objective
Render the whole table with `PeriodicGrid.tsx` + `Tile.tsx` from seed data + local mock claims. Prove all 4 tile lifecycles visually.

## Tasks
- [ ] `PeriodicGrid`: CSS grid `grid-cols-18`, gap `6px`, tile **46–52px**, board **~960px** centered on the stage with dark margin; empty skyline cells = transparent spacers (not white tiles). The board must read as one floating object (radius + soft shadow), not a spreadsheet.
- [ ] `Tile` props: `{ symbol, number, price, state, family, tier, logoUrl?, crown? }`; tile is a `<button>` (a11y, keyboard focus ring)
- [ ] State 1 unclaimed: `#fff` bg, `#e2e8f0` hairline, slate number/symbol/`$5`
- [ ] State 2 claimed standard: pastel family fill (§5.2 map) + logo pin + ticker + 👑 if contested
- [ ] Elite / exotic in this phase: **same porcelain + pastel as everyone else** + optional tiny `ELITE` / `EXOTIC` caption. No metal, glass, or cosmic shaders (Phase 6 only).
- [ ] Hover: `scale-105 shadow-lg cursor-pointer` + tooltip (`Symbol Name · #1 $X` or `Unclaimed · $5`)
- [ ] Mock claims: H + Fe standard pastels, C obsidian elite, Au gold elite, Si wafer elite, DM frosted exotic (rest white)
- [ ] Pan/zoom stub: wrapper `transform` state + `+/−/reset` buttons (real autopan logic lands in Phase 1)

## Acceptance
- [ ] 122 tiles render, exotics centered under pill tag, f-block ★ rows linked
- [ ] Zoom out still readable; hover lift works; no layout shift on hover
- [ ] Storybook or `/debug/tiles` page shows all 4 states side by side

## Pitfalls
- No `<canvas>` element — CSS grid buttons only (SEO + a11y).
- Animate nothing beyond hover in this phase.
