# Phase 5 — Launch (Day 17–18)
### Seed, instrument, gate, ship

**Goal:** launch with a table that already looks alive, every dollar flow proven on prod, and a one-flag rollback. **The seeding half of that goal is decided: seed before announcing** (2026-09-16, `doc/review/19-launch-and-marketing-readiness.md` §9 Q1 → D19-1), which is what makes "already looks alive" a claim the product can stand behind — the seeded rows are labelled `demo` until a real payment replaces them (R16-9).

**Inputs:** all prior phases · ROADMAP §8, §14.

**Outputs:**
- 12 seeded stakes for real companies across marquee elements, labelled as placeholders (`prisma/launch-seed.ts`, `seed-list.csv`)
- Plausible + custom funnel events — consent-gated and **off** until `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is set (R19-1, U19-3)
- Launch gate checklist + rollback runbook + takedown playbook

**Done =** the criteria are ticked at T-0 against production; `doc/review/19-launch-and-marketing-readiness.md` §8 tracks them line by line with a GO/NO-GO each.
- [ ] Prod $5/$51/$2 pass with real webhooks (keep or refund founders) — unproven; the $1 smoke is the first real charge (`doc/PROD-READINESS-CHECKLIST.md` §7)
- [ ] Outbid email <60s with exact price; stats/board/activity live — the flow is implemented and covered; production receipt is unproven
- [ ] `PAYMENTS_LIVE=false` flips checkout to waitlist in <2min — the *off* half is verified on production; the *on* half is the $1 smoke (`ops/rollback.md:30-33`)

**Sub-phases:**
1. `01-seed-instrument.md` — dogfood stakes, activity backlog, analytics
2. `02-launch-gate-runbook.md` — gate, deploy, rollback, takedown, comms
