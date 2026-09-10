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

Known gaps (do NOT flip real money until fixed — see §7):
`requireProdEnv()` has zero runtime call sites (only `lib/env.test.ts`); `ADMIN_TOKEN` missing from `REQUIRED_PROD_ENV`;
`lib/manage.ts` is backend-only by design in v1 (listing edits not shipped — a listing is set at checkout and is final); `REFUNDED` enum never written; Whop contract values in `lib/whop.ts` are guesses until proven with signed fixtures.

## 2. Data, domain, DNS, headers, read APIs

- [ ] DB: `SELECT count(*) FROM "Element";` → **122** (1..118 + Hbar/-1, Ps/0, Uue/119, DM/999)
- [ ] DNS (GoDaddy, do NOT touch mail rows): `A @ → 216.198.79.1`, `CNAME www → periodictable.lol.`
- [ ] Apex `curl -sI https://periodictable.lol | head -3` → `308` → `https://www.periodictable.lol`
- [ ] `MX` + `email` + `secureserver` DKIM rows still present (GoDaddy mail intact; Resend uses different hostnames, no conflict)
- [ ] Security headers on `https://www.periodictable.lol` (prod only): `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy`, `Strict-Transport-Security`, `Content-Security-Policy` (see `next.config.mjs`)
  - ✅ `img-src` must include `https://*.microlink.io` (the wildcard is required — Microlink hands back a sharded shot host, live vs cached). This was too narrow until 2026-09-10; found by §4b, fixed in PR #4, confirmed in the live prod response headers.
  - ℹ️ CSP ships **production-only** (dev needs webpack `eval()`), so a CSP symptom never reproduces under `npm run dev` — always test the deployed URL.
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
- [x] `POST /api/jobs/outbox` without secret in prod → `401`; with a valid bearer header → `{ok:true, claimed, completed, failed}` (2026-09-10: unauthenticated `401` confirmed on prod for both routes)
- [x] `POST /api/jobs/screenshot` same auth; `backfill:true` enqueues ≤50 preview-less VISIBLE startups (2026-09-10: auth confirmed; **backfill run now done and green** — see the delivery-proof row below)
- [x] Schedulers live: `.github/workflows/outbox-tick.yml` every 10 min (free — public repo, unlimited Actions minutes; runs only from `main`, so it activates when this branch merges) + `vercel.json` daily backstop (04:00/04:30) (2026-09-10: merged to `main` via PR #2; main deploy `success`; `GET /api/jobs/outbox` now `401` where it was `405` ⇒ GET aliases Vercel Cron needs are live)
- [x] `CRON_SECRET` set in Vercel **and** as a GitHub Actions repo secret with the same value → manually run the `outbox tick` workflow → `{"ok":true,…}` (not `401`) for both endpoints (2026-09-10: manual dispatch run `34467721174` green in 10s — `outbox {"ok":true,"claimed":0,"completed":0,"failed":0}`, `screenshot {"ok":true,"checked":0,"updated":0,"failed":0}` ⇒ secret matches across GitHub + Vercel; `claimed:0` = empty queue, expected)
- [ ] Confirm the Vercel dashboard Cron Jobs tab lists both daily jobs (proves `vercel.json` was ingested) — dashboard check, then the 04:00 UTC run tomorrow is the live proof
- [x] End-to-end delivery proof: enqueue one real row, let the tick drain it, confirm `completedAt` set (proves the robot does real work, not just auth) — **done 2026-09-10 by `-f backfill=true`; this single step found two real prod bugs, both now fixed and re-proven:**
  - 🔴 **What was broken:** the screenshot robot (`PREVIEW_GENERATE`) was failing **every** job in prod. `lib/screenshots.ts` probed `image.microlink.io` — a host with **no DNS record** (NXDOMAIN). Each job threw, backed off, and burned out at `attempts=5`.
  - 🔴 **Second defect in the same code:** the probe downloaded the whole ~1.87MB PNG against an 8s budget, so even a live host would sit near the timeout. And the CSP did not allow the host the API actually returns.
  - ✅ **Fix:** probe Microlink's **JSON** API (`api.microlink.io/?url=…&screenshot=true&meta=false`) and store the returned `iad.microlink.io/<hash>.png` CDN URL; validate before storing (`https:` **and** hostname ends `.microlink.io`) so a third-party response can never inject an arbitrary `<img src>`; `img-src` widened to `https://*.microlink.io`; `scripts/backfill-previews.ts` now shares the same helper. Payload per job: **~300 bytes instead of 1.87MB**.
  - ✅ **Fix, second half (why re-running alone would not have worked):** `POST /api/jobs/screenshot {backfill:true}` now **re-arms** matched rows (`attempts:0, nextAttemptAt:now, lastError:null, completedAt:null`). `claimDueOutbox` filters `attempts < 5` and claim pushes `nextAttemptAt` 5 min forward, so a burned-out row is otherwise permanently stuck even after the cause is fixed.
  - ✅ **Probe latency (measured live):** cold request **6.9s**, warm cached **172ms**; stored CDN URL serves `200 image/png` (1.56MB) in **0.33s**.
  - ✅ **Drain proof — 4 dispatches, queue visibly emptying:** `checked:9, updated:3, failed:0` → `checked:6, updated:4, failed:1` → `checked:2, updated:2, failed:0` → **`checked:0, updated:0, failed:0`**. The shrinking candidate set *is* the evidence the worker does real work: 9 rows enqueued, 9 completed, queue empty. The single transient failure retried cleanly through the new re-arm path.
  - ✅ **Read-path proof:** `GET /api/elements/C` returns `stakes[].preview` = the stored `iad.microlink.io/…png` URL; fetching that exact URL returns `200 image/png` ⇒ the stored value is a real servable image, and the live CSP now permits the browser to render it.
  - ℹ️ **Scope note:** previews are **not rendered anywhere in the v1 UI yet** (no `.tsx` reads `preview`; only `Avatar.tsx` renders `logoUrl`). So this was a backend-only defect — no user ever saw a broken image — but the pipeline is now correct and proven for when v1 adds the surface. Decide explicitly whether v1 shows previews or leaves them for v2.
- [ ] Outbox row lifecycle: `attempts<5`, exponential backoff, `lastError` persisted, operator retry endpoint works with `ADMIN_TOKEN`

### 4c. Receipt / outbid / unsubscribe (hand test with two emails)
- [ ] Claim → payer gets receipt with correct `{element, amount, rank, domain, viewUrl, unsubUrl}`; `EmailLog{template:receipt,status:sent}`
- [ ] Outbid → victim gets outbid mail with correct `reclaim = winner+1-victim (min 1)` and `/?el=SYM&stake=N` prefill link
- [ ] `List-Unsubscribe` + `List-Unsubscribe-Post` headers present; `GET /api/unsubscribe?token=` clears email → homepage `?unsub=done` toast; unknown → `?unsub=unknown`
- [x] **v1 product decision: a listing is set at checkout and is final** (settled 2026-09-10, after finding the manage flow had no UI). `findOrCreateCheckoutStartup` writes title/pitch/url/link/email from the checkout form; a later stake on the same domain only adds stake and never mutates the profile. So there is nothing for an owner to "manage" in v1, and no UI is missing by accident. Consequences, all verified in code:
  - [x] Listing edits are **not shipped in v1** — the magic-link backend (`lib/manage.ts`, `/api/manage/*`, `PATCH /api/startups/[domain]`) stays implemented, tested and **dormant/unreachable**. Production intentionally does not email the link (`console.warn` + TODO(v2)); non-prod still returns `debugToken` for dev convenience.
  - [x] `POST /api/manage/request` is non-committal: always `200`, same shape, rate-limited, message no longer promises a link ("Listing management is not enabled").
  - [x] No user-facing surface promises editing: grepped every `.tsx` — no manage/edit UI text exists. The receipt email's "Manage your spot →" button (which pointed at the read-only `/s/<domain>`) is now **"View your spot →"** (`emails/receipt.tsx`, prop `manageUrl`→`viewUrl`).
  - [x] Docs corrected so nobody re-adds the promise: `README.md` "Ownership", `doc/ARCHITECTURE.md` §3, `HANDOFF.md` item 5 (now deferred to v2).
  - ⚠️ v2 scope when we do ship it: 3 pages (request link, land/verify, edit form) + turn the prod email send on + make sure the receipt button points at the edit flow. Not a launch blocker.

## 5. Trust, abuse, admin, frontend honesty

- [ ] Turnstile: `TURNSTILE_SECRET` + `NEXT_PUBLIC_TURNSTILE_SITEKEY` from Cloudflare set; without them bot checks silently pass (`lib/abuse.ts`) — must not launch without
- [ ] Upstash: `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` set; without them rate limits are per-instance memory (`lib/rateStore.ts` fails open, bypassable on serverless)
- [ ] `ADMIN_TOKEN` long random set; all `/api/admin/*` → `403` without it; report → triage → HIDE → verify → restore round-trip (see hand journey J6)
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
- [ ] **J7 Unsub (v1):** unsubscribe from a receipt footer → emails stop, the stake still counts, homepage shows the `?unsub=done` toast (unknown token → `?unsub=unknown`). **There is no manage journey in v1** — a listing is final at checkout; `POST /api/manage/request` answers politely and emails no link (§4c). Listing edits are v2.
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
