# 01 — Prisma Schema & Seed

**Parent:** Phase 2 README · **Covers:** ROADMAP §9

## Objective
Durable ledger: `Element, Startup, Stake, Payment(stub), ActivityLog, ClickEvent(stub)`.

## Tasks
- [ ] Add `prisma/schema.prisma` exactly per ROADMAP §9 (Element ids incl. −1/0/119/999; Stake `@@unique([elementId,startupId])`; indexes on `(elementId, amountUsd desc)`, `ActivityLog.createdAt desc`)
- [ ] `prisma/seed.ts`: upsert 122 elements from Phase-0 `seed-data.json` + 6 demo stakes (C contested 3-way, Au 1, DM 1) + activity rows
- [ ] Env: `DATABASE_URL` (Neon/Supabase pooled) + `DIRECT_URL` if needed; document in `.env.example`
- [ ] Migration: `prisma migrate dev --name init`; verify `prisma studio` shows 122 elements

## Acceptance
- [ ] `npx prisma db seed` is idempotent (re-run → still 122 elements, no dup stakes)
- [ ] `stakeCount/totalPoolUsd/currentLeaderId` correct on seeded C after seed

## Pitfalls
- Exotic IDs (−1,0,999) need `Int` pk — fine in Postgres, but don't autoincrement them; insert explicitly.
- Keep `Payment.status` as string in MVP (`pending|paid|failed`), enum later.
