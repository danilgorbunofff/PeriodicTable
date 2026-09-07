# Rollback Runbook (Phase 5)

## One-flag payments kill switch
- `PAYMENTS_LIVE=false` (server) + `NEXT_PUBLIC_PAYMENTS_LIVE=false` (client) flips
  checkout to `[ Join waitlist ]` in <2min via env-only redeploy.
- `POST /api/checkout` returns `403 { waitlist: true }` when off; modal shows waitlist card.
- Rehearsal: set flag off on staging → assert waitlist copy → set back on → assert checkout returns.

## Deploy order (prod)
1. `prisma migrate deploy` + `tsx prisma/seed.ts` + `tsx prisma/launch-seed.ts`
2. Env: Whop live keys, Resend domain, Turnstile, `CRON_SECRET`, `PAYMENTS_LIVE=true`
3. Deploy Vercel prod 4. Smoke $1 claim → refund/keep 5. Announce

## DB incidents
- Bad migrate: `prisma migrate resolve --rolled-back <name>`, restore Neon branch (PITR).
- Bad data: restore branch, re-run seeds (both idempotent).

## Abuse/spam
- Blocklist domain in `lib/validate.ts` `BLOCKED_DOMAINS`, hide stake via report triage,
  refund via provider dashboard (Whop). Takedown playbook: `ops/takedown.md`.
