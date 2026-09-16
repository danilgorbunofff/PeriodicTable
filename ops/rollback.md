# Rollback Runbook (Phase 5)

Index and auth: `ops/README.md`. This file is about undoing a *deploy*; a payment, a webhook or an email that went wrong has its own runbook, and none of them is fixed by rolling back code (`payments-stuck.md` says this in its first paragraph).

## One-flag payments kill switch
- `PAYMENTS_LIVE=false` (server) + `NEXT_PUBLIC_PAYMENTS_LIVE=false` (client) flips
  checkout to `[ Join waitlist ]` via env-only redeploy.
- `POST /api/checkout` returns `403 { waitlist: true }` when off; modal shows waitlist card.
  The check is the **first statement** in the handler (`app/api/checkout/route.ts:102`),
  ahead of rate limiting, honeypot, Turnstile and provider calls. Verified against
  production 2026-09-11: `403` in 0.32s, and while paused the checkout form is
  **compiled out of the bundle**, not hidden — 0 occurrences of `Continue to checkout`,
  `cf-turnstile`, `No refunds` or `I agree` across the HTML plus all 8 JS chunks.
  Note the flag is fail-closed by *absence* too: prod has no `PAYMENTS_LIVE` at all,
  so `undefined === "true"` is what keeps it off.
- ⚠️ **Not instantaneous — budget ~2 min.** An env change only applies to a *new*
  deployment, so the old one keeps serving the old flag while it rebuilds. 12/12
  production builds on 2026-09-11 took 1.1–1.6 min (median 1.3), which leaves under a
  minute of headroom — the "<2min" figure holds but is not comfortable. **If you need
  payments stopped NOW** (runaway price, exploit, abuse), redeploying is the wrong
  lever: roll (or restrict) the `STRIPE_SECRET_KEY` in the Stripe dashboard. That
  is provider-side and immediate — every checkout then fails closed with a 502
  instead of charging, and it keeps holding after the redeploy lands.
- ⚠️ **The webhook stays live on purpose.** `app/api/webhooks/stripe/route.ts` does
  *not* consult the flag: a payment already taken must still settle, or we hold the
  money and hand over nothing. So the switch stops *new* checkouts only. Forging a
  delivery needs `STRIPE_WEBHOOK_SECRET` — HMAC-SHA256 over `t.<raw body>` with a
  300s tolerance, timing-safe compare, and a hard `401` when no secret or no valid
  signature is present (fail-closed).
- Rehearsal: set flag off → assert waitlist copy → set back on → assert checkout
  returns. The **off** half is verified on production itself; the **on** half requires
  live Stripe keys, so it is the go-live ladder (Deploy order step 2-3), not a
  pre-launch check.

## Deploy order (prod)
0. `node scripts/check-prod-env.mjs` with production env (must pass) + `npm run audit:prod`
1. Migrations apply themselves in the production build: `npm run build` is
   `prisma generate && node scripts/migrate-if-production.mjs && next build`, and
   that script runs `prisma migrate deploy` **only when `VERCEL_ENV=production`** —
   previews, local builds, and CI all skip it. A migration that fails fails the
   build, and the previous deployment keeps serving. Seeds are still manual:
   `tsx prisma/seed.ts` + `tsx prisma/launch-seed.ts`
2. Env: Stripe live keys + webhook endpoint, Resend domain, Turnstile, `CRON_SECRET`, `PAYMENTS_LIVE=true`
3. Deploy Vercel prod 4. Smoke $1 claim → refund/keep 5. Announce

## DB incidents
- **Bad migration.** `prisma migrate resolve --rolled-back <name>` marks a *failed*
  migration so it can be re-applied; it does **not** undo a successful one, and there
  are no down migrations (R17-11). Stop the deploy and apply the forward fix as a new
  migration. Restoring a Neon branch is the only true undo, and it discards everything
  written since the branch point — the procedure, the freeze-first step and the
  retention-window decision (D11) are in `database.md` §"Restore".
- **The check that says whether a restore is even needed:** before touching the
  branch, read the ledger — `curl -sS -H "Authorization: Bearer $CRON_SECRET"
  "$APP_URL/api/jobs/reconcile" | jq '{ok, divergent, unapplied, aggregate}'`. Code
  rollback and data rollback are separate decisions; `ok: true` means the database
  does not need to be part of this one.
- `ADD CONSTRAINT` that fails on deploy (0009_data_invariants): the constraint validates
  the rows already present, so a pre-existing violation fails the deploy instead of being
  accepted, and the error names the constraint. Run `0009`'s two pre-flight queries first
  (they are in the migration header; both must return 0), repair any offending rows, then
  re-run `prisma migrate deploy`. Repairing by hand is deliberate: a value that violates a
  money invariant is an operator decision, not a script's.
- Bad data: restore branch, re-run seeds (both idempotent).
- FK failure on deploy (dangling audit refs, e.g. clicks pointing at deleted
  stakes): find them via the failing constraint name, repair the rows to valid
  targets (never hand-delete audit rows), then re-run `prisma migrate deploy`.
  Rehearse this on a sanitized snapshot with `scripts/rebuild-p1-snapshot.sh`.

## Abuse/spam
- **Contain with the product, not with a deploy.** One listing: `ops/takedown.md`.
  A wave: `ops/abuse-wave.md` (`POST /api/admin/startups/moderate-batch`, up to 50
  domains, preview-preserving `HIDDEN`/`UNLISTED`, restore + `backfill`).
- Blocklisting a whole domain class is still a `lib/validate.ts` `BLOCKED_DOMAINS`
  edit plus a ~1.3 min deploy — the last resort, because it is the only lever here
  that is not reversible from the API.
- **Money is never part of containment.** Hiding a listing preserves stakes,
  payments, claims and the public aggregates, and `/api/stats` is hidden-inclusive
  by design. Refunds are a provider-side action with their own approval rule
  (`refunds-and-disputes.md`, `D17-5`) and happen *per payment*, never as part of a
  moderation call.
- The throttle behind intake is per-instance unless Upstash is configured — an open
  production finding, and D15 (`doc/review/FINDINGS.md`). Do not assume a rate limit
  is protecting the report path during a distributed wave.

## Rehearsal records
- `bash scripts/rehearse-release.sh` writes a record file and prints its path as
  `record: …` on the last line; the run id, base, mode, commit, which credentials were
  present, every PASS/SKIP/FAIL and the `TOTAL` are in it, and an interrupted run ends
  `ABORTED exit=<rc> before the tally` rather than looking like a pass (R17-16).
- Records are ignored by git (`rehearsal-*.log`) and are the only durable evidence a
  rehearsal happened — keep them with the incident notes for the release they cover,
  not in `/tmp`.

## When the site itself is down
- `ops/comms.md` carries the three templates (planned/maintenance, active, resolved)
  and the list of claims the product can actually back up. Who publishes and where is
  D16.
