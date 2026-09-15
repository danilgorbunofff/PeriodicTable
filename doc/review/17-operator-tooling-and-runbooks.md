# 17 — Operator tooling and runbooks

| Field | Value |
| --- | --- |
| Phase · batch | 17 · 4 |
| Status | draft — findings registered, no fixes (read-only pass) |
| Date reviewed | 2026-09-15 |
| Commit reviewed | `9681bdcbff2435ef258224c52000e0f8d6089f5c`; live build (§5.1, §5.2) |
| Reviewer | review agent |

| Probe not run | Why | Residue |
| --- | --- | --- |
| A real `/api/admin/outbox/retry` against a stalled delivery | needs `ADMIN_TOKEN` and a terminally-failed row; no `.env` in this worktree (rules: do not create one) | U17-4 |
| A refund/chargeback end-to-end, and the Stripe dispute dashboard | read-only pass, no Stripe keys | U17-1 |
| Stripe dashboard: account members, endpoint secret state, dispute status, delivery retry policy | no dashboard access from this checkout | U17-1 |
| Vercel / Neon / GitHub / Cloudflare / Resend member lists — who holds which credential | no console access | U17-2, U17-5 |
| Neon PITR window and the branch-restore authorisation path | no console access | U17-3 |
| `scripts/rehearse-release.sh` executed against production | needs `ADMIN_TOKEN` + `STRIPE_WEBHOOK_SECRET` and writes rows; §5.6 is a static read of what it would and would not cover | R17-16 |
| `prisma/launch-seed.ts --fresh` | destructive by design; §5.5 reads the flags instead | R17-5 |
| `scripts/clear-demo-data.ts --apply` | needs `DATABASE_URL`; §5.5 reads the guards — the dry-run default is the part that matters | R17-5 |
| A database-down drill (Neon unreachable, observe what the site serves) | no access to the production project; would need the operator's console | R17-12 |

The operator surface is four API routes and one shared bearer token, with no user interface of any kind: `/admin` does not exist, nothing renders a queue, and the only place the four routes are documented is `ops/takedown.md` — whose six curl examples are un-runnable as committed, because the credential placeholder is the literal string `******` (§5.7). The two runbooks that exist (`ops/rollback.md`, `ops/takedown.md`) cover the deploy and the takedown; **nine of the thirteen runbooks the plan requires have no written procedure at all** (§3.7), and the two most likely to be needed at 03:00 — a payment that took money without settling, and a webhook that stopped being accepted — are among the missing. The destructive tooling is real and reversible in exactly one direction: `prisma/launch-seed.ts --fresh` deletes payments, provider events and audit rows against whatever `DATABASE_URL` it is handed, and its only guard is a comment claiming the situation cannot arise (`:64-65`). 16 findings, all `open`; six UNKNOWN rows name the provider-console step that settles each; seven decisions are the operator's alone (§9, D10–D16, continuing `16` §9's D1–D9).

## 1. Scope

Owns matrix cells **S8 L7=17** (ownership: what the operator can do to a listing), **S10 L1=17** (recovery: the client surface a buyer uses to get back in), **S10 L7=17** (recovery: what the operator can do for a stuck buyer), **S11 L1=17** (stewardship: what a person can see and operate) and **S11 L7=17** (stewardship: the procedures). It is also the doc of record for the **operator** row of the §1 actor checklist: *can I see it, fix it, undo it.*

Files opened: `app/api/admin/reports/route.ts`, `app/api/admin/reports/[id]/route.ts`, `app/api/admin/startups/[domain]/moderate/route.ts`, `app/api/admin/outbox/retry/route.ts` (all four quoted with line numbers in §3.1), `lib/jobs.ts`, `lib/env.ts`, `lib/manage.ts`, `app/api/manage/{request,verify,session}/route.ts`, `app/api/startups/[domain]/route.ts`, `lib/outbox.ts`, `app/api/jobs/{config,reconcile,outbox,screenshot}/route.ts`, `app/api/checkout/route.ts`, `app/api/report/route.ts`, `app/api/waitlist/route.ts`, `lib/email.ts`, `lib/clicks.ts`, `lib/unsubscribe`-consumer `app/api/unsubscribe/route.ts`, `lib/audit.ts`, `lib/settle.ts` (reversal path), `vercel.json`, `.github/workflows/outbox-tick.yml`, `ops/rollback.md`, `ops/takedown.md`, `prisma/schema.prisma`, `prisma/launch-seed.ts`, `scripts/clear-demo-data.ts`, `scripts/rehearse-release.sh`, `scripts/{check-prod-env,audit-prod,migrate-if-production}.mjs`, `scripts/{rebuild-p1-snapshot.sh,backfill-previews.ts,backfill-unsubtoken.sql}`, `package.json`, `README.md`, `.env.example` (names only).

Not this doc: the merchant-of-record and reversal mechanics belong to `07`/`08`; the client half of ownership (the manage *form*) is `09`'s S8 L1 cell and is cited, not re-reported; secret *handling* in code is `14`; the schedule that runs the workers is `13`; retention and deletion as schema are `12`; the alert channel's adequacy is `18`; the refunds *copy* is settled by 05 §7 R05-6 and the intake-mail fix by 05 §7 R05-7 — both cited, never re-reported. `doc/PROD-READINESS-CHECKLIST.md` is cited by section where it already recorded a fact (§10).

## 2. Actors

| Actor | Reaches this doc? | How |
| --- | --- | --- |
| Anonymous visitor | no | nothing here is reachable without the token; the moderation *effect* is written up in `09`/`20` |
| Paying customer | partly | via the operator, in three situations: a payment that did not settle (R17-1), a listing they want changed (R17-7), a chargeback (R17-3) |
| Defending holder | yes | the takedown path, both halves (R17-10); the appeal is `16` §7 R16-8 |
| Losing bidder | partly | the receipt/outbid mail's retry lever (R17-8) |
| **Operator** | yes, primary | the whole doc |
| Attacker | yes | the admin surface's blast radius: one shared token for moderation *and* mail retry (R17-6); the security review of the surface itself is `14` |
| Crawler | no | n/a — no crawler-reachable surface is in scope |
| Email recipient | partly | the operator's ability to re-send, and the unsubscribe-token rotation hazard (R17-4) |
| Payment provider | yes | Stripe is the counterparty in R17-1/R17-2/R17-3's procedures; the webhook endpoint is the interface |
| Future maintainer | yes | the runbook set *is* the handover document; §3.7 measures it against what exists |

## 3. Intended behaviour

### 3.1 The operator surface, exactly as built

Four routes. There is no fifth, and there is no UI.

| Route | Method | Auth | What it does | Audit | Evidence |
| --- | --- | --- | --- | --- | --- |
| `/api/admin/reports` | GET | `adminAuth` | report queue, newest first, `take: 50`, optional `?status=`; selects no email address | none (read) | `app/api/admin/reports/route.ts:9-31` |
| `/api/admin/reports/[id]` | PATCH | `adminAuth` | sets `status` (validated against four values), `note` (sliced 500), `reviewedBy` (sliced 120, defaults to `"operator"`), `reviewedAt`; never touches a stake | `REPORT_TRIAGED`, `actorRef: reviewedBy` | `.../reports/[id]/route.ts:21-41` |
| `/api/admin/startups/[domain]/moderate` | POST | `adminAuth` | `VISIBLE \| HIDDEN \| UNLISTED`; reason required for the latter two; clears `previewImgUrl` on HIDDEN; sets `restoredAt` on restore | `PROFILE_MODERATED` | `.../moderate/route.ts:27-55` |
| `/api/admin/startups/[domain]/moderate` | GET | `adminAuth` | current state + who/when/why | none (read) | `.../moderate/route.ts:58-67` |
| `/api/admin/outbox/retry` | POST | `adminAuth` | resets `attempts`, `nextAttemptAt`, `lastError` for one `dedupeKey`; 404 unknown, 409 already delivered | **none** (R17-8) | `.../outbox/retry/route.ts:13-30` |

The reads an operator has outside `/api/admin/*` are `/api/jobs/config` (config status), `/api/jobs/reconcile` (ledger divergence), `/api/stats` (public headline) and the workflow log (§5.2). There is no aggregate view of money, no customer list, and no way to see an outbox backlog: the queue depth is only ever printed by the worker as it drains (§5.2), never queried.

### 3.2 Auth semantics, and why 403 is the important number

`adminAuth` answers **403 when `ADMIN_TOKEN` is unset or mismatched, in every environment including development** (`lib/jobs.ts:31-41`); comparison is timing-safe (`:14-18`). The job routes use the other helper: `jobAuth` accepts `Authorization: Bearer $CRON_SECRET` **or** a body `secret`, and allows unauthenticated access in development (`lib/jobs.ts:20-29`). Live proof that fail-closed is the shipping behaviour, not the intent: `/api/admin/reports` → `403 {"error":"forbidden"}` and both job routes → `401 {"error":"unauthorized"}` from the public internet (§5.1).

