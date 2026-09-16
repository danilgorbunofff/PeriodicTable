# Phase 5 — Launch (Day 17–18)
### Seed, instrument, gate, ship

**Goal:** launch with a table that already looks alive, every dollar flow proven on prod, and a one-flag rollback. **The seeding half of that goal is decided: seed before announcing** (2026-09-16, `doc/review/19-launch-and-marketing-readiness.md` §9 Q1 → D19-1), which is what makes "already looks alive" a claim the product can stand behind — every seeded row is operator inventory the About page names as such, beatable for the same $6 as any other tile (the `demo` label R16-9 asked for was removed 2026-09-16: a seat nobody bought is now described, not badged).

**Inputs:** all prior phases · ROADMAP §8, §14.

**Outputs:**
- 18 seats for six real companies — one per element, all at the $5 floor (`prisma/launch-seed.ts`, `seed-list.csv`, allowlist in `lib/launchInventory.ts`)
- Plausible + custom funnel events — consent-gated and **off** until `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is set (R19-1, U19-3)
- Launch gate checklist + rollback runbook + takedown playbook

**Done =** the criteria are ticked at T-0 against production; `doc/review/19-launch-and-marketing-readiness.md` §8 tracks them line by line with a GO/NO-GO each.
- [ ] Prod $5/$51/$2 pass with real webhooks (keep or refund founders) — unproven; the $1 smoke is the first real charge (`doc/PROD-READINESS-CHECKLIST.md` §7)
- [ ] Outbid email <60s with exact price; stats/board/activity live — the flow is implemented and covered; production receipt is unproven
- [ ] `PAYMENTS_LIVE=false` flips checkout to waitlist in <2min — the *off* half is verified on production; the *on* half is the $1 smoke (`ops/rollback.md:30-33`)

**Sub-phases:**
1. `01-seed-instrument.md` — dogfood stakes, activity backlog, analytics
2. `02-launch-gate-runbook.md` — gate, deploy, rollback, takedown, comms
3. `03-launch-week-questions.md` — what only launch week can answer, and the query that answers each (R20-12); opened *after* T-0, and the one to read on day 7
