# Prod Readiness Checklist — periodictable.lol

> Goal: prove the project is ready to meet new users. Work top to bottom.
> Mark each box only with evidence (command output, screenshot, inbox mail).
> Never commit `.env`. Fresh machine: `git clone`, copy `.env` values from a safe place, `npm ci`.
> Live: https://www.periodictable.lol · Vercel project `periodic-table` · Neon Postgres (122 elements).

## 0. Pre-flight (new PC)

- [ ] `node -v` = 20+ (22 preferred), `npm -v` present, `psql`/`curl`/`python3` present
- [ ] `git clone <repo>` + `npm ci` clean (no errors)
- [ ] `.env` present locally, NOT committed (`git status --porcelain` shows no `.env`)
- [x] `npx prisma migrate deploy` (local DB) + `npx prisma db seed` succeed — ✅ 2026-09-11 on a throwaway local DB: all 6 migrations applied, then `seed ok: 122 elements, 8 startups, 26 stakes, 26 activity rows`. ⚠️ **Both commands read `.env` → Neon prod if `DATABASE_URL` is not overridden** (shell env beats `.env`), and `prisma db seed` is the **demo** seeder (`prisma/seed.ts`, 8 startups + 26 mock stakes) with **no environment guard** — it is exactly what `npm run db:clear-demo` exists to undo. The launch seeder is a separate, manual file (`prisma/launch-seed.ts`). Always pass `DATABASE_URL=` explicitly.
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