`ADMIN_TOKEN` is an *advisory* in the config report, not a required variable (`lib/env.ts:113-119`): its absence degrades quietly — the operator loses moderation and retry while the site keeps selling. The production config report does not list it (§5.2), and the report only emits advisories it fails (`lib/env.ts:151-155`), so the token is set in production today. That inference is the only evidence available from outside; the value is never readable and this doc prints nothing (§12 U17-4).

**Job-route auth asymmetry** (a related, smaller trap for a responder with a laptop): only `/api/jobs/config` and `/api/jobs/reconcile` accept `?secret=` (`app/api/jobs/config/route.ts:35`, `app/api/jobs/reconcile/route.ts:47`); `/api/jobs/outbox` and `/api/jobs/screenshot` accept the secret in a POST body only (`app/api/jobs/outbox/route.ts:22`, `app/api/jobs/screenshot/route.ts:38`), and their GET handlers delegate to POST, so a browser visit can never drain a queue by hand. `doc/PROD-READINESS-CHECKLIST.md` §4b/§4c already records the asymmetry; it is cited here because every runbook below has to hand the responder the right form of the call.

### 3.3 Kill switches that actually exist

| Lever | Effect | Time to effect | Evidence |
| --- | --- | --- | --- |
| `PAYMENTS_LIVE=false` (+ `NEXT_PUBLIC_PAYMENTS_LIVE=false`) | checkout becomes `403 {waitlist:true}`; form compiled out of the bundle | ~1.3 min (a *new* build is required; 12/12 builds 1.1–1.6 min measured 2026-09-11) | `ops/rollback.md:3-21`, `app/api/checkout/route.ts:102` |
| Roll/restrict `STRIPE_SECRET_KEY` in the dashboard | every checkout fails closed (502) *immediately*, and keeps holding after the next deploy | seconds, provider-side | `ops/rollback.md:17-21` |
| Hide/unlist a listing | removes it from all discovery surfaces; stakes and aggregates untouched; clears the preview | one curl | `.../moderate/route.ts:17-55` |
| Block a domain | edit `BLOCKED_DOMAINS` in `lib/validate.ts` + redeploy | ~1.3 min code change | `ops/rollback.md:53` |
| Unset `ADMIN_TOKEN` | the whole admin surface fails closed — including for the operator | next deploy | `lib/jobs.ts:31-41` |

The webhook is deliberately *not* behind the payments switch (`ops/rollback.md:22-27`), which is correct: money already taken must still settle.

### 3.4 Destructive tooling

| Script | What it destroys | Guards | Evidence |
| --- | --- | --- | --- |
| `prisma/launch-seed.ts --fresh` | `deleteMany()` over `ProviderEvent, ClaimReservation, ManageToken, ManageSession, FirstClaim, Report, ClickEvent, AuditLog, ActivityLog, Payment, Stake, Startup`, then resets every element's `totalPoolUsd/stakeCount/currentLeaderId` | **none in code.** A comment asserts the case cannot arise: *"Never used in production flows — only when explicitly passed --fresh"* | `prisma/launch-seed.ts:16,62-86` |
| `tsx prisma/launch-seed.ts` (no `--fresh`) | nothing; upserts the demo board | idempotent by design | `ops/rollback.md:40,46` |
| `tsx prisma/seed.ts` | upserts | idempotent | `ops/rollback.md:40` |
| `scripts/clear-demo-data.ts` | demo-provenance rows only, with `--purge-email-log` widening it | dry-run **default**; refuses any non-local `DATABASE_URL` unless `--allow-remote` + `--force`; prints `target:` and `mode:` before acting | `scripts/clear-demo-data.ts:1-21,68-100` |

The asymmetry is the finding (R17-5): the tool that touches *demo* rows is careful, and the tool that touches *payments and audit rows* is not careful at all. `ops/rollback.md:46` even recommends re-running the seeds as recovery ("both idempotent") without mentioning that `--fresh` is the destructive sibling one flag away.

### 3.5 Build, migrate and deploy tooling

- `npm run build` = `prisma generate && node scripts/migrate-if-production.mjs && next build`; `migrate-if-production.mjs` runs `prisma migrate deploy` **only when `VERCEL_ENV=production`** — previews, local builds and CI skip it (`ops/rollback.md:33-39`). A migration that fails fails the build and the previous deployment keeps serving.
- `node scripts/check-prod-env.mjs` — 9 `REQUIRED_PROD_ENV` keys (`lib/env.ts:39-49`), exit 1 on any miss, skipped outside production.
- `npm run audit:prod` — high/critical advisory gate against `ops/accepted-advisories.json`.
- `vercel.json:3-6` — exactly two crons: outbox `0 4 * * *`, screenshot `30 4 * * *`. **The outbox has no intraday schedule on Vercel**; the 10-minute cadence is the GitHub Action (§5.2), and reconcile is on no schedule at all (§3.7 row 1).
- `scripts/rebuild-p1-snapshot.sh` — the only rehearsal of a P1-class restore; `ops/rollback.md:50` instructs using it before a real FK repair.

### 3.6 Rehearsal tooling — `scripts/rehearse-release.sh`

19 126 B. Invocation is `BASE_URL=… [live|paused]` and it needs `ADMIN_TOKEN` and `STRIPE_WEBHOOK_SECRET` to cover the operator and webhook paths; without them it **silently substitutes synthetic results** for the signed-webhook, outage and moderation blocks (`:85-89,239,249,271`) and still prints its gate checklist. It ends with a latency budget of 2000 ms (`:274-280`) and generates a run id (`:35`) that is never persisted. It is the one tool that could prove the operator surface end-to-end, and it is also the one most easily run in a degraded mode that looks green (R17-16).

### 3.7 Runbook coverage — the plan's thirteen, measured

