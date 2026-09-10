# Prod Readiness Checklist — periodictable.lol

> Goal: prove the project is ready to meet new users. Work top to bottom.
> Mark each box only with evidence (command output, screenshot, inbox mail).
> Never commit `.env`. Fresh machine: `git clone`, copy `.env` values from a safe place, `npm ci`.
> Live: https://www.periodictable.lol · Vercel project `periodic-table` · Neon Postgres (122 elements).

## 0. Pre-flight (new PC)

- [ ] `node -v` = 20+ (22 preferred), `npm -v` present, `psql`/`curl`/`python3` present
- [ ] `git clone <repo>` + `npm ci` clean (no errors)
- [ ] `.env` present locally, NOT committed (`git status --porcelain` shows no `.env`)
- [ ] `npx prisma migrate deploy` (local DB) + `npx prisma db seed` succeed
- [ ] Vercel → project `periodic-table` → Build Command includes `prisma migrate deploy`

## 1. Codebase gates (automated)

| Check | Command | Pass |
| --- | --- | --- |
| Lint | `npm run lint` | 0 errors |
| Types | `npm run typecheck` | 0 errors |
| Tests | `TEST_DATABASE_URL=<local-pg> npm run test:ci` | all pass, **0 skipped** |
| Vulns | `npm run audit:prod` | `no unaccepted high/critical` |
| Prod-env fail-closed | `VERCEL_ENV=production NODE_ENV=production node scripts/check-prod-env.mjs` (no secrets) | exits 1 listing missing keys |
| Prod-env pass | same command **with** all prod secrets exported | `production config OK` |
| Cron file present | `cat vercel.json` | 2 daily crons (outbox 04:00, screenshot 04:30) — Vercel cannot create crons from the dashboard, and Hobby allows only 2 jobs at once-a-day frequency |

Known gaps (do NOT flip real money until fixed — see §8):
`requireProdEnv()` has zero runtime call sites (only `lib/env.test.ts`); `ADMIN_TOKEN` missing from `REQUIRED_PROD_ENV`;
`lib/manage.ts` only `console.error`s in prod (magic link never emailed); `REFUNDED` enum never written; Whop contract values in `lib/whop.ts` are guesses until proven with signed fixtures.

## 2. Data, domain, DNS, headers, read APIs

- [ ] DB: `SELECT count(*) FROM "Element";` → **122** (1..118 + Hbar/-1, Ps/0, Uue/119, DM/999)
- [ ] DNS (GoDaddy, do NOT touch mail rows): `A @ → 216.198.79.1`, `CNAME www → periodictable.lol.`
- [ ] Apex `curl -sI https://periodictable.lol | head -3` → `308` → `https://www.periodictable.lol`
- [ ] `MX` + `email` + `secureserver` DKIM rows still present (GoDaddy mail intact; Resend uses different hostnames, no conflict)
- [ ] Security headers on `https://www.periodictable.lol` (prod only): `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy`, `Strict-Transport-Security`, `Content-Security-Policy` (see `next.config.mjs`)
- [ ] All 6 read APIs return 200 on custom domain, <2000ms each:
```
for p in /api/stats /api/elements /api/table-order "/api/board?tab=crowns" "/api/activity?limit=6" "/api/search?q=carbon"; do
  echo "== $p"; curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" "https://www.periodictable.lol$p"
done
```
- [ ] `GET /api/stats` shape: `{elementsTotal:122, claimedElements, unclaimedElements (=total-claimed), stakeCount, totalStakedUsd}` — summed dollars, not row counts
- [ ] `GET /api/elements` tiles carry `{symbol, pool, count, leader{domain,logoUrl,amount}|null}`
- [ ] `GET /api/elements/Li` detail: stakes ranked desc, `prices{takeLead,joinMin}`, hidden bidders excluded

## 3. Money / Whop (paused now, live last)

### 3a. Paused mode (current prod expectation)
- [ ] `POST /api/checkout` (no flags) → `403 {"waitlist":true}` and modal shows Join-waitlist card
- [ ] `BASE_URL=https://www.periodictable.lol bash scripts/rehearse-release.sh paused` → 2/2 pass
- [ ] `POST /api/waitlist {email}` twice → same `id` (dedupe by email), one DB row

### 3b. Live flows (local sim: NO Whop keys → dev simulator; WITH keys → real sessions)
```
BASE_URL=http://localhost:3100 bash scripts/rehearse-release.sh live
# full: BASE_URL=… ADMIN_TOKEN=… WHOP_WEBHOOK_SECRET=… bash scripts/rehearse-release.sh live
```
- [ ] First claim $8 → 200 `{paymentId, checkoutUrl}` → `POST /api/dev/pay {pay}` → `paid` → tile leader = payer
- [ ] Contested $5 join → lands #2, leader untouched; tie at leader total → `409 TIE`
- [ ] Take $9 → `guaranteedTake:true, reservation.reservedTotal:9`; rival take → `409 RESERVATION_CONFLICT`; pay → crown flips
- [ ] Reclaim $2 by former leader → restores #1 at $10 (cumulative)
- [ ] Same `idempotencyKey` + same payload → returns ORIGINAL `paymentId`; different payload → `409 IDEMPOTENCY_CONFLICT`
- [ ] Expired reservation (server `RESERVATION_TTL_MS=2000`, sleep 3s) settles as ordinary stake, no crown
- [ ] Provider outage (Whop keys set, API down) → `502`, NO `checkoutUrl` (never a dead URL)

