# Phase 0 — Foundation (Day 1–2)
### Static navy canvas + 122-tile grid, zero backend

**Goal:** open the app and see the full periodic table on navy — 118 IUPAC + 4 exotics — with correct geometry, white unclaimed tiles, and a few mocked pastel claims. No DB, no checkout, no drawer logic beyond open/close stub.

**Why first:** everything floats over this grid. If geometry, tokens, and tile states are wrong now, every later phase inherits the bug.

**Inputs:** ROADMAP §2, §4, §5 · worldmap.lol screenshots 094055 / 094107 (global canvas).

**Outputs:**
- Next.js 14 + Tailwind + Plus Jakarta Sans shell, tokens locked
- `elements.json` seed (122 rows with row/col/family/tier/mass)
- `PeriodicGrid.tsx` + `Tile.tsx` rendering 18-col + exotic pod + f-block
- 6 mocked claimed tiles (H, C, Au, Si, Fe, DM) to prove pastel + elite + exotic styles

**Done =**
- [ ] Grid matches ROADMAP §4 ASCII on desktop 1440px, no overlap
- [ ] Mobile <768px scrolls horizontally without breaking rows
- [ ] Tokens exactly from DESIGN-SYSTEM: stage `#05070A`, CTA `#FFC93C` + lip `#8F6C17`, icy `#F2F7FC`
- [ ] Table floats ~960px centered; tiles 46–52px; not edge-to-edge
- [ ] `npm run dev` renders in <2s, zero console errors

**Sub-phases:**
1. `01-scaffold-tokens.md` — app shell, Tailwind, font, z-index, layout
2. `02-element-seed-data.md` — 122-row dataset, coords, families, tiers
3. `03-static-grid-tiles.md` — grid component, tile states, responsive

**Explicit non-goals:** drawer content, modals, APIs, payments, emails. Stub them only.