| # | Required runbook | Exists? | What a responder has today |
| --- | --- | --- | --- |
| 1 | Stuck payment (paid, nothing changed) | **no** | `/api/jobs/reconcile` exists and reports `divergent` (live: `count:0`, §5.2) but **is on no schedule** (`vercel.json:3-6`; the Action's reconcile step runs only inside the 10-minute tick, §5.2) and no procedure says who looks, or what to do when the count is non-zero |
| 2 | Webhook failures | **no** | `ProviderEvent` rows and the route's own console lines; nothing tells the responder how to count undelivered events or what a 401 means |
| 3 | Stale signing secret | **no** | the secret is a single value (`lib/env.ts:42`); no rotation procedure, no overlap window, and the failure mode (every delivery 401s until the next deploy) is documented nowhere |
| 4 | Refund and chargeback | **no** | one line: "refund via provider dashboard (Stripe)" (`ops/rollback.md:54`). The reversal code exists (`lib/settle.ts`, batch 1 settled the copy in R05-6) but has no operator procedure |
| 5 | Dispute evidence | **no** | nothing in `ops/` mentions a dispute; no evidence pack, no deadline clock, no template |
| 6 | Hiding or unlisting content | **partial** | `ops/takedown.md:22-36` is complete and correct *except* that its curls carry `******` as the credential (§5.7) and it does not mention that restoring does not restore the preview (R17-10) |
| 7 | Moderating a report | **partial** | `ops/takedown.md:11-20` (intake → triage → statuses) is good; the queue is `take: 50` with no cursor and no count (R17-9) |
| 8 | Rotating each secret | **no** | no document lists which secret lives in which console, what breaks when it changes, or the order to do it in. The 12-item map is §5.8 of this doc |
| 9 | Redeploy and rollback | **partial, and wrong in one place** | `ops/rollback.md` covers deploy order and the kill switch; `:45`'s `prisma migrate resolve --rolled-back <name>` cannot undo anything, because 0000–0006 have no down path (R17-11, §5.4) |
| 10 | Database down | **no** | `ops/rollback.md:44-50` is a three-line gesture list (bad migrate / bad data / FK failure); nothing states what the site serves while Neon is unreachable, the PITR window, or who may authorise a restore |
| 11 | Email outage | **no** | the retry machinery exists (`lib/outbox.ts` attempts/backoff/lease) and `ops/takedown.md:38-42` shows how to retry *one* delivery; nothing covers a Resend outage, a domain misconfiguration, or how to see the queue (R17-13) |
| 12 | Abuse wave | **no** | `ops/rollback.md:52-53` is two bullets; the only immediate lever is hiding listings one at a time, and rate limits are per-instance memory because Upstash is unconfigured in production (§5.2) (R17-14) |
| 13 | Site-down comms | **no** | nothing. `ops/takedown.md:48-50` covers mail to a reporter and an owner only (R17-15) |

Two of thirteen are usable as written; eleven need writing, and two of those need correcting first.

### 3.8 What the operator can see about the promises the product makes

The takedown promise ("<24h") and the intake-mail promise were settled as *copy* in batch 1 (R05-7) and as *surfaces* in `16` (R16-12). The operator's side of that chain is thin but specific: the queue is `/api/admin/reports` (`take: 50`), the deadline is a comment (`app/api/admin/reports/route.ts:8`), report mail goes to `REPORT_NOTIFY_EMAIL` through the outbox with the same retry semantics as everything else, and the 24-hour clock has no reminder, no ageing indicator and no filter for "older than". AGE is the metric nobody reads (§5.2 shows the drain counting only what it moved).

## 4. The path walked

### 4.1 A stuck payment — the buyer paid, no element changed

1. Stripe takes the money; the webhook is the only thing that settles it (`app/api/webhooks/stripe/route.ts` → `lib/settle.ts`). Batch 1 settled the settlement behaviour; what matters here is the operator's view of it.
2. If the webhook was rejected (bad signature) the event is not stored as a `ProviderEvent` at all (the route 401s before writing — `ops/rollback.md:25-27`), so the operator sees **nothing**: no row, no counter, no alert. The buyer sees a charge and no crown.
3. If the webhook was accepted but the settle path threw, `lib/settle.ts:71`'s structured log and `:103`/`:286`'s non-blocking errors are the only trace, in the deployment's logs; the ledger check that would catch it is `/api/jobs/reconcile`, which nobody scheduled (§3.7 row 1).
4. What the operator can do today: run reconcile by hand (`GET /api/jobs/reconcile?secret=…`, status-code-only auth, §3.2), then look up the payer in the Stripe dashboard (no lookup by email exists in the product — `16` R16-5), and finally re-deliver the receipt with `/api/admin/outbox/retry {"dedupeKey":"receipt-<paymentId>"}` (`ops/takedown.md:38-42`) — which is a *mail* retry, not a settlement retry, and the two are easy to confuse at 03:00. There is no documented action that re-settles a payment.
5. Verdict: the tools are half-present and the procedure is absent (R17-1). The failure is silent in three of the four branches.

### 4.2 A complaint arrives

Report → `Report{OPEN}` → mail to `REPORT_NOTIFY_EMAIL` (batch 1's fix, cited) → the operator's queue (`take: 50`, newest first) → inspect the URL → contain with hide/unlist → record the decision. Every step works; two gaps are structural rather than cosmetic: the queue's 50-row window silently drops the *oldest* reports during a wave (R17-9, and the oldest are the ones ageing past the promise), and a hidden listing's preview is deleted and never comes back (R17-10), so "restore" is not the inverse of "hide".

### 4.3 A refund or a chargeback

Stripe refund → `charge.refunded` → the reversal path in `lib/settle.ts` (batch 1 owns the mechanics; the copy now describes it, R05-6, cited). Operator side: there is no refund runbook, no decision rule for who approves, and no dispute clock anywhere in `ops/` (R17-3). The one thing the code does guarantee is the evidence trail's *existence* — `Payment`, `Stake`, `ProviderEvent`, `AuditLog` keep financial history by design (`.../moderate/route.ts:13-15`) — which makes it worse that `launch-seed --fresh` deletes exactly those tables (R17-5).

### 4.4 The operator who is not the author, at 03:00

Give them `ops/`: they find two documents. `takedown.md`'s first line tells them to send `Authorization: ******`, which fails; `rollback.md` tells them, for a bad migration, to run `migrate resolve --rolled-back` — which reports success while changing nothing about the schema (§5.4). The pager is a GitHub Action that has been running at 6.7 % of its nominal cadence (§5.2), the alert is a red run, and the only monitoring is a free pinger reading status codes. Everything else in this doc's required list of thirteen is unwritten.

## 5. Live evidence

### 5.1 The operator surface, from the public internet — 2026-09-15T07:33:22–24Z UTC

| Probe | Status | Body | Bytes |
| --- | --- | --- | --- |
| `GET /api/admin/reports` | **403** | `{"error":"forbidden"}` | 21 |
| `GET /api/jobs/config` | **401** | `{"error":"unauthorized"}` | 24 |
| `GET /api/jobs/reconcile` | **401** | `{"error":"unauthorized"}` | 24 |

Run as three `curl.exe -s -o … -w "%{http_code}"` calls against `https://www.periodictable.lol`; artifacts `ptl-papiadminreports.txt` (07:33:24Z), `ptl-papijobsconfig.txt` (07:33:22Z), `ptl-papijobsreconcile.txt` (07:33:24Z), sizes as above. This confirms §3.2's fail-closed semantics on the deployed build: the admin surface refuses an unauthenticated caller in production, and the job surface distinguishes 401 (secret missing) from the admin surface's 403 (admin auth never negotiates). It also means **the operator's own tools cannot be smoke-tested from outside without the token** — a fact every runbook below has to state, and the reason `scripts/rehearse-release.sh` is the right instrument for them (§3.6).

### 5.2 The 10-minute tick, measured — `gh run list` for `outbox-tick.yml`, 2026-09-15

The workflow is the operator's clock: `*/10` nominal, `workflow_dispatch{backfill}` for manual runs (`.github/workflows/outbox-tick.yml:7-15`), drain outbox `{limit:25}`, previews `{limit:10}`, then config and reconcile (`:47-58,78-97`). Measured over the runs GitHub returns: **46 runs between 2026-09-10T10:45:29Z and 2026-09-15T04:46:34Z = 9.7 runs per 24 h against 144 nominal (≈6.7 %)**; inter-run gaps minimum 1.1 min, median 141 min, maximum 400 min. A responder who assumes a 10-minute sentinel is looking at a sentinel that fires, on average, every 2 h 21 min — and slept 6 h 40 min inside the window measured.

The richest single artifact is the last run's log (`gh run view 34930125741 --log`), timestamps verbatim:

```
2026-09-15T04:46:42.3169863Z {"ok":true,"claimed":0,"completed":0,"failed":0}
2026-09-15T04:46:43.0862950Z {"ok":true,"checked":0,"updated":0,"failed":0}
2026-09-15T04:46:44.2712906Z {"ok":true,"env":"production","findings":[{"key":"UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN","severity":"degraded","detail":"Upstash is unconfigured: rate limits fall back to per-instance memory and fail open (lib/rateStore.ts)"}]}
2026-09-15T04:46:45.9423333Z {"ok":true,"paidTotal":3,"divergent":{"count":0,"samples":[]},"unverified":{"count":0,"byProvider":[],"samples":[],"note":"Paid on our own checkout figure alone: the provider's delivery stated no amount, so nothing could be cross-checked."}}
```

Three readings an operator should take from this, all of them load-bearing for the gap list:

- **The outbox drained nothing and that was reported as success** (`claimed:0`). A worker that finds no work and a worker whose cron never fired produce the same line; there is no "last successful drain at" timestamp and no queue-depth figure anywhere (§3.1; the monitoring gap is registered as a batch-4 finding in `18` §7).
- **`ADMIN_TOKEN` is configured in production** — the config report emits only advisories it fails (`lib/env.ts:151-155`), and the only finding is Upstash; had the token been unset, the `severity:"operator"` advisory at `lib/env.ts:113-119` would have been listed alongside it. So the moderation surface is live, and the token is held by someone (§12 U17-2).
- **Reconcile says `paidTotal: 3` while `/api/stats` says `stakeCount: 0, totalStakedUsd: 0`** (07:37:58Z, §5.3). `18` §5.4 owns the truth question; here it matters because the operator has two dashboards in their hands that disagree, and no document that says which one to believe when a buyer complains. `unverified.count:0` with the note "the provider's delivery stated no amount" means the cross-check is structurally unavailable for those three payments, not that they were verified.

### 5.3 The public read the operator can also see — 2026-09-15T07:37:58Z

`GET /api/stats` → `200`, 99 B, `X-Vercel-Cache: MISS`, `X-Vercel-Id: fra1::iad1::…`:

```json
{"elementsTotal":122,"claimedElements":0,"unclaimedElements":122,"stakeCount":0,"totalStakedUsd":0}
```

`app/api/stats/route.ts:8-9` caches for 30 s in-process; `:26-30` computes three counts, and the doc comment at `:11-21` records that `claimedElements` is filtered by `FACE_STAKE_WHERE` (R03-2) while `stakeCount`/`totalStakedUsd` are hidden-inclusive. Anyone using this endpoint as a launch-day dashboard is reading a number that can be zero for four different reasons (no stakes, hidden stakes, cache, a failed query surfacing as the fallback) — `18` owns the endpoint's truth, cited here because it is one of the four reads the operator has.

### 5.4 The migration directories — what can and cannot be undone

`prisma/migrations/` contains `0000_baseline`, `0001_phase1_ownership`, `0002_…`, `0003_…`, `0004_…`, `0005_refund_reversals`, `0006_stripe_provider` and `migration_lock.toml`: seven forward `migration.sql` files, **zero** files named for a down path, and zero `DROP TABLE`/`DROP COLUMN` statements anywhere (the four `DROP` matches are `ALTER COLUMN … DROP NOT NULL`/`DROP DEFAULT` in `0001_phase1_ownership` plus one comment). A migration here is one-way. `ops/rollback.md:45` nonetheless names `prisma migrate resolve --rolled-back <name>` as the remedy for a bad migration; that command only clears a *failed* migration's bookkeeping so `deploy` will retry it — it does not revert a schema, and for `0005_refund_reversals`/`0006_stripe_provider` there is nothing to revert *to* except a Neon branch restore (`:46`). A responder who follows the line and sees it succeed will believe the schema was rolled back (R17-11).

### 5.5 The destructive paths, as read

`prisma/launch-seed.ts:63-86` — `FRESH = process.argv.includes("--fresh")` (`:16`) gates a loop of twelve unconditional `deleteMany()` calls (`:66-81`) plus `element.updateMany({data:{totalPoolUsd:0, stakeCount:0, currentLeaderId:null}})` (`:82-84`). The comment above the loop is the entire guard:

```
64:     // Demo-data reset, FK-safe order (deepest dependents first). Never used in
65:     // production flows — only when explicitly passed --fresh.
```

No `confirm`, no `readline`, no `NODE_ENV`/`VERCEL_ENV` check, no `VERCEL_URL`/host inspection — the script acts on whatever `DATABASE_URL` is in scope, and `ops/rollback.md:40` presents the same script as part of the normal seed step. Setup that makes the accident plausible: a rehearsal run against a dev database leaves real `Payment`/`Stake`/`AuditLog` rows (`scripts/rehearse-release.sh` writes them by design), and the operator's two seed commands sit adjacent in the deploy runbook.

By contrast `scripts/clear-demo-data.ts` is careful: dry-run by default (`:1-21`), provenance-based selection, `target:`/`mode:` printed before it acts, and a refusal to write a non-local database unless both `--allow-remote` and `--force` are passed (`:68-100`). Not run: no `DATABASE_URL` in this worktree (rules).

### 5.6 Rehearsal coverage, as read — `scripts/rehearse-release.sh`

| Block | Needs | Behaviour when unset |
| --- | --- | --- |
| check-prod-env, audit:prod, smoke reads, latency budget 2000 ms (`:274-280`) | `BASE_URL` | runs against production or a local server |
| signed webhook delivery (HMAC over `t.<raw body>`) | `STRIPE_WEBHOOK_SECRET` | skipped with a synthetic result (`:239`) |
| outage/5xx behaviour | — | skipped when the config says the path is off (`:249`) |
| moderation round-trip (hide → inspect → restore) | `ADMIN_TOKEN` | **writes a synthetic body and continues** (`:85-89,271`) |

Not run here (needs live keys and would write rows). The consequence to register is not that the script is bad — it is better than nothing — but that its degraded mode is indistinguishable from a pass in the checklist it prints, generates a run id that is never stored (`:35`), and has no CI invocation.

### 5.7 `ops/takedown.md` as committed — the credential placeholder

Six of the file's curl examples carry the literal placeholder:

```
  3: Operator auth: `Authorization: ****** on every call below.
 13:    `curl -H "Authorization: ******" "$APP_URL/api/admin/reports?status=OPEN"`
 16/27/35/40: … -H "Authorization: ******" …
```

Line 3 is also un-terminated markdown (the backtick opens and never closes). As committed, the file's credential material is unusable: a responder must already know the header scheme and the variable name (neither appears in the file) to reconstruct `Authorization: Bearer $ADMIN_TOKEN`. `doc/PROD-READINESS-CHECKLIST.md` §J6 notes that `ADMIN_TOKEN` cannot be probed with a readable value and that production answers 403 (§5.1 confirms), so the *check* was recorded but the *documentation defect* was not (R17-10). No secret is printed in this doc; the finding is about a placeholder, not a value.

### 5.8 Secret-invalidation map (names and consequences only)

| Secret | Lives in | Rotation consequence |
| --- | --- | --- |
| `ADMIN_TOKEN` | Vercel env; used by `/api/admin/*` and the takedown runbook | immediate; old value stops working everywhere; no per-operator tokens to revoke separately (§3.2, R17-6) |
| `CRON_SECRET` | **two consoles**: Vercel env *and* the GitHub repo secret | the Action's guard step fails first (`.github/workflows/outbox-tick.yml:31-36`), so the tick goes red — a mis-rotation here is loud, which is more than the other secrets can say |
| `STRIPE_WEBHOOK_SECRET` | Vercel env; must match the endpoint's signing secret | single value, no overlap window: rotating in Stripe first 401s every delivery until the env change deploys (~1.3 min, `ops/rollback.md:14-17`); nothing retries *from our side* (R17-2) |
| `STRIPE_SECRET_KEY` | Vercel env; also the emergency brake (`ops/rollback.md:17-21`) | checkout fails closed until replaced; deliberate use is the kill switch |
| `RESEND_API_KEY` / `EMAIL_FROM` | Vercel env; `lib/email.ts:41` returns `"logged"` when the key is unset | mails silently stop being delivered and start being recorded as sent-from-our-side; only `EmailLog`/outbox state shows it (R17-13) |
| `CLICK_SALT` | Vercel env (`lib/clicks.ts:14`, default `ptl-dev-salt`) | **permanently disconnects** historical `ClickEvent.ipHash`/`AuditLog.actorRef` from the same visitor — rotation is a data-continuity event, not a hygiene step |
| `DATABASE_URL` | Vercel env (Neon) | must be rolled with a deploy; old credential must be revoked in Neon, and PITR access is a separate credential |
| `NEXT_PUBLIC_TURNSTILE_SITEKEY` | Vercel env (build-time) | a mismatch makes every checkout fail; `TURNSTILE_SECRET` is server-side and is a *required* var (`lib/env.ts:39-49`) |
| `UPSTASH_REDIS_REST_URL` + `_TOKEN` | Vercel env; **unconfigured in production today** (§5.2) | nothing breaks on rotation; the pair's absence is what makes rate limits per-instance and fail-open (`lib/rateStore.ts:76,93`) |
| `REPORT_NOTIFY_EMAIL` / `WAITLIST_EMAIL` | Vercel env (settled by R05-7, cited) | mail routes to a dead mailbox if the address is retired; nothing validates deliverability |
| `Startup.unsubToken` | **per-row in the database** (`prisma/schema.prisma:132`, `@default(cuid())`) | not a secret you rotate — a value you must never regenerate in bulk: `app/api/unsubscribe/route.ts:33` looks the row up by token, so a bulk regeneration invalidates every unsubscribe link already in a buyer's inbox (CAN-SPAM exposure) |
| `Plausible` domain | `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` (build-time) | unset in production today; turning it on is a consent decision (`16` §9 D6) |

### 5.9 Access inventory — credentials by name, holders by role

| Credential / access | Where it lives | Who has it documented | If the holder is unavailable |
| --- | --- | --- | --- |
| Vercel project (deploy, env vars, crons, rollback) | Vercel dashboard | `ops/rollback.md` assumes the reader can deploy; no owner named anywhere | **no procedure.** No second deployer is documented; the two daily crons and any env fix are blocked (§12 U17-2) |
| GitHub repo secret `CRON_SECRET` + Actions | GitHub repo settings | referenced by `.github/workflows/outbox-tick.yml` only | the tick's guard step fails red; nobody is documented as watching it (`18`) |
| `ADMIN_TOKEN` (moderation, mail retry) | Vercel env | §5.2 proves it is set; no holder named | moderation and retry freeze until a new deploy; the queue keeps filling silently |
| Stripe account (payments, refunds, disputes, keys, descriptor) | Stripe dashboard | `ops/rollback.md:17-21,54` uses it; no owner named | refunds, disputes and the emergency kill switch are all unavailable (R17-3) |
| Neon (database, branches, PITR) | Neon console | `ops/rollback.md:45-50` uses PITR; no owner, no window stated | a restore cannot be authorised; R17-12 |
| Resend (sending domain, logs) | Resend console | `lib/email.ts:46` calls the API; no owner named | deliverability faults are undiagnosable (R17-13) |
| Cloudflare (DNS/Turnstile) | Cloudflare dashboard | `Turnstile` is required config; no owner named | an outage at the edge or a Turnstile key mismatch has no responder |
| The mailboxes behind `abuse@`/`payments@`/`hello@` | inbound routing, not our software | printed on the legal pages (`16` §5.5) | complaints and disputes go unanswered with no bounce anywhere we can see (U16-2) |
| The operator's own identity | **nowhere** | `16` R16-11: no entity, no address, no jurisdiction | a payment processor, a registrar or a court cannot reach the operator (`16` §9 D1) |

Every row above is a *single* holder in the product's own documents; none of them has a named second pair of hands. §12 U17-2 is the row that settles which humans those are.

## 6. Failure and edge matrix

| # | Situation | What the operator can do today | What is missing | Finding |
| --- | --- | --- | --- | --- |
| E1 | A buyer paid and their element did not change | run reconcile by hand, look the payer up in Stripe, retry the *mail* | no runbook, no scheduled reconcile no re-settle action | R17-1 |
| E2 | Webhook deliveries start 401ing | nothing — the endpoint returns 401 and the deliveries are invisible to us | alert, count, and a "what to do" that ends with the secret | R17-2 |
| E3 | The signing secret leaked | rotate it and redeploy | no overlap window, no procedure, no idea that every delivery fails until the deploy lands | R17-2, R17-4 |
| E4 | A chargeback arrives | open Stripe | no clock, no evidence pack, no template, no approval rule | R17-3 |
| E5 | A trademark complaint lands | hide/unlist/restore works | the runbook's curls are un-runnable as committed; restore loses the preview | R17-10, §5.7 |
| E6 | Someone wants their listing's text changed | **nothing** — no UI, and the API-only path is an undiscoverable PATCH | the recovery client does not exist | R17-7 |
| E7 | An abuse wave | hide listings one by one; edit the blocklist and deploy | no wave procedure, no bulk lever, rate limits fail open per instance | R17-14 |
| E8 | A cron never fires | nothing notices until someone reads a log | no heartbeat, no "last drained at"; cadence is 6.7 % of nominal | §5.2, R17-13 (`18` owns the alarm) |
| E9 | 03:00 deploy goes bad | redeploy the previous build | migrations cannot be undone; `:45` says otherwise | R17-11 |
| E10 | A migration half-applied after a good deploy | nothing | nothing — no failure, just a schema that disagrees with the code | R17-11 |
| E11 | Neon is unreachable | nothing written | what the site serves, the PITR window, who may authorise | R17-12 |
| E12 | Resend is down | retry individual deliveries once the queue is known | no way to see the queue, no outage procedure | R17-13 |
| E13 | The site is down at a peak | fix it | no status surface, no comms template, no owner | R17-15 |
| E14 | The wrong `--fresh` runs against production | restore a Neon branch, if the window is open | the script has no guard; the evidence it deletes *is* the recovery material | R17-5 |
| E15 | A secret leaks and must be rotated as an incident | rotate it | no map of which console, which consequence, or the order | §5.8, R17-4 |
| E16 | Two operators must act at once | both use the same token; `reviewedBy` is self-declared | no identities, no revocation, no attribution you can rely on | R17-6 |

## 7. Findings

### R17-1 — There is no runbook for a payment that took money without settling, and the check that would find it is on no schedule · P1 · ops

- Evidence: `/api/jobs/reconcile` exists and is the only divergence check (`app/api/jobs/reconcile/route.ts`, live body §5.2), yet `vercel.json:3-6` schedules exactly two jobs — outbox `0 4 * * *` and screenshot `30 4 * * *` — and neither is reconcile. The reconcile call inside the GitHub Action (`.github/workflows/outbox-tick.yml:88-97`) inherits that workflow's real cadence: **46 runs / 4.75 days ≈ 9.7 per 24 h against 144 nominal, median gap 141 min, maximum 400 min** (§5.2). `ops/` contains no procedure for a divergence: `ops/rollback.md` never mentions reconcile, and `ops/takedown.md:38-42`'s only money-adjacent action is an outbox retry, which re-sends mail and does not settle anything. A rejected webhook (401 before any write) leaves no `ProviderEvent` row at all (`ops/rollback.md:25-27`), so the failure the operator most needs to see is the one that stores nothing.
- Reproduction: `grep -n "reconcile" vercel.json ops/*.md` → no cron line, no runbook mention; `curl.exe -s -o NUL -w "%{http_code}" "https://www.periodictable.lol/api/jobs/reconcile"` → `401` (§5.1), i.e. the check exists and nothing unauthenticated can read it.
- Proposed fix: write the runbook with the three real inputs (Stripe dashboard payment search, `GET /api/jobs/reconcile?secret=…`, `ProviderEvent` by id), name the expected output of each, add reconcile to the daily cron (`vercel.json`) so `divergent.count > 0` has a chance of being seen, and state plainly that no action in the product re-settles a payment — the remedy is a Stripe-side re-delivery.
- **Status.** open

### R17-2 — Webhook failures and a stale signing secret have no runbook, no overlap window, and no way to count the deliveries that were rejected · P1 · ops

- Evidence: `STRIPE_WEBHOOK_SECRET` is a single value (`lib/env.ts:42`) compared timing-safely with a hard 401 (`app/api/webhooks/stripe/route.ts`, `ops/rollback.md:22-27`). A rotation in the Stripe dashboard therefore invalidates every delivery until the Vercel env change deploys — measured build time 1.1–1.6 min median 1.3 (`ops/rollback.md:14-17`) — and during that window nothing in our system records the rejected events, because the 401 precedes any persistence. There is no documented order ("env first, then dashboard" is not written down anywhere), no dual-secret acceptance in code, and no alert on a delivery failure: visibility is `18`'s finding, the missing procedure is this one. Stripe's own retry behaviour is the only thing bounding the loss, and it is not written down in `ops/` (U17-1).
- Reproduction: `Select-String -Path lib\env.ts,app\api\webhooks\stripe\route.ts -Pattern "STRIPE_WEBHOOK_SECRET"` → one env key, one consumer; `Select-String -Path ops\*.md -Pattern "webhook"` → two sentences in `rollback.md`, neither about failure or rotation.
- Proposed fix: a rotation runbook that names the order and the expected outputs (delivery succeeds after deploy, `401` before), plus either Stripe's second endpoint or a temporary `STRIPE_WEBHOOK_SECRET_OLD` accepted by the route so a rotation is not an outage; and a "webhooks stopped" section that starts from "count what we rejected" — which needs the count to exist first (`18`).
- **Status.** open

### R17-3 — Refund, chargeback and dispute-evidence runbooks do not exist; the only mention is one line · P1 · ops

- Evidence: the entire operator literature for reversals is `ops/rollback.md:54` — "refund via provider dashboard (Stripe)". The code path that records a reversal exists and batch 1 settled its copy (R05-6, cited), so the mechanics are not in question; the *procedure* is: nothing states who approves a refund, what evidence is retained, how a dispute deadline is tracked, or what the operator sends a bank. `ProviderEvent`, `Payment` and `AuditLog` hold the raw material (`.../moderate/route.ts:13-15` explicitly promises financial history is never touched), and no document says how to assemble them into an evidence pack. `16` R16-5 records the adjacent gap from the legal side (no statement descriptor, no payer lookup); this is the operational half.
- Reproduction: `Select-String -Path ops\*.md -Pattern "refund|dispute|chargeback"` → `rollback.md:54` and nothing else.
- Proposed fix: three short runbooks — refund (who, where, what message, what to check afterwards), chargeback (the clock, the response window, what to submit), and evidence pack (the exact row set: `Payment` provider ids, `ProviderEvent` bodies, `Stake`/`FirstClaim` history, `AuditLog` actor rows, the receipt as sent) — each with the copy-paste query/curl and its expected output.
- **Status.** open

### R17-4 — No secret has a rotation procedure, and two of them break data continuity or a second console when rotated · P1 · ops

- Evidence: §5.8 is the map nobody wrote down, and it contains two traps: `CLICK_SALT` (`lib/clicks.ts:14`, default `ptl-dev-salt`) is what makes `ClickEvent.ipHash`/`AuditLog.actorRef` comparable over time, so a rotation silently severs historical continuity mid-incident; and `CRON_SECRET` lives in **two** consoles (Vercel env and the GitHub repo secret, `.github/workflows/outbox-tick.yml:31-36`), so rotating one half turns the tick red. Nothing in `ops/` lists which secret lives where, what breaks, or the order to apply a rotation; `ops/takedown.md:3` cannot even tell the reader the header scheme (§5.7).
- Reproduction: `Select-String -Path ops\*.md -Pattern "rotate|rotation"` → no hits; `Select-String -Path scripts\check-prod-env.mjs -Pattern "REQUIRED"` → the 9-name list (`lib/env.ts:39-49`).
- Proposed fix: one page per secret with four lines each — where it lives, what it authenticates, what breaks while it is wrong, and the copy-paste commands to set and verify it — plus a stated order for the two-console secret and an explicit "never bulk-regenerate `unsubToken`" note (`prisma/schema.prisma:132`, `app/api/unsubscribe/route.ts:33`).
- **Status.** open

### R17-5 — `launch-seed --fresh` deletes payments, provider events and the audit log against any database it is pointed at; its only guard is a comment · P1 · ops

- Evidence: `prisma/launch-seed.ts:16` reads the flag, `:63-86` unconditionally `deleteMany()`s twelve tables including `Payment`, `ProviderEvent`, `AuditLog`, `Stake`, `Report`, `ClickEvent`, then zeroes every element aggregate. The guard is the comment at `:64-65` — *"Never used in production flows — only when explicitly passed `--fresh`"* — which asserts intent and enforces nothing: there is no `confirm`, no `readline`, no `NODE_ENV`/`VERCEL_ENV` check, no host check. `ops/rollback.md:40` puts the same script in the normal seed step, one flag away from the destructive form. The tables it deletes are exactly the material R17-3's dispute-evidence runbook would need, and the only recovery is a Neon branch restore inside a window nobody has documented (R17-12).
- Reproduction: `node --input-type=module -e ""` is unnecessary — read `prisma/launch-seed.ts:62-86`; `Select-String -LiteralPath prisma\launch-seed.ts -Pattern "confirm|readline|NODE_ENV|VERCEL_ENV"` → **0 hits**.
- Proposed fix: refuse to run when `DATABASE_URL` does not resolve to a local/dev host without an explicit second flag; print the target host and the row counts it is about to delete; require a typed confirmation; and mark it in `docs`/`README` as the one irreversible script.
- **Status.** open

### R17-6 — One shared bearer token covers moderation and mail re-send, attributes actions to a self-declared string, and cannot be revoked per person · P1 · ops + security

- Evidence: `adminAuth` compares a single `ADMIN_TOKEN` (`lib/jobs.ts:31-41`); every admin route calls it (`app/api/admin/reports/route.ts:10`, `.../reports/[id]/route.ts:13`, `.../moderate/route.ts:18,59`, `.../outbox/retry/route.ts:14`). Operator identity inside the audit trail is whatever the caller typed: `reviewedBy` is sliced to 120 chars and defaults to `"operator"` (`.../reports/[id]/route.ts:31`), `operator` likewise (`.../moderate/route.ts:35`), and `AuditLog.actorRef` is set from those strings (`:39`, `:52`). So attribution is honest only because an attacker *or* a careless operator chose to be honest. `ops/takedown.md` reinforces the pattern by instructing `"reviewedBy":"ops"` (`:17`) and `"operator":"ops"` (`:28,32,33`) for every action. Revocation is all-or-nothing (one env var, one deploy), and the token is also the credential for `POST /api/admin/outbox/retry`, which sends real mail to a real person (R17-8). Security review of the surface is `14`; the operational finding is that the product cannot answer "which human did this" or "whose access should I remove".
- Reproduction: `Select-String -Path app\api\admin\*\route.ts,app\api\admin\*\*\route.ts -Pattern "adminAuth|reviewedBy|operator"`; live `403` for an unauthenticated caller (§5.1).
- Proposed fix: either one token per operator with a name map (`ADMIN_TOKENS="alice:…,bob:…"`), or accept the shared token in writing and stop recording a free-form `reviewedBy` as if it were an identity; add a rotation step to R17-4's page and a revocation check to the incident checklist.
- **Status.** open

### R17-7 — A paying customer whose listing needs changing has no path at all: the recovery client does not exist and the API that would serve it is undiscoverable · P1 · ux + ops

- Evidence: this is matrix cell **S10 L1** (and the operator half of it). The server side is complete and unreachable: `PATCH /api/startups/[domain]` accepts title/pitch/url/linkType/logoUrl/email behind a manage-session cookie, refuses without one with 403 (`app/api/startups/[domain]/route.ts:16-66`, audit `PROFILE_UPDATED` `:60-65`). The flow that mints that cookie is documented as *not shipped*: `lib/manage.ts:10-11` — *"Flow (when it is eventually shipped): POST /api/manage/request (domain+email) → opaque token emailed → POST /api/manage/verify {token} → httpOnly session"*. A repo-wide grep for the three endpoints outside their own route files returns **zero callers in `app/`, `components/` or `emails/`** — no page, no form, no link, not even in the receipt or the outbid mail. `/api/manage/verify` answers JSON and sets the cookie (`app/api/manage/verify/route.ts:27-28`) with no page to land on, so even a hand-crafted attempt ends at a JSON body. Consequence: a buyer who wants a typo fixed, a URL corrected or their notification address changed must email the operator, and the operator has no tool either — the action is a Prisma/psql edit that bypasses the validation and the audit row the API would have written. `doc/PROD-READINESS-CHECKLIST.md:42,181` records "`/manage` backend-only"; the ownership *form* is `09`'s cell S8 L1 and is not re-reported here.
- Reproduction: `Get-ChildItem -Recurse app,components,emails | Select-String "manage/request|manage/verify|manage/session"` → only the route files and `lib/manage.ts`; `curl.exe -s -o NUL -w "%{http_code}" https://www.periodictable.lol/api/manage/request` → the route exists but nothing on the site offers it.
- Proposed fix: ship the client half — a "manage your listing" entry (receipt/outbid mail + the element drawer) that posts to `/api/manage/request` and a page that consumes the token into the session and renders the PATCH form — or, if it stays unshipped, remove the promise from the mail and give the operator a documented `psql`/admin action so the request is at least serviceable.
- **Status.** open

### R17-8 — The one operator action that sends mail to a real person writes no audit row · P2 · ops

- Evidence: `app/api/admin/outbox/retry/route.ts` imports `adminAuth`, `prisma` and the response helpers only (`:1-6`) and contains no `audit(...)` call (`:13-30`), while its two siblings in the same directory both write one (`.../reports/[id]/route.ts:35-41`, `.../moderate/route.ts:48-54`). The route re-sends whatever the `dedupeKey` names — receipts and outbid notices are the common cases (`lib/settle.ts:210,227`) — so an operator can mail a payer repeatedly (attempts are reset to 0 and backoff cleared, `:28`) with no record of who did it or when.
- Reproduction: `Select-String -LiteralPath app\api\admin\outbox\retry\route.ts -Pattern "audit"` → no hits; compare `:48` of the moderate route.
- Proposed fix: add `audit({action:"OUTBOX_RETRIED", actorType:"operator", actorRef:…})` to the retry route (needs a new action name in `lib/audit.ts:15-22`), and give the runbook's retry step the same "state the operator string" convention the moderation calls already use.
- **Status.** open

### R17-9 — The report queue truncates at 50 rows with no cursor, no count and no ageing, so a wave hides the oldest complaints · P2 · ops

- Evidence: `prisma.report.findMany({orderBy:{createdAt:"desc"}, take:50, where: status ? {status} : undefined})` (`app/api/admin/reports/route.ts:13-29`) and no pagination parameters anywhere in the route; the response is a bare array (`apiJson(rows)`, `:30`), so the operator cannot even tell whether 50 was the total. The promised triage deadline lives only as a comment — *"Operator report queue (takedown runbook: triage <24h)"* (`:8`) — and `ops/takedown.md:11` repeats it as a heading. Sorting newest-first means the rows that fall off the end are precisely the ones closest to breaching the promise.
- Reproduction: `curl -H "Authorization: Bearer $ADMIN_TOKEN" "$APP_URL/api/admin/reports?status=OPEN" | jq length` → at most 50; there is no `page`/`before` parameter to raise it.
- Proposed fix: add `?before=<createdAt>&limit=` offsetting plus a `count` and an `oldestOpenAgeHours` in the response, and make the runbook's first step read the ageing figure rather than the list.
- **Status.** open

### R17-10 — `ops/takedown.md` cannot be run as written, and it under-states what restoring does not fix · P2 · ops

- Evidence: three separate defects in the only takedown procedure. (1) The credential placeholder: `Authorization: ******` at `:3,13,16,27,35,40`, un-terminated markdown at `:3`, and no statement anywhere in the file of the header scheme or the variable name (§5.7) — a responder who is not the author cannot execute it. (2) Restore is presented as an inverse (`:33`, `:44-45`) but the moderate route nulls `previewImgUrl` on HIDDEN (`.../moderate/route.ts:45`) and nothing re-fetches it: the screenshot job only backfills a single listing when it is asked to (`app/api/jobs/screenshot/route.ts:74-76`), the daily cron sends `{"limit":10}` and never a `backfill` (`vercel.json:3-6`, `.github/workflows/outbox-tick.yml:53-58`), so a restored listing shows the fallback avatar indefinitely (`doc/PROD-READINESS-CHECKLIST.md` §J6 records exactly this residue). (3) The runbook does not warn that hiding changes no aggregate: `/api/stats`'s `stakeCount`/`totalStakedUsd` remain hidden-inclusive by design (`app/api/stats/route.ts:11-21`), so a hidden listing is still counted in the public numbers the operator may be asked about.
- Reproduction: `Get-Content -LiteralPath ops\takedown.md` → the six placeholders; `Select-String -LiteralPath .github\workflows\outbox-tick.yml -Pattern "backfill"` → none; `Select-String -Path app\api\jobs\screenshot\route.ts -Pattern "backfill"` → the parameter the cron never sends.
- Proposed fix: replace the placeholder with `$ADMIN_TOKEN` **plus** the one line that defines it (and re-check the file's markdown), add the backfill command to the restore step with its expected output, and add one sentence to the contain section stating which public numbers do not change.
- **Status.** open

### R17-11 — `ops/rollback.md` offers a migration rollback that cannot work: 0000–0006 have no down path · P2 · ops + data

- Evidence: `prisma/migrations/` holds seven forward `migration.sql` files and no down migration at all (no file matching `down`/`rollback`; no `DROP TABLE`/`DROP COLUMN` anywhere — the four `DROP` matches are `ALTER COLUMN … DROP NOT NULL`/`DROP DEFAULT` in `0001_phase1_ownership` plus a comment); §5.4 records the listing. `ops/rollback.md:45` nonetheless prescribes `prisma migrate resolve --rolled-back <name>` for "bad migrate", which only clears the failed-migration bookkeeping so `migrate deploy` will retry — it changes no schema. The only true reverse is the Neon branch restore on the next line (`:46`), which the doc states without a window, an owner or an authorisation path (R17-12). Untrue-by-omission is worse than missing here: a responder who runs the line sees success.
- Reproduction: `Get-ChildItem prisma\migrations -Directory` → `0000_baseline … 0006_stripe_provider`; `Select-String -Path prisma\migrations\*\migration.sql -Pattern "^(CREATE|ALTER|DROP)" | Select-String -Pattern "DROP (TABLE|COLUMN)"` → none.
- Proposed fix: rewrite that bullet: `migrate resolve` retries a *failed* migration and reverts nothing; the schema is forward-only; a bad `0005`/`0006` in production is a restore-and-replay decision, and the doc must say who authorises it, what the PITR window is, and what is lost between the branch point and now.
- **Status.** open

### R17-12 — There is no database-down runbook: not what the site serves, not the PITR window, not who decides · P2 · ops

- Evidence: `ops/rollback.md:44-50` is the whole of the DB literature — three bullets (bad migrate, bad data, FK failure), each naming a remedy in under a line. Nothing states what a visitor sees when Neon is unreachable (the failure mode is upstream of every route, so the honest answer has to be observed once and written down), nothing states the retention window of the branch history, and nothing names the person who may authorise a restore. The rehearsal path exists and is referenced only for FK repair (`:50`, `scripts/rebuild-p1-snapshot.sh`). `16` R16-14 and `12` own retention as data; this is the incident half.
- Reproduction: `Get-ChildItem ops` → two files; `Select-String -Path ops\*.md -Pattern "PITR|restore|outage|down"` → four lines, all gestures. A drill (stop the database, load the home page, `/api/stats`, a checkout) is the probe this doc could not run — U17-3.
- Proposed fix: a runbook with four sections — symptom (what the operator's own checks do when the DB is gone), confirmation (one query that distinguishes "database down" from "app broken"), restore (branch, PITR window, who authorises, what is replayed), and comms (R17-15). Run it once on a preview against a snapshot.
- **Status.** open

### R17-13 — There is no email-outage runbook and no way for the operator to see the queue they would be managing · P2 · ops

- Evidence: the machinery is sound — `OUTBOX_MAX_ATTEMPTS=5`, backoff `min(1 h, 30 s·2^attempts)`, a 5-minute lease and a `lastError` slice (`lib/outbox.ts:15,73-75,140,154-171`) — and `ops/takedown.md:38-42` documents the single-delivery retry. What is missing is everything around it: no procedure for a Resend outage, a revoked key or a sending-domain fault; no documented query for "how many rows are due, how many have failed, how old is the oldest"; no statement that `lib/email.ts:41` returns `"logged"` when `RESEND_API_KEY` is unset (so mails stop being delivered while the row still looks processed); and no note that a *first-attempt* failure inside a request handler is swallowed to a `console.warn` (`app/api/report/route.ts:77`, `app/api/waitlist/route.ts:66`), leaving the 04:00 drain as the backstop for a report that someone expects to be seen today. The intake mail itself is settled (R05-7, cited); the operator's ability to *observe and repair* it is not.
- Reproduction: `Select-String -Path ops\*.md -Pattern "outbox|resend|email"` → the retry block only; `Select-String -LiteralPath lib\email.ts -Pattern "logged"`; `Select-String -Path app\api\report\route.ts -Pattern "console.warn"`.
- Proposed fix: a runbook whose first step is a copy-paste query returning `{due, failed, oldestDueAt, lastDeliveredAt}`, followed by the three remedies in order (verify the key, verify the domain in Resend, retry by `dedupeKey`), with expected output after each.
- **Status.** open

### R17-14 — There is no abuse-wave runbook, and the throttle that would blunt one is unconfigured in production · P2 · ops

- Evidence: `ops/rollback.md:52-53` is the entire anti-abuse literature — blocklist a domain in code, hide a stake via report triage, refund in Stripe. The only immediate lever is one listing at a time (`.../moderate/route.ts:17-55`); blocking a whole domain class is a source edit plus a ~1.3 min deploy (`ops/rollback.md:14-17,53`); and the rate limits the intake routes rely on are per-instance memory because Upstash is unconfigured — the production config report says so in its own words: *"rate limits fall back to per-instance memory and fail open (lib/rateStore.ts)"* (§5.2, `lib/rateStore.ts:76,93`). The intake limits themselves are named and finite (`report:${ip}` and `waitlist:${ip}` at 10 per 3 600 000 ms — `app/api/report/route.ts:13`, `app/api/waitlist/route.ts:20`), but a distributed wave sees a fresh budget per serverless instance. There is no bulk moderation endpoint and no CAPTCHA on the report path (Turnstile guards checkout only).
- Reproduction: `Select-String -Path ops\*.md -Pattern "BLOCKED_DOMAINS|abuse|spam"` → one bullet; and the live config line quoted in §5.2.
- Proposed fix: write the wave runbook with a triage threshold ("N reports per hour ⇒ do X"), a bulk action (`POST /api/admin/startups/moderate-batch` or an SQL blocklist insert) so containment is not 1-by-1, Cloudflare-side rate limiting at the edge (available regardless of Upstash), and an explicit decision on enabling Upstash (§9 D15).
- **Status.** open

### R17-15 — There is no site-down comms: no status surface, no template, no owner · P2 · ops

- Evidence: `ops/` contains no comms material beyond `takedown.md:48-50`, which addresses a reporter and a listing owner, not the public. Nothing states where users would learn that a checkout failure was ours, who writes the message, or which channels exist (there is no status page in the repo: `app/` holds five page routes — `/`, `/elements/[sym]`, `/legal/[slug]`, `/pay/[paymentId]`, `/s/[domain]`). The site's own uptime reading is a free external pinger checking status codes (`doc/PROD-READINESS-CHECKLIST.md:198` context; `18` owns the monitor), and the operator's outward identity is unpublished (`16` R16-11), so there is not even a canonical name to sign the message with.
- Reproduction: `Get-ChildItem -Recurse app -Filter page.tsx` → five routes, none of them a status surface; `Get-ChildItem ops` → two files, neither about comms.
- Proposed fix: three templates (planned maintenance, active incident, resolution) with a named owner and a channel decision, plus a pre-agreed line for "your payment may have gone through — check Stripe/the receipt" because R17-1 means a payment can be taken while the site is degraded.
- **Status.** open

### R17-16 — The rehearsal script silently passes in a degraded mode, and no run of it is ever recorded · P3 · ops + testing

- Evidence: `scripts/rehearse-release.sh` substitutes synthetic bodies for the signed-webhook, outage and moderation blocks when `STRIPE_WEBHOOK_SECRET`/`ADMIN_TOKEN` are unset (`:85-89,239,249,271`) and still prints its gate checklist; the run id it generates (`:35`) is printed and never persisted, and there is no CI invocation of it (no workflow step references it). The result is a tool whose green output means "the checks that could run passed", with no record of which they were — the same failure mode as the outbox tick's `{"claimed":0}` (§5.2) and the reason this doc can only cite a static read (§5.6).
- Reproduction: `Select-String -LiteralPath scripts\rehearse-release.sh -Pattern "ADMIN_TOKEN|STRIPE_WEBHOOK_SECRET|RUN_ID|skip"`; `Select-String -Path .github\workflows\*.yml -Pattern "rehearse"` → no hits.
- Proposed fix: emit the JSON result (including skipped blocks by name) to a file the operator keeps with the run id, and either fail or annotate the exit when a *required* block was skipped; optionally run the non-secret half in CI on a preview.
- **Status.** open

## 8. Acceptance criteria

Every box is verifiable by a person who did not write this doc. None of them requires an application change to be *checked*, only to be *closed*.

- [ ] `ops/takedown.md` contains no `******`, defines its header scheme and variable in one line, and its restore step includes the preview backfill with the expected output — settles R17-10.
- [ ] A runbook exists for a payment that took money without settling, whose first step produces the reconcile body, whose second is a Stripe payment lookup, and which states that no product action re-settles — settles R17-1, E1.
- [ ] Reconcile is on a schedule (a cron entry or a workflow step) whose failure is visible to a human — settles part of R17-1; the alert half is `18`.
- [ ] A secret-rotation page exists listing every row of §5.8 with its console, its consequence and its order; the two-console secret is labelled as such — settles R17-4.
- [ ] `prisma/launch-seed.ts` refuses a non-local `DATABASE_URL` without a second explicit flag and prints the target host and affected row counts before acting — settles R17-5.
- [ ] An operator identity is recorded per action, or §9 D12 records the accepted single-token posture in writing — settles R17-6.
- [ ] Either the manage client ships (entry point + page) or the mail's promise is withdrawn and the operator has a documented action — settles R17-7; the ownership form itself is `09`'s.
- [ ] `prisma migrate resolve` is no longer described as a rollback anywhere in `ops/`, and the restore authorisation and PITR window are written down — settles R17-11, R17-12.
- [ ] A runbook exists for email outage whose first step is a copy-paste queue query with its expected output — settles R17-13.
- [ ] A runbook exists for an abuse wave with a threshold, a bulk action and the Cloudflare lever — settles R17-14.
- [ ] Inventory: every row of §5.9 names a holder **and a second pair of hands**, or the row says explicitly that none exists — settles U17-2.
- [ ] The seven decisions in §9 are recorded with a date in `FINDINGS.md`'s resolution column.

## 9. Open questions — decisions only the operator can make

Continuing `16` §9 (D1–D9); these are the operational seven, and none of them can be settled by reading the code.

- **D10 On-call.** Who reads the red Action, at what hours, and what response time does the product's own copy assume? The gap between the promise (24 h triage, 72 h takedown, five outbox attempts) and reality (median alarm interval 141 min, no paging, no owner) is a staffing decision, not a code fix. *Evidence:* §5.2, R17-13/R17-14/R17-15.
- **D11 Destructive-script authorisation.** May any holder of `DATABASE_URL` run `--fresh`/`--apply`, or does that need a second person and a named window? If the answer is "any", R17-5's guard is the only remaining control. *Evidence:* R17-5, §5.5.
- **D12 Credential custody.** Single-owner accounts or a shared vault; one shared `ADMIN_TOKEN` or one per operator; what the break-glass path is when the sole holder is unreachable. *Evidence:* §5.9, R17-6, U17-2.
- **D13 Operator UI.** Four routes and curl, or a minimal admin page (queue with ageing, moderation buttons, outbox retry)? Every operational finding here is cheaper with a UI and none of it is impossible without one — but the takedown file's placeholders show what curl-only costs under stress. *Evidence:* R17-6, R17-9, R17-10, §5.7.
- **D14 Refund authority and posture.** Who may approve, from which console, with what evidence retained, and what the standard response to a chargeback is. Cross-referenced with `16` §9 D3 (the window itself). *Evidence:* R17-3, `ops/rollback.md:54`.
- **D15 Upstash.** Enable the shared rate-limit store (the production report's single open finding today) or accept per-instance fail-open limits in writing and compensate at the edge. *Evidence:* §5.2, R17-14, `lib/rateStore.ts:76,93`.
- **D16 Status page and comms.** Whether one exists, where it lives, who writes the post, and which channels are used — the answer also decides whether R17-15's templates have somewhere to go. *Evidence:* R17-15.

## 10. Cross-references

- `ops/rollback.md` and `ops/takedown.md` — the only two procedures in the repo; §3.7 measures them against the plan's thirteen, R17-10/R17-11 correct the two defects.
- `08` — settlement, `Payment`/`ProviderEvent` as the ledger; R17-1/R17-3 depend on its mechanics, which are not re-derived here.
- `09` — the client half of ownership (S8 L1); R17-7 states the boundary explicitly and reports only the recovery client (S10 L1).
- `13` — the schedule that should run the workers; R17-1's "reconcile is on no schedule" is the operator's reading of `vercel.json:3-6`, and the cadence measurement in §5.2 is evidence for both docs.
- `14` — the security of the admin surface and secret handling; R17-6 is the operational half (attribution, revocation) and prints no value.
- `12` — retention and deletion as schema; R17-12 is the incident procedure, and §5.8's `unsubToken` hazard is a schema fact cited, not re-analysed.
- `11` — the API contracts under the four admin routes; this doc quotes them at line level for the operator's benefit.
- `18` — the alarm channel that R17-1/R17-2/R17-13/R17-14/R17-15 all depend on; nothing here is re-reported as a monitoring gap.
- `05` §7 **R05-6**, **R05-7** — the refunds copy and the intake-mail fix: settled there, cited here as the promises the operator now has to keep; the `REPORT_NOTIFY_EMAIL`/`WAITLIST_EMAIL` variable names come from `README.md:41`/`.env.example`.
- `16` — R16-5 (payer lookup), R16-8 (takedown shape), R16-11 (identity), R16-12 (queue age); `16` §9 D1–D9 are the legal decisions this doc's D10–D16 continue.
- `doc/PROD-READINESS-CHECKLIST.md` — cited by section: §4b/§4c (job-auth asymmetry), §J6 (preview not restored; `ADMIN_TOKEN` not probeable), `:42,181` (`/manage` backend-only), `:156,198` (alerting channel and the 2026-09-14 live re-verify).
- `README.md:10,143-162` — the operations section and the runbook list, which names fewer procedures than §3.7 requires.

## 11. Change log

- 2026-09-15 — authored 2026-09-15 against 9681dcb. Read-only pass: no application code, config, test, migration or legal page changed; no secret printed (credential names and consequences only). Live probes at 2026-09-15T07:33:22–24Z (§5.1) and 2026-09-15T07:37:58Z (§5.3); the workflow log quoted in §5.2 is run `34930125741` from 2026-09-15T04:46:42–45Z. 16 findings (R17-1…R17-16) registered with evidence; 6 UNKNOWN rows (§12); §9 lists seven decisions for the operator (D10–D16).

## 12. UNKNOWN log

| ID | Unknown | What settles it |
| --- | --- | --- |
| U17-1 | The Stripe account's dispute state and its delivery-retry policy; whether the webhook endpoint's signing secret has ever been rotated; whether managed payments forms the same account | Stripe dashboard → **Developers → Webhooks → endpoint → signing secret** (age/rotation history), **Developers → Webhooks → endpoint → recent deliveries** (status codes and retry schedule), **Payments → Disputes** (open disputes, deadlines), **Settings → Team** — record each with a date |
| U17-2 | Which humans hold Vercel, Neon, Stripe, Resend, Cloudflare, GitHub and the `ADMIN_TOKEN`, and who is the second holder for each | Each console's **Settings → Team/Members** page, plus a written handover note committed to `doc/`; the token itself is never read out — only its holder list |
| U17-3 | The Neon project's PITR/history window on the current plan, whether branch restore is enabled, and which role may authorise it | Neon console → **Project → Settings → History/restore window** (and **Backup & restore**); then a rehearsal restore into a preview branch, timed and recorded |
| U17-4 | The production environment-variable list: which of the 9 required and 2 advisory names are set, in which environment, and when each last changed | Vercel dashboard → **Project → Settings → Environment Variables** (names, environments, updated-at) — the config endpoint proves *satisfaction* only, §5.2 |
| U17-5 | Whether a failed run of `outbox-tick.yml` reaches a human at all (watchers, notification settings, mobile) | GitHub → the workflow's **watchers/notification recipients** plus the account holder's **Settings → Notifications**; then a deliberate failure drill and a stopwatch |
| U17-6 | What the site actually serves while the database is unreachable, and whether the edge caches it | A drill (or a preview pointed at a stopped branch): load `/`, `/api/stats`, `/api/activity`, a checkout, and record status + body for each — this doc could not run it (no console access) |