### 3c. Webhooks (needs `WHOP_WEBHOOK_SECRET`; sign like `rehearse-release.sh:sign_post`)
- [ ] `payment.succeeded` with matching amount → `applied` once; replay same `id` → `duplicate`/`already-settled`
- [ ] Statusless event → `ignored`, settled payment untouched
- [ ] `payment.failed` → `failed`; later `succeeded` for same payment → `already-settled` (terminal)
- [ ] Amount 999 vs local 7 → `amount-mismatch`, nothing applied
- [ ] Missing/bad `x-whop-signature` → rejected; unknown `paymentId` → recorded, nothing applied
- [ ] Prove contract in test mode before live: endpoint shape, signature header name, payment-id location (`data.plan.metadata` vs `data.metadata`), paid event types — save signed fixtures as tests in `lib/whop.ts` area

## 4. Email + background jobs

### 4a. Resend live test (manual, NOW — 09-09 key in chat is INVALID, never reuse)
- [x] Resend → API Keys → fresh `periodictable-prod` key (Sending access) exists (2026-09-10: exposed key deleted + recreated after chat exposure)
- [x] Resend → Domains → `periodictable.lol` = Verified (proven: direct-API mail delivered 2026-09-10)
- [x] Vercel → Env Vars → `RESEND_API_KEY=re_…` (fresh) → Save; ⚠️ `EMAIL_FROM` currently `info@`, handoff expects `hi@` — align to `hi@` + redeploy when convenient (both work, same verified domain)
- [x] Deployments → ⋯ → Redeploy (public vars bake at build) — done 2026-09-10
- [x] Direct Resend API test → inbox delivery ✅ (landed in Gmail spam — expected: bare "prod test" content from a fresh domain, no List-Unsubscribe; real receipt/outbid mails carry proper content + one-click headers and will fare better; reputation builds with volume)
- [x] Rotate after any chat exposure: delete + recreate + Vercel update + redeploy — done 2026-09-10
- [ ] Full pipeline test (`POST /api/dev/pay` → `POST /api/jobs/outbox` → `EmailLog=sent`) — needs local Postgres; blocked until §0 local DB exists. NOTE: `/api/dev/pay` is 403 on prod by design (Whop keys set), so this runs locally, never against prod.

### 4b. Outbox + screenshot workers
- [ ] `POST /api/jobs/outbox` without secret in prod → `401`; with `Authorization: ******` → `{ok:true, claimed, completed, failed}`
- [ ] `POST /api/jobs/screenshot` same auth; `backfill:true` enqueues ≤50 preview-less VISIBLE startups
- [ ] Schedulers live: `.github/workflows/outbox-tick.yml` every 10 min (free — public repo, unlimited Actions minutes; runs only from `main`, so it activates when this branch merges) + `vercel.json` daily backstop (04:00/04:30)
- [ ] `CRON_SECRET` set in Vercel **and** as a GitHub Actions repo secret with the same value → manually run the `outbox tick` workflow → `{"ok":true,…}` (not `401`) for both endpoints
- [ ] Outbox row lifecycle: `attempts<5`, exponential backoff, `lastError` persisted, operator retry endpoint works with `ADMIN_TOKEN`

### 4c. Receipt / outbid / unsubscribe / magic-link (hand test with two emails)
- [ ] Claim → payer gets receipt with correct `{element, amount, rank, domain, manageUrl, unsubUrl}`; `EmailLog{template:receipt,status:sent}`
- [ ] Outbid → victim gets outbid mail with correct `reclaim = winner+1-victim (min 1)` and `/?el=SYM&stake=N` prefill link
- [ ] `List-Unsubscribe` + `List-Unsubscribe-Post` headers present; `GET /api/unsubscribe?token=` clears email → homepage `?unsub=done` toast; unknown → `?unsub=unknown`
- [ ] Manage link: `POST /api/manage/request {domain,email}` → non-prod returns `debugToken`, **prod returns `{sent:true}` with NO token**; prod must actually EMAIL the link (today `lib/manage.ts` only `console.error`s — fix before launch); `POST /api/manage/verify {token}` → httpOnly `ptl_manage` cookie (Secure in prod) → `PATCH /api/startups/[domain]` works; token single-use, 15-min TTL; session 60-min

## 5. Trust, abuse, admin, frontend honesty

