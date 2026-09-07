# 02 — Launch Gate & Runbook

**Parent:** Phase 5 README · **Covers:** ROADMAP §8 flows, §14 gate

## Gate (all must be ✅ morning of launch)
- [ ] 122 tiles render, exotics centered, f-block linked (desktop + mobile scroll)
- [ ] Drawer + 3 modals pixel-close to worldmap.lol refs; autopan + Esc verified
- [ ] E2E green: first-claim $5, takeover $51, reclaim $2, join $5, search `car`
- [ ] Prod webhook live: real $1 test claim → rank + email + clicks counter
- [ ] Legal links + both disclaimers visible; `robots.txt` + sitemap submitted
- [ ] Rollback rehearsed: `PAYMENTS_LIVE=false` → checkout shows `[ Join waitlist ]`, deploy <2min

## Deploy order
1. Migrate + seed prod (122 + launch stakes) 2. Env (Whop live keys, Resend domain, Turnstile, Upstash) 3. Deploy Vercel prod 4. Smoke $1 claim + refund/keep 5. Announce

## Rollback & incidents
- Payments bug → flag off, waitlist mode, fix forward. DB bug → `prisma migrate resolve`, restore Neon branch (PITR). Abuse/spam → blocklist domain, hide stake (`hidden=true` hotfix column), refund via provider dashboard
- Takedown playbook: report → review <24h → hide + email owner + log; DMCA → hide + counter-notice path

## Comms
- Launch post: headline `Put your startup on the table. Literally.` + 3 GIFs (claim, takeover, reclaim) + board screenshot. Hacker News `Show HN` draft in `03-launch-post.md` (optional add)

## Files
- `doc/phase-5-launch/02-launch-gate-runbook.md` (this), `ops/rollback.md`, `ops/takedown.md`
