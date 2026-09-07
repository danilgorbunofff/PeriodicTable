# 06 — Startup Profile Page (light theme)

**Parent:** Phase 1 README · **Covers:** screenshots 095559, 095612, 095625 · DESIGN-SYSTEM §6
**Route:** `/s/[domain]` — a **different visual system** from the dark stage.

## Objective
`View profile →` on hover preview must land here. This is how worldmap proves status. Mock data in Phase 1; live in Phase 2.

## Spec
- Page bg `#EFF5FC`. Top: `← the table` + wordmark.
- Yellow gradient banner `#FFEFC1 → #FFCE4B`: `✦ OFFICIALLY ON THE TABLE ✦` · `{domain} is on the table` · `{rankTitle} · {n} elements claimed`
- Left: dark rounded frame, mini periodic table with **their** tiles highlighted, hint `drag to pan · scroll to zoom`, badge `{n} elements claimed`
- Right white card: logo, rank pill (e.g. Emperor), domain, pitch, icy stat pills (crowns, first-claims, top-3, present-in, $ staked), **navy** `Visit site ↗` (never yellow), naked URL
- Stat quad: elements · #1 spots · placements · clicks
- `Elements held` 2-col cards: symbol tile, `C Carbon`, `{n} startups bidding`, rank list with **this domain yellow-washed**; `#1` gets a crown, else `#3`
- Bottom yellow bar: `Start your own empire` / `Grab a seat on any element — from $5.` + Claim → home + checkout
- Footer: `Public page · standings are live. Anyone can list any link — a listing doesn’t imply the company added it.`

## Rank titles (simple MVP)
`Claimer` (1) · `Contender` (2–4) · `Emperor` (5+) — or copy worldmap later. Don’t block on naming.

## Acceptance
- [ ] Pixel-close to 095559/612/625: light page, yellow banner, navy visit, yellow-wash rows, empire bar
- [ ] Visit site uses `/go/:stakeId` once Phase 3 exists; mock `target=_blank` until then

## Files
- `app/s/[domain]/page.tsx`, `components/profile/*`