- [ ] Turnstile: `TURNSTILE_SECRET` + `NEXT_PUBLIC_TURNSTILE_SITEKEY` from Cloudflare set; without them bot checks silently pass (`lib/abuse.ts`) — must not launch without
- [ ] Upstash: `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` set; without them rate limits are per-instance memory (`lib/rateStore.ts` fails open, bypassable on serverless)
- [ ] `ADMIN_TOKEN` long random set; all `/api/admin/*` → `403` without `Authorization: ****** round-trip: report → triage → HIDE → verify → restore (see hand journey J6)
- [ ] Kill switch: `PAYMENTS_LIVE=false` + `NEXT_PUBLIC_PAYMENTS_LIVE=false` → checkout flips to waitlist in <2min via env-only redeploy (see `ops/rollback.md`)
- [ ] Grid/stats failure honesty: block API (offline/devtools) → error panels, NEVER fake all-`Unclaimed $5`/zeros. Reference pattern: `TerritoryView.tsx` error panel vs `app/page.tsx`
- [ ] HIDDEN leaks: activity feed must exclude HIDDEN; stats must not sum hidden money while boards filter VISIBLE; hidden profile `/s/<domain>` → 404; `/go/<stakeId>` refuses hidden; hide clears `previewImgUrl`
- [ ] Boards: Table Order sorts totalSpent desc → crowns → domain; By-Element biggest leader stake; deterministic tie-breaks; Early-Adopter tile correct per `FirstClaim`
- [ ] Clicks: `/go/<stakeId>` attributes via sha256(ip+`CLICK_SALT`) only (never raw IP); `CLICK_SALT` private random in prod

## 6. New-user hand journeys (do all, record evidence)

- [ ] **J1 Browse:** open `/` desktop + mobile → table pans/zooms, tiles show claim state/price/leader, no layout break at 360px
- [ ] **J2 Search:** open search → type `carbon` → keyboard navigates, Enter opens Li drawer; screen-reader names intact
- [ ] **J3 Claim (paused):** click money action → waitlist card (not checkout); join waitlist → success toast
- [ ] **J4 Claim (live sim):** fill title/pitch/URL → checkout → pay → `?paid=SYM` toast + tiles/ranks refresh, receipt email arrives
- [ ] **J5 Outbid/reclaim:** second user takes tile → victim outbid email → victim clicks reclaim link → prefilled amount → pays → crown returns
- [ ] **J6 Report/moderate:** report a stake → confirm modal → admin triage → HIDE → tile/profile/`/go` hide → restore → reappears
- [ ] **J7 Manage/unsub:** request manage link → verify → edit profile → unsubscribe → emails stop, stake still counts
- [ ] **J8 Reduced-motion + keyboard:** `prefers-reduced-motion` → static but legible; Esc closes modals/drawers in order; 44px touch targets; no toast-behind-modal; axe E2E clean (today: static string tests only — run a real browser pass)

## 7. GO / NO-GO (all must be GO)

| Gate | GO criteria |
| --- | --- |
| Codebase | lint + typecheck + test:ci (0 skipped) + audit:prod green |
| Data/domain | 122 elements, 6 APIs 200 <2s, DNS + 308 + headers correct |
| Money | paused 403 now; live rehearsal green in sim; Whop contract proven with fixtures |
| Email/jobs | fresh Resend key, inbox receipt received, cron draining outbox+screenshots |
| Trust/frontend | Turnstile + Upstash + ADMIN_TOKEN live, no HIDDEN leaks, honest error panels, kill switch rehearsed |
| Flip (LAST) | `PAYMENTS_LIVE=true` + `NEXT_PUBLIC_PAYMENTS_LIVE=true` + Whop live keys + webhook `https://www.periodictable.lol/api/webhooks/whop` registered → redeploy → $1 live claim → refund/keep → announce |

## Appendix — copy-paste cheat sheet

```
npm ci
npx prisma migrate deploy
npm run lint; npm run typecheck
TEST_DATABASE_URL=postgresql://… npm run test:ci
npm run audit:prod
VERCEL_ENV=production NODE_ENV=production node scripts/check-prod-env.mjs
BASE_URL=https://www.periodictable.lol bash scripts/rehearse-release.sh paused
BASE_URL=http://localhost:3100 ADMIN_TOKEN=… WHOP_WEBHOOK_SECRET=… bash scripts/rehearse-release.sh live
curl -s https://www.periodictable.lol/api/stats | python3 -m json.tool
```
Env vars (values in Vercel only): `DATABASE_URL`, `WHOP_API_KEY`, `WHOP_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL=https://www.periodictable.lol`, `RESEND_API_KEY`, `EMAIL_FROM`, `CLICK_SALT`, `TURNSTILE_SECRET`, `NEXT_PUBLIC_TURNSTILE_SITEKEY`, `CRON_SECRET`, `PAYMENTS_LIVE`, `NEXT_PUBLIC_PAYMENTS_LIVE`, `ADMIN_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` (optional).
