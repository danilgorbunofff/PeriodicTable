# 01 — Elite & Exotic Finishes (CSS-Only)

**Parent:** Phase 4 README · **Covers:** ROADMAP §5.2–5.3

## Objective
**Demoted.** Do **not** ship metal/glass/cosmic tiles before launch. Worldmap uses flat pastels. Implementing this file in Phase 4 is a visual regression.

If you open this file during Phase 4: add only a tiny `ELITE` / `EXOTIC` caption on those tiles. Full shaders wait for Phase 6 and a trigger metric.

~~Make Au/Pt/Si/C/U/Ti + 4 exotics visibly premium~~ — parked.

## Specs (Tailwind arbitrary values + 1 inline SVG)
- [ ] Au: `bg-gradient-to-br from-[#fff7cc] via-[#f5c542] to-[#a16207]` + `border-[#d4af37]` + 🪙 top-right + 💎 crown
- [ ] Pt: `bg-gradient-to-br from-white via-[#e2e8f0] to-[#94a3b8]` + ice highlight `ring-1 ring-sky-200` + bottom tag `ELITE RESERVE` (10px tracking-widest slate)
- [ ] Si: iridescent `bg-gradient-to-tr from-sky-200 via-violet-200 to-emerald-200` + circuit SVG overlay opacity 20%
- [ ] C: `bg-[#18181b]` white text + diagonal weave `repeating-linear-gradient` + glass glare `after:` white/10 skewed bar + 💎
- [ ] U: graphite `bg-gradient-to-br from-zinc-700 to-zinc-900` + emerald `☢` + subtle pulse dot (static in MVP ok)
- [ ] Ti: `bg-gradient-to-br from-slate-300 to-slate-500` + 🛡 + matte `saturate-50`
- [ ] H̄: `bg-[#030712]` white type + `ring-2 ring-white/70` gravity ring
- [ ] Ps: violet-cyan border `ring-2 ring-transparent bg-clip-padding` + `shadow-[0_0_12px_#22d3ee]`
- [ ] Uue: `bg-indigo-950` + magenta `ring-2 ring-fuchsia-500`
- [ ] DM: `backdrop-blur-md bg-white/30` over canvas + refracted text `text-slate-800`
- [ ] Pod pill above Row 2 cols 7–10: `🌌 EXOTIC SECTOR · THEORETICAL NODES` (dark pill, white text, centered)

## Acceptance
- [ ] `/debug/tiles` screenshot: elite/exotic distinguishable at 64px without reading text
- [ ] No per-tile images; total CSS <5KB gz for finishes
- [ ] Contrast: white text only on C/U/H̄/Uue; rest slate-900

## Files
- `components/tiles/finishes.ts`, `Tile.tsx` variant switch, `public/tiles/circuit.svg`
