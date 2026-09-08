# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary users are startup founders seeking visibility and status by claiming or competing for a territory. Visitors discovering ranked startups are a secondary audience.

## Product Purpose

PeriodicTable.lol turns the periodic table into a public startup territory map. Founders stake money on an element, compete by cumulative stake, and receive visible placement, profile exposure, and tracked outbound clicks. Success means a founder can quickly understand a territory's status, claim or improve a position, and see their startup represented on the table.

## Positioning

The product combines a recognizable periodic-table map with open, cumulative startup leaderboards. Every element is a persistent competitive territory rather than a conventional ad slot. Exotic elements are rare premium territories worth competing for.

## Operating Context

Users browse and pan the table, inspect elements, compare bidders, search for startups or territories, open public startup profiles, and enter a checkout flow to claim or improve a rank. The interface must support desktop and mobile web layouts.

## Capabilities and Constraints

- Element tiles expose claim state, leading price, and the current leader's identity.
- Selected territories show ranked bidders and the next amount required to take the lead.
- Exotic territories are Hbar, Ps, Uue, and DM; they retain the same bidding and selection behavior as standard elements.
- Payment, ranking, reporting, profile, keyboard-navigation, and reduced-motion behavior must remain intact when visual presentation changes.
- Product terminology includes claim, territory, bidding, stake, rank, and exotic.

## Brand Commitments

- Product name: `periodictable.lol`.
- Voice is concise, playful, competitive, and factual.
- The periodic-table metaphor and element symbols are core product assets.
- The established interface uses a near-black space stage, floating porcelain table, white corner chrome, and chunky honey-colored money actions.

## Evidence on Hand

- Product and interaction requirements: `doc/ROADMAP.md`
- Current visual authority: `doc/DESIGN-SYSTEM.md`
- Exotic category definitions: `doc/phase-0-foundation/02-element-seed-data.md`
- Current exotic capsule and tile implementation: `components/PeriodicGrid.tsx`, `components/Tile.tsx`, and `app/globals.css`
- No testimonials, customer claims, or performance benchmarks are available and none should be fabricated.

## Product Principles

- Make claiming and rank competition immediately understandable.
- Preserve honest live state instead of presenting decorative or simulated ownership.
- Make premium territories feel scarce and desirable without obscuring their function.
- Keep the table readable as a single navigable object at every supported viewport.
- Preserve accessibility and motion preferences as first-class product behavior.

## Accessibility & Inclusion

Interactive tiles must remain keyboard accessible and retain descriptive accessible names. The interface must preserve readable contrast, usable touch targets, and a static but fully legible presentation when `prefers-reduced-motion` is enabled.
