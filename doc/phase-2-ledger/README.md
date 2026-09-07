# Phase 2 — Real Ledger (Day 6–9)
### Postgres + Prisma + pricing engine + live APIs

**Goal:** stakes persist, ranks recompute server-side, drawer/stats/activity/board read live data. The $20/$21/$2 canonical case passes as an automated test.

**Why now:** chrome is done and clickable; now it must be *true*. All money logic lands here before touching payment providers.

**Inputs:** ROADMAP §3, §9, §10 · Phase-0 seed file reused verbatim.

**Outputs:**
- Prisma schema + Postgres (Neon/Supabase) + seed script (122 rows)
- `lib/pricing.ts` + rank-recompute transaction
- Route handlers: `/api/elements`, `/elements/:sym`, `/stats`, `/activity`, `/board`, `/search`
- Frontend rewired from mocks → SWR polling (30s)

**Done =**
- [ ] Restart app → stakes survive; takeover/reclaim math green in unit tests
- [ ] Drawer CTA prices come from server (`takeLead`, `joinMin`, `reclaimFor`), never client-computed
- [ ] Double top-up race → single correct leader (transaction test)

**Sub-phases:**
1. `01-schema-seed.md` — Prisma models, indexes, seed
2. `02-pricing-ranks.md` — math lib, recompute, invariant tests
3. `03-read-apis-frontend-wire.md` — endpoints + SWR wiring + cache

**Non-goals:** payments, emails, clicks. Amounts inserted via seed/script only.
