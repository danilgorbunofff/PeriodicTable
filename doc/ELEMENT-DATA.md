# Element dataset (122 nodes)

Single source of truth `lib/elements.ts` with all 122 nodes: coordinates,
symbols, masses, families and tiers.

## Schema per row

`{ id, symbol, name, atomicMass, gridRow, gridCol, family, tier }`

- IDs: 1–118 standard, `-1` H̄, `0` Ps, `119` Uue, `999` DM
- Families: `ALKALI_METAL | ALKALINE_EARTH | TRANSITION_METAL | POST_TRANSITION_METAL | METALLOID | REACTIVE_NONMETAL | HALOGEN | NOBLE_GAS | LANTHANIDE | ACTINIDE | EXOTIC_THEORETICAL`
- Tiers: `STANDARD`, `CULTURAL_ELITE` (Au Pt Si C U Ti), `EXOTIC` (4)

## Geometry

- Row 1: H(1,1), He(1,18); Row 2: Li(2,1) Be(2,2) B(2,13) C(2,14) N(2,15) O(2,16) F(2,17) Ne(2,18)
- EXOTIC POD cols 8-11: H̄(-1,c8) Ps(0,c9) Uue(119,c10) DM(999,c11), with the pill tag `🌌 EXOTIC SECTOR · THEORETICAL NODES`
- Row 3: Na(3,1) Mg(3,2) Al(3,13)…Ar(3,18); Rows 4–7 full 1–18
- Row 9 La–Lu cols 4–17 + `★` marker col 3; Row 10 Ac–Lr cols 4–17 + `★` marker col 3
- Atomic masses: IUPAC strings; exotics = `Theoretical`
- Exotic subtitles: H̄ quantum/deep-tech · Ps crypto/ZK · Uue frontier AI · DM security/stealth

## Invariants

- Exactly 122 rows, unique `symbol` + `id`, coordinates with no collisions and `col ≤ 18`
- Exotics live on one contiguous row of the main table (row 2, cols 8–11)
- The pod frame is derived from the served data (`lib/gridGeometry.ts`), never hardcoded
- `prisma/seed.ts` imports `ELEMENTS` from `lib/elements` — there is no second copy of the dataset

These invariants are enforced by `lib/datasetGeometry.test.ts` and
`lib/gridGeometry.ts`.
