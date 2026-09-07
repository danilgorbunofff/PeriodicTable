# 02 — Element Seed Data (122 Nodes)

**Parent:** Phase 0 README · **Covers:** ROADMAP §4

## Objective
Single source of truth `lib/elements.ts` (or `elements.json`) with all 122 nodes: coords, symbols, masses, families, tiers.

## Schema per row
`{ id, symbol, name, atomicMass, gridRow, gridCol, family, tier }`
- IDs: 1–118 standard, `-1` H̄, `0` Ps, `119` Uue, `999` DM
- Families: `ALKALI_METAL | ALKALINE_EARTH | TRANSITION_METAL | POST_TRANSITION_METAL | METALLOID | REACTIVE_NONMETAL | HALOGEN | NOBLE_GAS | LANTHANIDE | ACTINIDE | EXOTIC_THEORETICAL`
- Tiers: `STANDARD`, `CULTURAL_ELITE` (Au Pt Si C U Ti), `EXOTIC` (4)

## Geometry checklist
- [ ] Row 1: H(1,1), He(1,18); Row 2: Li(2,1) Be(2,2) B(2,13) C(2,14) N(2,15) O(2,16) F(2,17) Ne(2,18)
- [ ] Exotic pod Row 2 cols 7–10: H̄(−1) Ps(0) Uue(119) DM(999) + pill tag `🌌 EXOTIC SECTOR · THEORETICAL NODES`
- [ ] Row 3: Na(3,1) Mg(3,2) Al(3,13)…Ar(3,18); Rows 4–7 full 1–18
- [ ] Row 9 La–Lu cols 4–17 + `★` marker col 3; Row 10 Ac–Lr cols 4–17 + `★` marker col 3
- [ ] Atomic masses: IUPAC strings; exotics = `Theoretical`
- [ ] Exotic subtitles: H̄ quantum/deep-tech · Ps crypto/ZK · Uue frontier AI · DM security/stealth

## Acceptance
- [ ] Exactly 122 rows, unique `symbol` + `id`, script validates coords (no collisions, cols ≤18)
- [ ] Vitest/Jest seed test: count=122, exotics at (2,7–10), f-block offsets correct

## Output
- `lib/elements.ts` + `prisma/seed-data.json` (reused by Phase 2 DB seed verbatim)
