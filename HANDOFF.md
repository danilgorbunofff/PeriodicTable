# Handoff — periodictable.lol prod launch

> Last updated: **2026-09-10** (verified against live prod at 12:45Z).
> The step-by-step checklist lives in `doc/PROD-READINESS-CHECKLIST.md` and is
> the authority for *how* to verify each item. This file is the *state of the
> world*: what is done, what is broken, what is next.
>
> Work continues on another PC: `git clone`, copy `.env` values from a safe
> place (never commit `.env`), `npm ci`.

---

## Read this first — the three things that matter

### 1. 🔴 THE TOP BLOCKER: prod is full of fake demo claims

Prod shows **10 claimed elements, 12 stakes, $410 "staked"** — and every one of
them is **seed/demo data**, not a real customer. Live right now:

| Element | Leader shown | Amount |
| --- | --- | --- |
| C | `stripe.com` (plus adyen.com #2, squareup.com #3) | $50 |
| Au | `coinbase.com` | $88 |
| DM | `anthropic.com` | $66 |
| Pt | `coinbase.com` | $42 |
| U | `huggingface.co` | $39 |
| Si | `nvidia.com` | $34 |
| Fe | `supabase.com` | $21 |
| O | `cloudflare.com` | $15 |
| H | `cloudflare.com` | $12 |
| He | `cloudflare.com` | $10 |

**How we know it is demo data:** those domains come from `mocks/startups.ts`
(`MOCK_STAKES`), which `prisma/seed.ts` upserts as "6 demo startups + stakes".
The live `/api/elements/C` detail returns exactly the mock ranks and amounts
(stripe #1 $50, adyen #2 $31, squareup #3 $18), and `/api/activity` streams the
same fake companies.

**Why this blocks launch:**
- New users see fake traction — famous companies that never claimed anything.
- Those are real company names **and logos**, used without permission
  (Stripe, NVIDIA, Coinbase, Cloudflare, Supabase, Anthropic). This is a
  trademark/endorsement risk the moment the site is promoted.
- A brand-new territory map that already looks "taken" kills the reason to join.

**Fix:** delete the demo rows from the Neon prod database before launch.
⚠️ **There is no script for this** — `scripts/` has no cleanup tool and the seed
is upsert-only (it skips elements that already have stakes, so re-seeding will
not clear them). Options: a guarded SQL delete of the demo startups/stakes, or a
small `scripts/clear-demo-data.ts`. Either way, confirm what is left with
`curl -s https://www.periodictable.lol/api/stats` → expect
`claimedElements:0, stakeCount:0, totalStakedUsd:0`.

### 2. 🔴 The 10-minute worker timer has never once fired

`.github/workflows/outbox-tick.yml` is registered on `main`, `state:active`,
cron `*/10 * * * *` — and at 12:10Z the repo-wide run API returned **33 runs
(17 push + 10 pull_request + 6 workflow_dispatch) and 0 `schedule`**: nine
consecutive missed boundaries, 1 h 25 m after registration.

**Not launch-blocking** because receipts and outbid mail are sent **inline** at
webhook time — the outbox is the *retry* path, and previews render nowhere in
v1. A late tick delays a retry; it never silences first-time mail.

**Fallback (one dashboard action, user-side):** a free 10-minute pinger such as
cron-job.org. Verified ready for it — both paths accept a plain **GET** with
`Authorization: Bearer <CRON_SECRET>` and need no body, and a deliberately
wrong secret returns **401 on both**, so a 200 is real proof:
- `https://www.periodictable.lol/api/jobs/outbox`
- `https://www.periodictable.lol/api/jobs/screenshot`

### 3. ✅ `main` is green, and two real prod bugs were found and fixed today

- Post-merge run `34475469983` on `main` = **success**, `Tests 241 passed (241)`,
  **0 skipped**.
- **Preview pipeline was dead in prod, now fixed.** The screenshot worker probed
  `image.microlink.io` — a host with **no DNS record**. Every job failed, backed
  off and burned out at `attempts=5`. Rewrote it to use Microlink's JSON API,
  validate the returned host, and widened the CSP to `https://*.microlink.io`;
  `backfill` now **re-arms** burned-out rows. Proven with 4 dispatches
  (`checked 9 → 6 → 2 → 0`; 9/9 rows completed) and a live `200 image/png` fetch.
- **A takedown could be silently undone, now fixed.** The moderate route cleared
  `previewImgUrl` on HIDE, but the worker's write was unconditional and a probe
  takes ~7 s — so a job that started *before* a takedown landed *after* it and
  re-attached a preview to a HIDDEN listing. Now writes go through
  `attachPreview()` (guarded on `moderationState: "VISIBLE"`), plus the same
  guard in `scripts/backfill-previews.ts`, plus a regression test. This is what
  turned `main`'s CI red — the DB test had always passed *because* the pipeline
  was broken, so the bug was invisible until previews started working.

---

## Where things stand (verified live 2026-09-10)

**Done and proven**
- [x] Deployed on Vercel (`periodic-table`, auto-deploys `main`); main CI green
- [x] Neon Postgres connected + migrated — **122 elements live**
- [x] Custom domain live: `periodictable.lol` → 308 → `www.periodictable.lol`
- [x] Security headers + CSP live in prod (`next.config.mjs`, prod-only block)
- [x] All 6 read APIs 200 on the custom domain
- [x] Payments **safely paused**: `POST /api/checkout` → `403` (waitlist)
- [x] Resend domain `periodictable.lol` verified (DNS via GoDaddy, mail rows intact)
- [x] Resend key **deleted + recreated** after a chat exposure; direct-API test
      delivered to an inbox (landed in Gmail *spam* — expected for a bare test
      from a fresh domain; real receipts carry proper content + one-click
      unsubscribe headers)
- [x] Job auth verified on prod: both `/api/jobs/*` → `401` unauthenticated,
      `{"ok":true,…}` with the bearer; `CRON_SECRET` matches GitHub ↔ Vercel
- [x] Preview/screenshot pipeline fixed and proven end to end (§3 above)
- [x] Takedown-vs-preview race fixed + regression test (§3 above)
- [x] `vercel.json` daily backstop (outbox 04:00, screenshot 04:30)
- [x] v1 product decision: **a listing is set at checkout and is final** (listing
      edits deferred to v2; nothing user-facing promises a manage flow)

**Known broken / unproven**
- [ ] 🔴 **Demo data in prod** (§1) — top blocker
- [ ] 🔴 **GitHub cron never fires** (§2)
- [ ] `requireProdEnv()` has **zero runtime call sites** (only `lib/env.test.ts`)
      and `ADMIN_TOKEN` is **not** in `REQUIRED_PROD_ENV` (`lib/env.ts:37`) —
      re-verified 2026-09-10. Prod can boot under-configured with no hard failure.
- [ ] `app/api/activity/route.ts` and `app/api/stats/route.ts` **do not filter by
      `moderationState`**, while `board`, `elements`, `search`, `table-order` and
      the screenshot worker all do — so a HIDDEN listing still leaks into the
      activity feed, and hidden money is summed into stats. (Re-verified today.)
- [ ] Turnstile keys not set — bot checks **silently pass** (`lib/abuse.ts`)
- [ ] Upstash not set — rate limits are per-instance memory, bypassable on
      serverless (`lib/rateStore.ts` fails open)
- [ ] Whop contract **still guessed** (`lib/whop.ts`): endpoint shape, signature
      header, payment-id location, paid event types. Needs signed fixtures.
- [ ] Webhook trusts the amount it is told (`null` skips validation)
- [ ] No refunds / disputes / `PENDING` expiry / reconciliation — the `REFUNDED`
      enum value is never written
- [ ] Grid/stats failure honesty: a blocked API must show error panels, never a
      fake all-`Unclaimed $5` / zeros
- [ ] A11y/mobile sweep + a real browser/axe E2E (today: static string tests only)
- [ ] `EMAIL_FROM` is `info@periodictable.lol`; the plan is `hi@…` — align when
      convenient (both work, same verified domain)
- [ ] Vercel dashboard Cron Jobs tab should list both daily jobs (visual check)

**Environment traps — do not lose time on these**
- **Local tests silently skip the DB suites.** Without `TEST_DATABASE_URL` you get
  `200 passed | 41 skipped`; CI runs `241 passed (241)` with **0 skipped**. A green
  local run is **not** proof the integration path works — that is exactly how the
  takedown bug sat unnoticed in `main`. Let CI be the DB oracle.
- **`npm run lint` and `npx eslint` hang in this Windows environment** (14+ min, no
  output; the repo path contains a comma). CI on Linux lints fine. Locally, use
  `npm run typecheck` + `npm run test:ci`.
- CI runs on `push` to `main` **and** `pull_request`. **The post-merge `push` run
  can fail even when the PR run passed** — always re-check `main` after merging.
- Secrets must never be pasted into chat. A Resend key leaked that way once and
  had to be rotated (delete → recreate → update Vercel → redeploy).

---

## What is next, in order

1. **Clear the demo data from prod** (§1) — the only true launch blocker.
2. **Set up the independent 10-min pinger** (§2) — or accept the daily backstop.
3. Then resume `doc/PROD-READINESS-CHECKLIST.md` in order:
   - §4b: Vercel Cron Jobs tab visual check; outbox lifecycle / `ADMIN_TOKEN` retry
   - §5: Turnstile, Upstash, `ADMIN_TOKEN`, **activity+stats HIDDEN leak**, honest
     error panels, board sorting, click salt
   - §4c: receipt / outbid / unsubscribe **hand tests with two real inboxes**
   - §6: hand journeys J1–J8
   - §7: GO / NO-GO
4. **LAST:** `PAYMENTS_LIVE=true` + `NEXT_PUBLIC_PAYMENTS_LIVE=true` + Whop live
   keys + webhook `https://www.periodictable.lol/api/webhooks/whop` registered →
   redeploy → $1 live claim → refund/keep → announce.
5. Product decision to make explicitly: v1 currently **renders no previews**
   (nothing in `.tsx` reads `stake.preview`; only `Avatar.tsx` renders `logoUrl`).
   The pipeline works and the CSP allows it — decide whether v1 shows them.

---

## Reference

- Live: https://www.periodictable.lol · Vercel project: `periodic-table`
  (Build Command must include `prisma migrate deploy`)
- Git: `main` is the deploy branch. Recent: `28b2cd5` (#8) ← `e85859f` (#7) ←
  `048f3ca` (#6) ← `107d05d` (#5) ← `63b1914` (#4) ← `17e7177` (#3)
- Env vars (values in Vercel only, never in the repo): `DATABASE_URL`,
  `WHOP_API_KEY`, `WHOP_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL`,
  `RESEND_API_KEY`, `EMAIL_FROM`, `CLICK_SALT`, `TURNSTILE_SECRET`,
  `NEXT_PUBLIC_TURNSTILE_SITEKEY`, `CRON_SECRET`, `PAYMENTS_LIVE`,
  `NEXT_PUBLIC_PAYMENTS_LIVE`, `ADMIN_TOKEN`, `UPSTASH_REDIS_REST_URL`,
  `UPSTASH_REDIS_REST_TOKEN`, `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` (optional)
- Money smoke tests:
  - `BASE_URL=https://www.periodictable.lol bash scripts/rehearse-release.sh paused`
  - `BASE_URL=http://localhost:3100 ADMIN_TOKEN=… WHOP_WEBHOOK_SECRET=… bash scripts/rehearse-release.sh live`
- Full local gate: `npm ci` → `prisma migrate deploy` (local DB) → `npm run lint` →
  `npm run typecheck` → `TEST_DATABASE_URL=… npm run test:ci` (must be 0 skipped) →
  `npm run audit:prod` → prod-env gate fail-without / pass-with secrets
- Prod data check: `curl -s https://www.periodictable.lol/api/stats`
- Registrar: GoDaddy. `A @ → 216.198.79.1` (Vercel-assigned),
  `CNAME www → periodictable.lol.`. **Mail rows (`MX`, `email`,
  `secureserver` DKIM) belong to GoDaddy mail — do not touch.**
  Resend and GoDaddy mail coexist (different DKIM/SPF hostnames, no conflict).