> ✅ **2026-09-11 — the whole gate is green with zero skips, for the first time on a real Postgres.** `npm run test:ci` → **314 passed (21 files), 0 skipped**; `npm run typecheck` exit 0; `npm run lint` 0 warnings/errors. This retires the DB suite that had been skipped indefinitely — including the new *"a Standard Webhooks delivery settles too"* case, which passes end-to-end (signature → `ProviderEvent` → `settlePayment` → stake applied). Both envelopes are exercised in one run: `verified via legacy signature` ×19, `verified via standard signature` ×1.
>
> Recipe — the container is `pt-test-pg` on port **55432** (`testu`/`testpw`; `-U postgres` fails, that role does not exist):
> ```bash
> PGPASSWORD=testpw psql -h 127.0.0.1 -p 55432 -U testu -d pttest -c "CREATE DATABASE pt_verify;"
> DATABASE_URL="postgresql://testu:testpw@127.0.0.1:55432/pt_verify" npx prisma migrate deploy
> TEST_DATABASE_URL="postgresql://testu:testpw@127.0.0.1:55432/pt_verify" npm run test:ci
> ```
> ⚠️ **Mind the asymmetry: `migrate deploy` reads `DATABASE_URL`, the suite reads `TEST_DATABASE_URL`** (which `lib/testDb.ts` copies onto `DATABASE_URL` for the app's Prisma singleton). Setting *only* `TEST_DATABASE_URL` makes `prisma` fall back to `.env` → **Neon production**. Today that is a harmless no-op (`No pending migrations to apply`), but the day a migration is pending it would apply it **to prod**. Always set both.

Known gaps (do NOT flip real money until fixed — see §7):
`requireProdEnv()` has zero runtime call sites (only `lib/env.test.ts`); `ADMIN_TOKEN` missing from `REQUIRED_PROD_ENV`;
`lib/manage.ts` is backend-only by design in v1 (listing edits not shipped — a listing is set at checkout and is final); `REFUNDED` enum never written;
`WHOP_WEBHOOK_SECRET` has **no validator** in `lib/env.ts`, so a mistyped or placeholder value passes `check-prod-env` while the webhook silently stays broken — the only real check is a live delivery returning `200` (§3c).

> ✅ Resolved 2026-09-11: the Whop signature contract is **no longer guesswork**. A genuine v1 delivery verified as Standard Webhooks, and signed fixtures for *both* envelopes now live in `lib/webhook.test.ts` (~11 cases). See §3c.

## 2. Data, domain, DNS, headers, read APIs

- [x] DB: `SELECT count(*) FROM "Element";` → **122** (1..118 + Hbar/-1, Ps/0, Uue/119, DM/999) — ✅ 2026-09-11: prod `/api/stats` reports `elementsTotal:122, claimed:0, unclaimed:122, stakeCount:0, totalStakedUsd:0` (the API reads the same table). A freshly seeded local DB reports the same 122.
- [ ] DNS (GoDaddy, do NOT touch mail rows): `A @ → 216.198.79.1`, `CNAME www → periodictable.lol.`
- [x] Apex `curl -sI https://periodictable.lol | head -3` → `308` → `https://www.periodictable.lol` — ✅ 2026-09-11
- [ ] `MX` + `email` + `secureserver` DKIM rows still present (GoDaddy mail intact; Resend uses different hostnames, no conflict)
- [x] Security headers on `https://www.periodictable.lol` (prod only): `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy`, `Strict-Transport-Security`, `Content-Security-Policy` (see `next.config.mjs`) — ✅ 2026-09-11: all six present in the live prod response.
  - ✅ `img-src` must include `https://*.microlink.io` (the wildcard is required — Microlink hands back a sharded shot host, live vs cached). This was too narrow until 2026-09-10; found by §4b, fixed in PR #4, confirmed in the live prod response headers.
  - ℹ️ CSP ships **production-only** (dev needs webpack `eval()`), so a CSP symptom never reproduces under `npm run dev` — always test the deployed URL.
- [x] All 6 read APIs return 200 on custom domain, <2000ms each — ✅ 2026-09-11: all six `200`, slowest `0.47s` (well inside the 2000ms budget). NOTE: `/api/leaderboard` and `/api/live` do **not** exist — a `404` on those means the URL was guessed, not that the app is broken. As run:
```
for p in /api/stats /api/elements /api/table-order "/api/board?tab=crowns" "/api/activity?limit=6" "/api/search?q=carbon"; do
  echo "== $p"; curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" "https://www.periodictable.lol$p"
done
```
- [x] `GET /api/stats` shape: `{elementsTotal:122, claimedElements, unclaimedElements (=total-claimed), stakeCount, totalStakedUsd}` — summed dollars, not row counts — ✅ 2026-09-11: exact shape observed on prod.
- [x] `GET /api/elements` tiles carry `{symbol, pool, count, leader{domain,logoUrl,amount}|null}` — ✅ 2026-09-11
- [x] `GET /api/elements/Li` detail: stakes ranked desc, `prices{takeLead,joinMin}`, hidden bidders excluded — ✅ 2026-09-11: returns `prices{takeLead:5,joinMin:5}`

## 3. Money / Whop (paused now, live last)

### 3a. Paused mode (current prod expectation)
- [x] `POST /api/checkout` (no flags) → `403 {"waitlist":true}` — ✅ 2026-09-11 on prod
  - [x] …**and** the modal shows the Join-waitlist card — ✅ 2026-09-11 in a real browser on prod: tile → "Be the first — from $5" → modal body is the waitlist card, no checkout form rendered
- [x] `BASE_URL=https://www.periodictable.lol bash scripts/rehearse-release.sh paused` → 2/2 pass — ✅ 2026-09-11: `2 passed, 0 skipped` (re-run after the script's webhook-signing fix, so the edited script is itself confirmed)
- [x] `POST /api/waitlist {email}` twice → same `id` (dedupe by email), one DB row — ✅ 2026-09-11: rehearsal asserts "waitlist stores one row per email"

### 3b. Live flows (local sim: NO Whop keys → dev simulator; WITH keys → real sessions)
```
BASE_URL=http://localhost:3100 bash scripts/rehearse-release.sh live
# full: BASE_URL=… ADMIN_TOKEN=… WHOP_WEBHOOK_SECRET=… bash scripts/rehearse-release.sh live
```
- [x] First claim $8 → 200 `{paymentId, checkoutUrl}` → `POST /api/dev/pay {pay}` → `paid` → tile leader = payer — ✅ 2026-09-11
- [x] Contested $5 join → lands #2, leader untouched; tie at leader total → `409 TIE` — ✅ 2026-09-11
- [x] Take $9 → `guaranteedTake:true, reservation.reservedTotal:9`; rival take → `409 RESERVATION_CONFLICT`; pay → crown flips — ✅ 2026-09-11
- [x] Reclaim $2 by former leader → restores #1 at $10 (cumulative) — ✅ 2026-09-11
- [x] Same `idempotencyKey` + same payload → returns ORIGINAL `paymentId`; different payload → `409 IDEMPOTENCY_CONFLICT` — ✅ 2026-09-11
- [x] Expired reservation (server `RESERVATION_TTL_MS=2000`, sleep 3s) settles as ordinary stake, no crown — ✅ 2026-09-11
- [ ] Provider outage (Whop keys set, API down) → `502`, NO `checkoutUrl` (never a dead URL) — ⏳ **still open**: this is the one gate the local rehearsal skips, because it needs `WHOP_API_KEY` set and that flips the provider out of dev mode

> ✅ **2026-09-11 — live rehearsal is green: 18 passed, 1 skipped** (the skip above). Evidence per gate is the script's own output; run as documented under §3b. Two things are required to reproduce it, and both are easy to get wrong:
>
> 1. **An isolated database.** Migrate + seed a throwaway DB (`ptrehearse` was used) and override `DATABASE_URL` in the shell — shell env beats `.env`, which points at Neon prod. Never rehearse against prod.
> 2. **`WHOP_WEBHOOK_SECRET` set but `WHOP_API_KEY` deliberately *not*.** `whopEnabled()` requires **both**, so setting only the secret keeps `getProviderMode() === "dev"`, which keeps `/api/dev/pay` reachable (it `403`s whenever Whop is fully enabled) — that is what makes a charge-free money rehearsal possible. The trade-off is `whopPartiallyConfigured()` logging a dev-only checkout warning; harmless locally. Since the script only needs the secret to *sign* webhooks, this costs nothing.
>
> Server env used: `DATABASE_URL=<throwaway>`, `PAYMENTS_LIVE=true`, `NEXT_PUBLIC_PAYMENTS_LIVE=true`, `RESERVATION_TTL_MS=2000`, `ADMIN_TOKEN=<keychain>`, `WHOP_WEBHOOK_SECRET=<self-generated>`, on port 3100.

### 3c. Webhooks (needs `WHOP_WEBHOOK_SECRET`; sign like `rehearse-release.sh:sign_post`)
- [x] `payment.succeeded` with matching amount → `applied` once; replay same `id` → `duplicate`/`already-settled` — ✅ 2026-09-11
- [x] Statusless event → `ignored`, settled payment untouched — ✅ 2026-09-11
- [x] `payment.failed` → `failed`; later `succeeded` for same payment → `already-settled` (terminal) — ✅ 2026-09-11
- [x] Amount 999 vs local 7 → `amount-mismatch`, nothing applied — ✅ 2026-09-11
- [x] Missing/bad signature (either envelope) → rejected; unknown `paymentId` → recorded, nothing applied — ✅ 2026-09-11: unsigned → `401 {"error":"bad signature"}`; bogus Standard headers → `401` (proves the new header path executes and rejects cleanly rather than `500`ing); both envelopes accepted when genuinely signed

#### ✅ RESOLVED 2026-09-11 — Whop sends **Standard Webhooks** (`api_version: "v1"`)

The open question was which signature envelope Whop delivers, because the two sign **different bytes** with the same secret: get it wrong and every delivery `401`s silently, the provider retries for days, then auto-disables the endpoint — while the buyer's money is gone. Implementing one and receiving the other cannot be detected by a test suite that signs with the scheme it verifies (it was green for months). **The answer is now known from a real delivery, not a guess:**

- **`api_version: "v1"` ⇒ Standard Webhooks.** The endpoint was registered as v1 and the first genuine delivery from Whop's dashboard returned `200` with `[whop-webhook] verified via standard signature`. Before commit `3f23d62` (deployed 2026-09-11, ~20 min prior) **every real delivery would have `401`ed.**
- **Dual-accept stays, deliberately.** Legacy (`x-whop-signature`, hex over the body alone) is still accepted, because the envelope is fixed when the webhook resource is created — a differently-configured or re-created endpoint would otherwise silently break again. Coverage: a `lib/webhook.test.ts` case plus a rehearsal assertion that re-delivers the same event legacy-signed, so v2/v5 does not regress unnoticed.
- **Instrument:** every delivery logs `[whop-webhook] verified via standard|legacy signature`. That one line answered the whole question — read it in Vercel logs on the first real payment.
- **`payment.succeeded` never 2xx on a non-paid setup:** Whop's dashboard **"Send test event"** fixture is a car-detailing demo (`inv_xxxxxxxxxxxxxx`, "Ceramic Coating Package", `marcus@shinetime.example`, `api_version:"v1"`), and it is sent **twice** (~3 s apart). It carries no `plan.metadata.paymentId`, so it always lands as `IGNORED / no-paymentId` and **can never move money**. Keep it as a negative test: `invoice.paid` *is* in `PAID_EVENT_TYPES` and the fixture says `status:"paid"`, yet the payment-id gate fails closed first — the correct failure mode.
- ✅ **Signature secret confirmed genuine** (the signature verified), and **payment-id location confirmed aligned**: our checkout writes `data.plan.metadata.paymentId` + `metadata.paymentId` (`lib/whop.ts:46,51`), which is exactly what `paymentIdFromWhopPayload` reads first (`lib/whop.ts:151`). Real payments will settle.
- ⏳ **Still unproven:** no *real* (non-test) Whop event has ever been received, so live settlement against actual Whop money is untested. That is what the `$1` claim in §7 exercises — watch for the `verified via standard signature` line and the `applied` outcome on that first one.
- ℹ️ **Unrelated but worth knowing:** `WHOP_API` in `lib/whop.ts:26` still points at the deprecated `https://api.whop.com/api/v2`. This is **independent** of the webhook envelope (the webhook's `api_version` describes the delivery format, not the checkout API), so nothing is broken — but it is a maintenance item to track.
  - **Not proven:** exact live event type names beyond `invoice.paid` (seen in the fixture), and whether failures arrive as `invoice.payment_failed` or another spelling. `PAID_EVENT_TYPES`/`PAID_STATUSES` in `lib/whop.ts:166-175` remain the best available guesses for anything not yet observed.
- ✅ 2026-09-11: signed fixtures for **both** envelopes now exist in `lib/webhook.test.ts` (~11 cases: standard-over-body-alone and legacy-over-signed-form both rejected), so the contract is locked in tests rather than prose.
- ℹ️ Register the webhook as **explicit events** (API) or **All** (dashboard) — a narrower selection can omit a reversal/chargeback type, and a missed reversal never unwinds the stake.

## 4. Email + background jobs

### 4a. Resend live test (manual, NOW — 09-09 key in chat is INVALID, never reuse)
- [x] Resend → API Keys → fresh `periodictable-prod` key (Sending access) exists (2026-09-10: exposed key deleted + recreated after chat exposure)
- [x] Resend → Domains → `periodictable.lol` = Verified (proven: direct-API mail delivered 2026-09-10)
- [x] Vercel → Env Vars → `RESEND_API_KEY=re_…` (fresh) → Save; ⚠️ `EMAIL_FROM` currently `info@`, handoff expects `hi@` — align to `hi@` + redeploy when convenient (both work, same verified domain)
- [x] Deployments → ⋯ → Redeploy (public vars bake at build) — done 2026-09-10
- [x] Direct Resend API test → inbox delivery ✅ (landed in Gmail spam — expected: bare "prod test" content from a fresh domain, no List-Unsubscribe; real receipt/outbid mails carry proper content + one-click headers and will fare better; reputation builds with volume)
- [x] Rotate after any chat exposure: delete + recreate + Vercel update + redeploy — done 2026-09-10
- [x] Full pipeline test (`POST /api/dev/pay` → `POST /api/jobs/outbox` → `EmailLog=sent`) — **done 2026-09-11** locally against Postgres `ptl_dev` (`ptl-local` :55440) with a dev server on :3100 and `DATABASE_URL` **overridden in the shell** (shell env beats `.env`, which points at Neon prod — never run this recipe without the override). NOTE: `/api/dev/pay` is 403 on prod by design (Whop keys set), so this runs locally, never against prod.
  - ⚠️ **Blocker found first:** `ptl_dev` was schema-drifted — migration `0005_refund_reversals` had never been applied, so `POST /api/checkout` returned a bare **500** (`P2022: The column 'Payment.refundedAt' does not exist in the current database`). Fixed with `prisma migrate deploy` (purely additive: one new enum value + one nullable column).
  - ✅ **The chain, as observed:** `POST /api/checkout` (element `Ps`, `path:"take"`, $6, `attest:true`) → `{paymentId, checkoutUrl:"/pay/…", provider:"dev", guaranteedTake:true}` → `POST /api/dev/pay` → `{ok:true,status:"paid",terminal:true,elementSymbol:"Ps"}` → ledger consistent: `acmecorp-test.io` rank 1 `isLeader=true`, prior holder `holo-ps.dev` ($5) demoted to rank 2, `Element.totalPoolUsd` $5→$11, `Payment.paidAt` set, 1 `ProviderEvent`.
  - 🔴 **Correction to this row's own assertion: `EmailLog=sent` is not reachable locally, and `sent` was the wrong thing to assert.** `lib/email.ts` short-circuits `deliver()` to `"logged"` when `RESEND_API_KEY` is unset — deliberately ("sends are logged as EmailLog{status:'logged'} so the pipeline is testable end-to-end locally"). Observed row: `to=pipeline-test@example.org, template=receipt, status=logged, elementSymbol=Ps, amountUsd=6, detail="You're #1 in Ps (Positronium) 🎉"`. The `sent` branch was then proven **separately** through a stubbed `fetch` calling `sendReceiptEmail` directly: exactly 1 POST to `api.resend.com/emails`, `Authorization` present, `List-Unsubscribe: <https://periodictable.lol/api/unsubscribe?token=…>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, `from` = `periodictable.lol <hi@periodictable.lol>` → `EmailLog.status=sent`. So **`logged` proves the pipeline, the stub proves the wire format; only a real key proves delivery** (see §4c / the Resend key rows).
  - ℹ️ **`POST /api/jobs/outbox` returned `claimed:0` — expected, not broken.** `lib/settle.ts` fires `void drainDue()` inline on every settled payment, so all three rows (`RECEIPT_EMAIL`, `STAKE_ANALYTICS`, `PREVIEW_GENERATE`) were already `completedAt`-stamped with `attempts=0` before the explicit call. Anyone replaying this recipe should read `claimed:0` as "the inline drain already won" and verify via `OutboxEvent.completedAt`, not the claim count.

### 4b. Outbox + screenshot workers
- [x] `POST /api/jobs/outbox` without secret in prod → `401`; with a valid bearer header → `{ok:true, claimed, completed, failed}` (2026-09-10: unauthenticated `401` confirmed on prod for both routes)
- [x] `POST /api/jobs/screenshot` same auth; `backfill:true` enqueues ≤50 preview-less VISIBLE startups (2026-09-10: auth confirmed; **backfill run now done and green** — see the delivery-proof row below)
- [x] Schedulers live: `.github/workflows/outbox-tick.yml` every 10 min (free — public repo, unlimited Actions minutes; runs only from `main`, so it activates when this branch merges) + `vercel.json` daily backstop (04:00/04:30) (2026-09-10: merged to `main` via PR #2; main deploy `success`; `GET /api/jobs/outbox` now `401` where it was `405` ⇒ GET aliases Vercel Cron needs are live) — ✅ the timer itself is now proven, see the next row (~7 % cadence)
- [x] `CRON_SECRET` set in Vercel **and** as a GitHub Actions repo secret with the same value → manually run the `outbox tick` workflow → `{"ok":true,…}` (not `401`) for both endpoints (2026-09-10: manual dispatch run `34467721174` green in 10s — `outbox {"ok":true,"claimed":0,"completed":0,"failed":0}`, `screenshot {"ok":true,"checked":0,"updated":0,"failed":0}` ⇒ secret matches across GitHub + Vercel; `claimed:0` = empty queue, expected)
- [x] **Prove the automatic tick actually fires** — **PROVEN 2026-09-11.** 6 `schedule` runs, all `success`, latest `2026-09-11T05:09:52Z`. The 05:09 log shows a *scheduled* run (not a manual dispatch) authenticating to prod and returning `{"ok":true,"claimed":0,"completed":0,"failed":0}` on `/api/jobs/outbox` and `{"ok":true,"checked":0,"updated":0,"failed":0}` on `/api/jobs/screenshot` ⇒ the timer really runs the job end to end, not just startup; `claimed:0` is the expected empty-queue steady state. ⚠️ **But the cadence is ~7 %**: 6 ticks in a 14 h 30 m window that should hold ~87, observed gaps 1 h 53 m – 4 h 38 m. GitHub's scheduler is best-effort and de-prioritised, so a `*/10` expression on a low-traffic repo never holds cadence. **This makes the external pinger a tightening, not a fix:** either accept the daily `vercel.json` backstop (04:00/04:30) as the floor, or add cron-job.org for 10-min retry latency. Not launch-blocking: receipts/outbid mail is sent **inline** at webhook time (the outbox is the *retry* path only) and previews render nowhere in v1, so a late tick delays a retry and never silences first-time mail. **Diagnostics wired to the same tick, 2026-09-11:** the workflow now also `GET`s `/api/jobs/config` and `/api/jobs/reconcile` with the same bearer header, as its last two steps, each guarded by `if: !cancelled()` so neither can suppress the other. Before this, **nothing** called either route — no workflow, no `vercel.json` entry, no script, only tests and docs — so the sole reader for a money contradiction was a URL nobody requested. A non-2xx fails the step, which is the entire alerting channel. **Expect the `config` step red until `TURNSTILE_SECRET` is set** (`required` finding ⇒ 503 is correct, not a broken workflow). This closes the diagnostics gap without cron-job.org, which is now a cadence-only tightening.
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
- [x] Outbox row lifecycle: `attempts<5`, exponential backoff, `lastError` persisted, operator retry endpoint works with `ADMIN_TOKEN`
  - ✅ **10 new tests** in `lib/outbox.test.ts`: claim predicate + lease, `attempts` increments only on failure, backoff shape (`min(1 h, 30 s·2^attempts)`), `lastError` truncated to 500 chars, `completedAt` set exactly once, exhausted rows are never re-claimed, the drain's batch bound, and the operator retry reset path. All DB-backed against a real Postgres.
  - 🔴 **Defect found and fixed (production):** `drainDue()` read the queue with `findMany` and then processed each row by id — and `processOutboxRowById` never consults `nextAttemptAt`, so a row the cron worker had already leased and was mid-delivery could be processed a second time ⇒ **duplicate receipt/outbid email**. `lib/settle.ts` fires `void drainDue()` on every settled payment, so the race was live in prod. `drainDue` now claims through `claimDueOutbox(limit)` (one `UPDATE … FOR UPDATE SKIP LOCKED … RETURNING id`), the same atomic path the worker uses; the row *set* selected is unchanged, so it is a pure race fix. The file doc comment ("concurrent workers never share a row") is now true of every path. Audited the other queue consumers for the same shape: both `/api/jobs/outbox` and `/api/jobs/screenshot` already claim via `claimDueOutbox` before processing, so `drainDue` was the only unclaimed path.
  - ℹ️ **Test-hygiene fix:** five files (`settle`, `moderation`, `routes`, `webhook`, `ledger`) cleaned outbox rows with `dedupeKey: { contains: "…" }`, but every real key is id-based (`receipt-${paymentId}`, `outbid-${paymentId}`, `preview-${payer.id}`), so those filters matched **0 rows** and every run leaked its rows (1848 orphaned rows had piled up, all completed or burned). They now call `purgeSettledOutbox()`, which derives keys from live `Payment` rows — so it must run **before** a test deletes its payments. `vitest.config.ts` also gained `fileParallelism: false`: all DB-backed files share one database and the outbox is a single global queue ordered by `nextAttemptAt`, so parallel files stole each other's fixtures.
  - ⚠️ **No regression test for the atomicity itself, deliberately:** reverting `drainDue` to the unlocked read still passes 10/10, because a serialized single-process test selects the same row *set* either way — only real concurrency differs. Verified instead by reasoning about `claimDueOutbox`'s single `UPDATE … SKIP LOCKED`. Do not add a "proves the lease" assertion to a non-concurrent test; it would be cargo-cult coverage.

### 4c. Receipt / outbid / unsubscribe (hand test with two emails)
- [ ] Claim → payer gets receipt with correct `{element, amount, rank, domain, viewUrl, unsubUrl}`; `EmailLog{template:receipt,status:sent}`
- [ ] Outbid → victim gets outbid mail with correct `reclaim = winner+1-victim (min 1)` and `/?el=SYM&stake=N` prefill link
- [x] `List-Unsubscribe` + `List-Unsubscribe-Post` headers present; `GET /api/unsubscribe?token=` renders a confirm form and **never mutates** (a link scanner prefetching the URL must not unsubscribe anyone) — the `POST` behind it clears the email and redirects to `/?unsub=done`. An unknown or missing token also lands on `?unsub=done`: the route deliberately returns the same shape so the endpoint is not an oracle for which tokens exist, which means the client's `?unsub=unknown` branch (`app/page.tsx:118`) is **unreachable from the real flow** (verified: no server producer exists). **Verified end to end** — headers in code (`lib/email.ts:50-51`, that they survive delivery rides along with the real send in the two lines above), and every branch of the contract live + in `lib/unsubscribe.test.ts`. The one-click path was **broken** and is now fixed; see J7 below.
- [x] **v1 product decision: a listing is set at checkout and is final** (settled 2026-09-10, after finding the manage flow had no UI). `findOrCreateCheckoutStartup` writes title/pitch/url/link/email from the checkout form; a later stake on the same domain only adds stake and never mutates the profile. So there is nothing for an owner to "manage" in v1, and no UI is missing by accident. Consequences, all verified in code:
  - [x] Listing edits are **not shipped in v1** — the magic-link backend (`lib/manage.ts`, `/api/manage/*`, `PATCH /api/startups/[domain]`) stays implemented, tested and **dormant/unreachable**. Production intentionally does not email the link (`console.warn` + TODO(v2)); non-prod still returns `debugToken` for dev convenience.
  - [x] `POST /api/manage/request` is non-committal: always `200`, same shape, rate-limited, message no longer promises a link ("Listing management is not enabled").
  - [x] No user-facing surface promises editing: grepped every `.tsx` — no manage/edit UI text exists. The receipt email's "Manage your spot →" button (which pointed at the read-only `/s/<domain>`) is now **"View your spot →"** (`emails/receipt.tsx`, prop `manageUrl`→`viewUrl`).
  - [x] Docs corrected so nobody re-adds the promise: `README.md` "Ownership", `doc/ARCHITECTURE.md` §3, `HANDOFF.md` item 5 (now deferred to v2).
  - ⚠️ v2 scope when we do ship it: 3 pages (request link, land/verify, edit form) + turn the prod email send on + make sure the receipt button points at the edit flow. Not a launch blocker.

## 5. Trust, abuse, admin, frontend honesty

- [ ] Turnstile: `TURNSTILE_SECRET` + `NEXT_PUBLIC_TURNSTILE_SITEKEY` from Cloudflare set; without them bot checks silently pass (`lib/abuse.ts`) — must not launch without
  - [x] both vars present in Vercel production, 2026-09-11
  - [ ] …**and** the widget actually renders on a live checkout — blocked until launch: the live checkout form is compiled out while paused (see the `NEXT_PUBLIC_PAYMENTS_LIVE` note below), so this cannot be checked on the paused site
- [x] Upstash: `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` set — ✅ 2026-09-11: both present in Vercel production and `Encrypted`. (Earlier notes here said "not set / rate limits degrade to per-instance memory" — that was wrong. The *values* have not been exercised; a live probe is the only way to prove the store is reachable rather than a placeholder.)
- [ ] `ADMIN_TOKEN` long random set; all `/api/admin/*` → `403` without it; report → triage → HIDE → verify → restore round-trip (see hand journey J6)
- [ ] Kill switch: `PAYMENTS_LIVE=false` + `NEXT_PUBLIC_PAYMENTS_LIVE=false` → checkout flips to waitlist in <2min via env-only redeploy (see `ops/rollback.md`)
- [ ] Grid/stats failure honesty: block API (offline/devtools) → error panels, NEVER fake all-`Unclaimed $5`/zeros. Reference pattern: `TerritoryView.tsx` error panel vs `app/page.tsx`
- [ ] HIDDEN leaks: activity feed must exclude HIDDEN; stats must not sum hidden money while boards filter VISIBLE; hidden profile `/s/<domain>` → 404; `/go/<stakeId>` refuses hidden
  - [x] hide clears `previewImgUrl` — **and nothing can put it back**. Fixed 2026-09-10. The moderate route always cleared it, but the *worker's* write was unconditional and a Microlink probe takes seconds: a `PREVIEW_GENERATE` job that started before a takedown landed **after** it and silently re-attached a preview to a HIDDEN listing, undoing the retention clear. Now `lib/outbox.ts` writes through `attachPreview()`, an `updateMany({ where: { id, moderationState: "VISIBLE" } })` — moderated rows update 0 rows and the outbox row completes without retry (no retry storm, no resurrected preview); `scripts/backfill-previews.ts` has the same guard plus a `moderationState: "VISIBLE"` target filter. Locked in by `lib/moderation.test.ts` → "preview writes respect moderation" (HIDDEN and UNLISTED both refuse, VISIBLE accepts). **How it surfaced:** this is the exact assertion that turned `main`'s CI red the first time previews started actually working (see §4b) — the DB-dependent test had always passed *because* the probe failed, so the leak was invisible until the pipeline was fixed.
- [ ] Boards: Table Order sorts totalSpent desc → crowns → domain; By-Element biggest leader stake; deterministic tie-breaks; Early-Adopter tile correct per `FirstClaim`
- [ ] Clicks: `/go/<stakeId>` attributes via sha256(ip+`CLICK_SALT`) only (never raw IP); `CLICK_SALT` private random in prod

## 6. New-user hand journeys (do all, record evidence)

- [x] **J1 Browse:** open `/` desktop + mobile → table pans/zooms, tiles show claim state/price/leader, no layout break at 360px
- [x] **J2 Search:** open search → type `carbon` → keyboard navigates, Enter opens Li drawer; screen-reader names intact
- [x] **J3 Claim (paused):** click money action → waitlist card (not checkout); join waitlist → success toast
- [ ] **J4 Claim (live sim):** fill title/pitch/URL → checkout → pay → `?paid=SYM` toast + tiles/ranks refresh, receipt email arrives
- [ ] **J5 Outbid/reclaim:** second user takes tile → victim outbid email → victim clicks reclaim link → prefilled amount → pays → crown returns
- [x] **J6 Report/moderate:** report a stake → confirm modal → admin triage → HIDE → tile/profile/`/go` hide → restore → reappears — **full round-trip verified on a local seeded DB** (`pt_j6`); prod has 0 stakes so this journey is unreachable there
- [x] **J7 Unsub (v1):** unsubscribe → emails stop, the stake still counts, homepage shows the `?unsub=done` toast (an unknown token lands on the same `?unsub=done` by design, not on `?unsub=unknown`) — **verified on a local seeded DB** (`pt_j6`); prod has no listings to unsubscribe from. **There is no manage journey in v1** — a listing is final at checkout; `POST /api/manage/request` answers politely and emails no link (§4c). Listing edits are v2.
- [x] **J8 Reduced-motion + keyboard:** `prefers-reduced-motion` → static but legible; Esc closes modals/drawers in order; 44px touch targets; no toast-behind-modal; axe E2E clean — **axe + reduced-motion + Esc order + 44px targets all done**

> **Journeys J1/J2/J3/J8 run against live paused production, 2026-09-11** (agent-browser, desktop 1280×577 + mobile 360×640); **J6 ran against a local seeded database** the same day, because production has no stakes. Evidence:
> - **J1 ✅** Real `role="grid"` of 122 `gridcell`s, every tile `unclaimed` (prod has 0 stakes), SR names `"C Carbon, unclaimed"`. Zoom out/in + Fit table present. **360px: zero horizontal overflow** (`innerWidth` 360 = `documentElement.scrollWidth` 360).
> - **J2 ✅** Search is a proper ARIA 1.2 combobox: focus **stays on the input** while `aria-activedescendant` moves `search-hit-1→2→3` **and resolves to a real element** (the check that usually fails silently); exactly one `aria-selected="true"`; ArrowUp reverses; `ca` → 6 results; Enter opens the **arrow-selected** result (Scandium), not the first.
> - **J8 ✅ (axe + reduced-motion)** axe `wcag2a,wcag2aa` → **0 violations / 22 passes**. The single "incomplete" was `color-contrast` on 314 decorative `.bg-sym-tw` watermark nodes; measured manually → **13.13–20.17 ratio, 0 failures**, and the layer root is `aria-hidden` (`components/BackgroundSymbols.tsx:88`), so it is correctly hidden from AT. Reduced-motion verified live via CDP media emulation (`matchMedia` true, `animationName: none`, `transform: none`, still visible at `opacity: .125`). Esc-closing order and 44px touch targets were open here and are recorded below.
> - **⛔ J3 found a real launch-blocking bug — fixed in `components/Modals.tsx`.** Clicking a money action correctly rendered the paused waitlist card (no `Continue to checkout`, no `cf-turnstile`, no `No refunds` anywhere in the DOM) and joining wrote a row with `source: "checkout-paused"`. **But `joinWaitlist()`'s success path called `onDone(...)` + `onClose()` and never `setWaitBusy(false)`** — relying on unmount to clear the flag. `CheckoutPreview` is mounted **once** at `app/page.tsx:364` and `<Modal open>` never unmounts it, so after **one** successful join the button stayed `"Joining…" [disabled]` **permanently and site-wide** — `if (waitBusy) return;` swallowed every later submit, plus the typed email leaked to other elements. Reproduced live on prod (joined Scandium, then Carbon showed the dead button); verified fixed on a local server — two elements, two successful joins. **This was the only conversion action on the site while paused.**
> - **J8 ✅ (Esc order)** Verified live on prod with real key presses. Search open → Esc: combobox `1 → 0`. Drawer open → Esc: drawer closed. **Stacked modal-over-drawer → Esc: `data-modal-open` `true→false`, `#app-root[inert]` cleared, drawer still open** — proving the sole-Esc-owner hand-off in `components/Modal.tsx:63-66` (`stopImmediatePropagation()`) absorbs the first Escape; a second Esc then closed the drawer underneath, so the page cascade (`app/page.tsx:157-166`) resumes correctly. (The element drawer is **not** `role="dialog"`, so the cascade runs by component state, not focus trap.)
> - **J8 ✅ (44px touch targets)** The 44px guarantees are gated behind `@media(pointer:coarse)`, so a headless mouse reports `coarse:false` and the styles never apply — a viewport-only measurement is meaningless. Measured under real coarse emulation via CDP (`Emulation.setTouchEmulationEnabled` + `setEmulatedMedia {pointer:coarse, hover:none}`): **two genuine defects found and fixed** — `components/HeroCard.tsx:73` claim CTA was `202×40` (now `202×44`) and the three `components/FooterBar.tsx` legal links were `98×17 / 93×17 / 40×17` (now `98×44 / 93×44 / 44×44`). The footer's `py` is dropped under the same media query so the pill grows to exactly 44px and its top edge lands at **64px from the bottom — still clear of the stale marker parked at 72px**. Result: **zero non-tile touch targets under 44px anywhere in the app**; desktop is byte-for-byte unchanged (`202×40`, `98×17`, nav top 49px). The 122 grid tiles stay `22×23` at every breakpoint by design — pinch-zoom is the recovery path and is real touch code (`components/TableCamera.tsx:255`).
> - **J6 ✅ (report → triage → hide → restore)** Prod has **0 stakes**, so this journey was run against a **local seeded DB** (`pt_j6`, cloned from `ptrehearse`; the stale `rehearse-take.dev` reports were deleted first so a zero-row assertion meant something). Intake: **Cancel sent nothing and wrote 0 rows**; Confirm sent exactly one POST → exactly one report (`status: OPEN`, the Hbar stake, `reason: "reported from profile"`). Triage `PATCH /api/admin/reports/:id` → `TRIAGED` ✅; negative paths **400** (bad status), **404** (unknown id), **403** (no token). Hide `POST /api/admin/startups/:domain/moderate` → **400 `REASON_REQUIRED`** with no reason, **400** on a bad state. With `HIDDEN` the takedown reached **every** public surface: profile **404**, `/go/<stakeId>` **404 `{"error":"Not found."}`** (the redirect is genuinely blocked, not just unlinked), and the listing vanished from table-order, search, board, the element API and the element page. Because a bare zero is weak evidence, a **control test** was run: searching `rehearse` returned **5** sibling listings with the hidden one **absent**. The element page renders *"1 listing is hidden from this table by moderation"* while `pool`/`count` **still include** the hidden stake — intentional, since financial history is never deleted. Restore flipped all six surfaces back (profile **200**, `/go` **302 → target**, listed again) and set `restoredAt`. **Financials survived the whole cycle untouched: 2 stakes, $18, 2 payments** — the moderation path's core safety claim. Audit trail: `REPORT_TRIAGED` plus two `PROFILE_MODERATED` rows carrying operator `j6-operator` and the reason. Prod's `/api/admin/*` returns **403** without a bearer token (checked on live).
> - **J6 — two findings, neither a code defect.** *(1) a11y, unfixed, needs a decision:* `components/ReportListingButton.tsx` swaps its visible text to `reported ✓` on success but leaves **`aria-label` = "Report …"** (stale, and it overrides the visible text for AT) and has **no `aria-live`/`role="status"`**, so a screen-reader user hears nothing and the control keeps its old name. `components/Modals.tsx` already shows the pattern to copy. *(2) ops, by design:* restoring a listing does **not** bring back the preview that hiding clears (a documented retention policy — hiding a phishing site shouldn't leave you retaining its screenshot). The only paths back are a new **paid stake** (`lib/settle.ts:229`) or an explicit `{backfill: true}` on the screenshot job, and the **daily cron never passes `backfill`** (`vercel.json` → `GET`, no body), so a *mistaken* hide leaves that tile preview-less until an operator runs `scripts/backfill-previews.ts`. Worth adding to the takedown runbook. The `attachPreview` guard from §5 (`moderationState: "VISIBLE"`) was independently re-read and re-confirmed: an in-flight Microlink probe cannot resurrect a hidden listing's preview.
> - **J7 ✅ (unsubscribe)** Run against the same local seeded DB — prod has no listings to unsubscribe from — where all 15 startups had an `unsubToken` but **none had an `email`**, so one was set as a precondition. Contract confirmed: `GET /api/unsubscribe?token=` renders the confirm form and **does not mutate** (email still set afterwards), while the `POST` behind it clears `email`, **keeps `unsubToken`** so the link stays reusable and idempotent, and **307s to `/?unsub=done`**. The homepage toast *"You're unsubscribed. Past stake still counts."* rendered at t≈2s, the query was stripped via `history.replaceState`, and it auto-dismissed by t≈7s (so poll at sub-second intervals — a one-shot check after a 5s sleep misses it). The `?unsub=unknown` control renders *"Already unsubscribed or unknown link."* correctly. **"The stake still counts" holds:** profile `200`, still in search, still on the element API, and **still `currentLeaderId` for both Hbar and Li**. Financials untouched: **2 stakes / $20 / 4 payments**.
> - **⛔ J7 found a silent-failure bug — fixed in `app/api/unsubscribe/route.ts`.** The route advertised RFC 8058 one-click (`lib/email.ts:50-51` sends both `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`) but read the token **only from the request body**, with the query-string fallback parked in the `catch`. A one-click client posts the token **in the URL** with body `List-Unsubscribe=One-Click` — which parses as *valid* form data, so that fallback never ran, `form.get("token")` returned null, and the request became a **no-op that still redirected to `?unsub=done`**. Reproduced live (307 + success toast, email unchanged): the Gmail/Yahoo native **Unsubscribe** button would tell the user they had unsubscribed and then keep mailing them — and one-click is a stated bulk-sender requirement. Fixed by taking the query token first and the body as fallback, and covered by a new `lib/unsubscribe.test.ts` (5 tests) **which fails on the pre-fix code (2 of the 5) and passes on the fix** — verified by restoring the old route temporarily. Reassuringly, `clearEmail("")` early-returns `"unknown"`, so the malformed request was a silent no-op and never a mass-unsubscribe.
> - **⚠️ Checklist drift, corrected:** no code path ever produced `?unsub=unknown`. The route returns the same shape for unknown tokens on purpose (no oracle) and always redirects to `?unsub=done`, so the client branch at `app/page.tsx:118` is unreachable in the real flow. The old text also claimed `GET` clears the email — the one thing it must never do. Both fixed in §4c.
> - Existing tests cover the waitlist **API/DB** (`manage.test.ts`) but **nothing covered the client component's state**, which is why the suite never caught this. Consider a component-level test for the paused join path.

## 7. GO / NO-GO (all must be GO)

| Gate | GO criteria |
| --- | --- |
| Codebase | lint + typecheck + test:ci (0 skipped) + audit:prod green |
| Data/domain | 122 elements, 6 APIs 200 <2s, DNS + 308 + headers correct |
| Money | paused 403 now; live rehearsal green in sim; Whop contract proven with fixtures |
| Email/jobs | fresh Resend key, inbox receipt received, cron draining outbox+screenshots |
| Trust/frontend | Turnstile + Upstash + ADMIN_TOKEN live, no HIDDEN leaks, honest error panels, kill switch rehearsed |
| Flip (LAST) | `PAYMENTS_LIVE=true` + `NEXT_PUBLIC_PAYMENTS_LIVE=true` + Whop live keys + webhook `https://www.periodictable.lol/api/webhooks/whop` registered → redeploy → $1 live claim → refund/keep → announce |

### Live-state audit of production env, 2026-09-11

Read from the Vercel API, not from memory. Two of these contradict what this
checklist said earlier, so they are recorded here rather than fixed quietly.

- **`NEXT_PUBLIC_PAYMENTS_LIVE` exists but is EMPTY** (`""`, length 0). It is
  not unset and not `false` and not `true` — it is a zero-length value.
  `lib/flags.ts` compares it with `=== "true"`, so an empty value is `false`:
  the client is paused. **The server has no `PAYMENTS_LIVE` at all**, so it is
  paused too. Both halves are consistent today, which is why nothing looks
  broken.
- **The consequence is bigger than a flag.** `components/Modals.tsx:121` is
  `const paused = !paymentsLiveClient()`. With `NEXT_PUBLIC_PAYMENTS_LIVE`
  inlined at build time as `""`, `paymentsLiveClient()` folds to `false`, so
  `paused` folds to `true` and the bundler drops the live checkout branch as
  dead code. Proof from the deployed chunks for `26f2d5e` (confirmed as the
  deployed commit via `meta.githubCommitSha`): the page chunk 85,449 bytes
  contains `How claiming works` and `waitlist` (×4) but **zero** occurrences of
  `cf-turnstile`, `Continue to checkout`, `No refunds`, or `0x4AAAAA…`. The
  attest checkbox and the Turnstile widget are not shipped to the browser at
  all right now.
- This is why the Turnstile box in §5 can only be closed after launch: there is
  no live checkout to inspect until the flip rebuilds with the flag set.
- **The flip must therefore include a redeploy.** `NEXT_PUBLIC_*` is inlined at
  build time; changing the value without rebuilding ships the old bundle and
  the site keeps showing the waitlist card forever.
- The failure mode to watch for: if `PAYMENTS_LIVE` went live while
  `NEXT_PUBLIC_PAYMENTS_LIVE` stayed empty, no widget renders, no token is ever
  sent, and `verifyTurnstile` returns `false` — so every real checkout 400s with
  "Bot check failed." with no server-side signal that anything is wrong.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` **are** present in
  production. Corrections applied to §5 and the appendix below.

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
Env vars (values in Vercel only): `DATABASE_URL`, `WHOP_API_KEY`, `WHOP_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL=https://www.periodictable.lol`, `RESEND_API_KEY`, `EMAIL_FROM`, `CLICK_SALT`, `TURNSTILE_SECRET`, `NEXT_PUBLIC_TURNSTILE_SITEKEY`, `CRON_SECRET`, `PAYMENTS_LIVE`, `NEXT_PUBLIC_PAYMENTS_LIVE`, `ADMIN_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` (optional). All of these exist in production as of 2026-09-11 except `PAYMENTS_LIVE`, which is deliberately absent while paused — and `NEXT_PUBLIC_PAYMENTS_LIVE`, which exists but is an empty string. See the live-state audit in §7.
