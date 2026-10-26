# Launch gate & runbook

`ops/rollback.md` is the runbook that gets followed: it owns the pre-flight, the
deploy order and the kill switch with its cost. This file owns the *gate* (what
"launchable" means), the incident playbook in one paragraph, and the comms copy.
Where the two disagree, `ops/rollback.md` wins.

## Gate (all must be ✅ before the announcement)

These are launch-morning checks run against the production deployment, so they
are unticked here by design — tick them from the probes on the day, not from
this file.

- [ ] 122 tiles render, exotics centered, f-block linked (desktop + mobile scroll)
- [ ] Drawer + 3 modals pixel-close to the reference board; autopan + Esc verified
- [ ] E2E green: first-claim $5, takeover $51, reclaim $2, join $5, search `car` — the figures are ladder examples, not constants: entry is `MIN_STAKE` ($5), a takeover clears the leader by `TAKEOVER_MARGIN` ($1), and a reclaim is the difference plus $1 (`lib/pricing.ts`)
- [ ] Prod webhook live: real $1 test claim → rank + email + clicks counter
- [ ] Legal links + both disclaimers visible; `robots.txt` carries the `Sitemap:` directive and `/sitemap.xml` is submitted in Search Console
- [ ] Rollback rehearsed: `PAYMENTS_LIVE=false` → checkout shows `[ Join waitlist ]`, deploy <2min — the *off* half is verified on production itself; the *on* half is the $1 smoke, not a rehearsal (`ops/rollback.md:30-33`)

## Deploy order

0. `node scripts/check-prod-env.mjs` with production env (must pass) + `npm run audit:prod` — `ops/rollback.md:36`
1. Migrate + seed prod (122 elements + launch stakes: `tsx prisma/seed.ts`, then `tsx prisma/launch-seed.ts`) — migrations apply themselves in the production build; seeds stay manual (`ops/rollback.md:37-42`)
2. Env: Stripe live keys + the webhook endpoint for the seven handled types, Resend domain, Turnstile, `CRON_SECRET`, `PAYMENTS_LIVE=true`. No Upstash: it is unwired by decision.
3. Deploy Vercel prod
4. Smoke $1 claim + refund/keep
5. Announce

## Rollback & incidents

- Payments bug → flag off, waitlist mode, fix forward. DB bug → `prisma migrate resolve`, restore Neon branch (PITR). Abuse/spam → blocklist domain, set `moderationState = HIDDEN` through admin triage (this was `hidden=true`, a column that has never existed — see `prisma/schema.prisma`, `ModerationState`), refund via provider dashboard
- Takedown playbook: report → review <24h → hide + email owner + log; DMCA → hide + counter-notice path (`ops/takedown.md`)

## Comms

- Launch post: headline `Put your startup on the table. Literally.` + 3 GIFs (claim, takeover, reclaim) + board screenshot. There is no `03-launch-post.md` and no draft is committed: the announcement names its channel, its copy and its tagged link (`?utm_source=&utm_medium=&utm_campaign=launch`) when it is written, before it is posted, and the channel, date and URL are recorded afterwards.
