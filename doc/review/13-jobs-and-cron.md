# 13 — Jobs and cron

| Field | Value |
| --- | --- |
| Phase · batch | 13 — jobs and cron · batch 3 (the platform underneath) |
| Status | draft |
| Date reviewed | 2026-09-15 |
| Commit reviewed | `9681bdc` (`9681bdcbff2435ef258224c52000e0f8d6089f5c`, `main` at the start of this batch) |
| Reviewer | review agent (batch 3) |

## Probe not run

| Probe not run | Why | Residue |
| --- | --- | --- |
| A tick at its nominal cadence | GitHub's scheduler is best-effort and this review cannot make the repository busier. The **real** cadence is measured from the run history instead (§5.6). | The nominal `*/10` is unproven; the observed cadence is 5.1 % of it. **U13-1** |
| Vercel's execution history for the two `vercel.json` crons | Needs the Vercel dashboard (`Project → Cron Jobs`); no credentials in this checkout, and `doc/PROD-READINESS-CHECKLIST.md` §7 records that `vercel env pull` returns empty for every sensitive var and the `vca_…` CLI token `403`s. | Whether the 04:00 / 04:30 runs actually fire on the current deployment. **U13-2** |
| Observing GitHub auto-disable the workflow after 60 days of repository inactivity | Takes 60 days of silence; the repository was pushed to on 2026-09-15T07:02:17Z (§5.6), so the clock is nowhere near expiry. | The 60-day rule is quoted as platform behaviour, never as an observation. **U13-3** |
| A platform kill mid-run (30 s `maxDuration` reached with a row in flight) | Needs a real function kill; the 20 s + 10 s arithmetic in §5.10 is read from source and the self-heal that follows a kill is proven separately (§5.9). | Whether a kill costs one send or two is **U13-5** |
| `POST /api/admin/outbox/retry` against production | Destructive on production data — it re-arms a live row — and `ADMIN_TOKEN` is not available here. | The route is documented from source and from the scratch-database equivalent (`11` §5). |
| Whether an external pinger exists (cron-job.org or similar) | Operator console. The repository's own decision record says it is now optional (`HANDOFF.md:807-821`, decided 2026-09-11). | **U13-4** |

## 1. Scope

**Owns.** The unattended half of the product: what runs without a user, when, with whose authority, how much it may do per run, what makes a second run safe, what happens when one fails, and who learns about it. Concretely: the four `app/api/jobs/*` routes, every declaration that schedules them, and the one manual operator retry.

**Does not own.** The *mail* contract — what a receipt says, who is suppressed, what the footer must carry — belongs to `10` (email and notifications). The money rules that settlement follows belong to `06`/`08`, the ownership rules to `09`, and the webhook's acceptance rule to `07`. The HTTP shape of each job response (status codes, error envelope) is `11` §5; this doc adds only what is specific to unattended callers. Exploitability of the fail-open auth in §7 R13-2 is `14`. The cost of these runs is `15`.

**Scope correction to the plan.** §2 of `00-REVIEW-PLAN.md` opens this doc with "`vercel.json` schedules exactly two jobs … while the codebase also exposes `/api/jobs/reconcile` and `/api/jobs/config`". `vercel.json` does schedule exactly two (`vercel.json:3-5`), but it is **not the only scheduler**: `.github/workflows/outbox-tick.yml:9` schedules `*/10 * * * *` and calls **all four** job routes, including `reconcile` and `config` (`:44,50,56,78-98`). `gh workflow list` shows both workflows `active`. The plan's framing is therefore incomplete in the same way its "dead Turnstile entries" phrase is (`14` §5 corrects that one) — the doc answers the questions the plan asks, from the full inventory rather than the two-cron subset.

**Paths inspected.** `vercel.json:1-12`; `.github/workflows/outbox-tick.yml` (whole file, 98 lines); `.github/workflows/ci.yml:60-95`; `app/api/jobs/outbox/route.ts` (41 lines); `app/api/jobs/screenshot/route.ts` (71 lines); `app/api/jobs/reconcile/route.ts` (101 lines); `app/api/jobs/config/route.ts` (40 lines); `app/api/admin/outbox/retry/route.ts` (31 lines); `lib/jobs.ts` (41 lines); `lib/outbox.ts` (221 lines); `lib/email.ts:1-100`; `lib/env.ts:1-170`; `lib/screenshots.ts:55-100`; `lib/settle.ts:70-80,275-290`; `app/api/report/route.ts:70-80`; `app/api/waitlist/route.ts:60-70`; `lib/stripe.ts:118-126`; `README.md:145-160`; `HANDOFF.md:125-140,800-830`; `doc/PROD-READINESS-CHECKLIST.md` §4b, §7.

## 2. Actors

| Actor | Who they are | What this phase must check for them |
| --- | --- | --- |
| The operator (owner) | One human, also the only admin; holds `CRON_SECRET`, `ADMIN_TOKEN`, the Vercel and GitHub accounts | That every failure has a name and reaches him, and that a manual recovery path exists for a stuck row. |
| The paying customer | Bought an element; expects a receipt and to be notified if outbid | That the mail he was promised is not silently dropped when a third party is down — and that a retry cannot send it twice. |
| The outbid customer | Was outbid by someone else | Same as above, for `OUTBID_EMAIL`, which shares the queue with receipts. |
| The listing owner | Registered a startup; may have no preview image | That preview generation eventually happens, and that its absence does not block anything a customer sees in v1. |
| The anonymous visitor | Loads the board | That no job endpoint answers him anything, including whether a job exists or what its config is. |
| The scheduler | Vercel Cron and the GitHub Actions timer | That a tick is authenticated, bounded, idempotent, and safe to run twice at once. |
| The providers | Stripe (webhook), Resend (mail), microlink (preview capture) | That a provider outage slows work but never silently discards it, and never re-bills or re-sends because of a retry. |
| The admin | Bearer `ADMIN_TOKEN`, manually retrying one row | That the retry is authorised, auditable, and cannot re-send something that already went out (§7 R13-1's neighbour, `11` R11-4). |
| The attacker | Anyone who can reach the endpoints, or trigger a preview deployment | That a non-production deployment cannot drain or forge work against the production database. **R13-2**. |
| The future maintainer | Reads this in six months | That the schedule, the bounds and the failure channels are written down where a change to any one of them is visible. |

## 3. Intended behaviour

The promise list. Each row is a claim the code makes about itself, with the file that makes it.

| # | Promise | Where it is made |
| --- | --- | --- |
| P1 | Every job invocation must authenticate. | `lib/jobs.ts:4-8` |
| P2 | In production, a missing `CRON_SECRET` rejects **every** payload rather than opening the route. | `lib/jobs.ts:21-28` |
| P3 | The manual retry requires `ADMIN_TOKEN`, and an unset token forbids rather than allows. | `lib/jobs.ts:34-40` |
| P4 | Each run is bounded: at most 25 outbox rows, at most 10 screenshot targets, and a ~20 s global deadline inside a 30 s function budget. | `app/api/jobs/outbox/route.ts:6,11,25-26`; `app/api/jobs/screenshot/route.ts:7,15-18,56-57` |
| P5 | Work is claimed exactly once, even with several workers running at once. | `lib/outbox.ts:154-168` (claim = single `UPDATE … RETURNING` over `FOR UPDATE SKIP LOCKED`) |
| P6 | A failed row is retried with exponential backoff, up to five attempts, then abandoned rather than retried forever. | `lib/outbox.ts:15,73-74,136-140` |
| P7 | Anything the deadline cut off is released by the lease and picked up by a later run. | `app/api/jobs/screenshot/route.ts:16-18`; `lib/outbox.ts:166-168` |
| P8 | A retry cannot double-charge or double-send. | `lib/stripe.ts:122` (checkout only); **contradicted for mail** — §5.12, R13-8 |
| P9 | A row that completed is not processed again. | `lib/outbox.ts:128` |
| P10 | Settlement enqueues mail and drains it inline, so the common path does not wait for a cron. | `lib/settle.ts:282` (15 s / 10 rows) |
| P11 | `report` and `waitlist` drain their own mail inline too, 3 s / 5 rows. | `app/api/report/route.ts:74`; `app/api/waitlist/route.ts:63` |
| P12 | A money contradiction is answered as a non-2xx so a status-code-only monitor fails on it. | `app/api/jobs/reconcile/route.ts:83-90` |
| P13 | A missing *required* production variable is answered as a non-2xx for the same reason, and an advisory degrades without paging. | `app/api/jobs/config/route.ts:39`; `lib/env.ts:131-140` |
| P14 | `reconcile` is deliberately **not** on the Vercel schedule; it belongs on a monitor that reads status codes. | `app/api/jobs/reconcile/route.ts:94-99` |

Where reality diverges from these, §7 registers a finding; §6 states the trigger for each divergence.

## 4. The path, walked

A row of work, end to end, with the point at which each step becomes irreversible.

1. **Enqueue.** Something with a user waiting — settlement (`lib/settle.ts:282`), a report (`app/api/report/route.ts:74`), a waitlist signup (`app/api/waitlist/route.ts:63`) — calls `enqueueOutbox`, an upsert keyed by `dedupeKey`, so enqueuing the same logical work twice produces one row (`lib/outbox.ts:62-71`). Reversible: a queued row can be rewritten in place.
2. **Inline drain (the common path).** The same request calls `drainDueWithin(15_000, 10, ["RECEIPT_EMAIL","OUTBID_EMAIL"])` in settlement, or `(3_000, 5, […])` for report/waitlist. This claims and processes up to that many rows *before responding*, so mail normally goes out inside the request that caused it. Irreversible from here: once a send leaves, it cannot be recalled.
3. **Claim by lease.** `claimDueOutbox(limit)` runs one `UPDATE` selecting due rows with `FOR UPDATE SKIP LOCKED` and pushing `nextAttemptAt` 5 minutes into the future (`lib/outbox.ts:154-168`). The push *is* the lock: the row leaves the due set for the lease duration whether or not the worker survives (§5.9).
4. **Process.** `processOutboxRowById` reads the row, dispatches on `type`, and **never throws**: `"completed"`, `"failed"`, or `"skipped"` (`lib/outbox.ts:126-149`). Irreversible: `handleOne` returning normally means the row is marked complete even when the effect did not happen (§5.7, R13-1).
5. **Failure and backoff.** A thrown handler is caught, the message is stored (500-char slice) in `lastError`, `attempts` increments, and `nextAttemptAt` moves out by `min(3_600_000, 30_000 · 2^attempts)` (`lib/outbox.ts:73-74,136-140`). So attempt 5 is already an hour away, which is why a row cannot recover within a single tick once it starts failing.
6. **Abandonment.** At five attempts the row is terminal and `processOutboxRowById` answers `"skipped"` (`lib/outbox.ts:15,128`). Nothing else moves it: no dead-letter surface, no alert (§5.11, R13-3).
7. **The tick.** `.github/workflows/outbox-tick.yml` fires `POST /api/jobs/outbox {"limit":25}` and `POST /api/jobs/screenshot {"limit":10}`, then `GET /api/jobs/config` and `GET /api/jobs/reconcile`, with `curl -fsS` and an explicit status check so a non-2xx fails the run (`:44,50,56,78-98`). A green body's counts are the only record of what it did.
8. **The Vercel backstop.** `vercel.json:3-5` runs the same two worker paths daily at 04:00 and 04:30 — a floor under the queue for the day the GitHub ticks are starved (§5.6).
9. **The manual retry.** For a row that completed wrongly or was abandoned, `POST /api/admin/outbox/retry {dedupeKey}` with `ADMIN_TOKEN` resets `attempts:0, nextAttemptAt: now, lastError: null`, returns `404` if the row does not exist and `409 ALREADY_DONE` if it is complete (`app/api/admin/outbox/retry/route.ts:14-30`). It writes **no** `AuditLog` row — that is `14` R14-9, cross-referenced rather than re-reported here.

The irreversibility that matters: **step 4 completes a row whether or not the send happened, and step 9 refuses to retry a completed row.** The two together mean a transient Resend failure is a permanent silence (§5.7).

## 5. Live evidence

Every block below records the command or read, the environment, and the observed output on **2026-09-15**. `:3211` is the production-mode build (`npx next build` then `npx next start -p 3211`); `:3215` is `npx next dev -p 3215` (my own server for this batch — a sibling session's dev server was listening on `:3212`, so no figure in this doc is taken from that port). Both are served from this checkout against a **scratch** Postgres (`postgres:16-alpine` on `127.0.0.1:55440`, migrations `0000`–`0006` replayed, then seeded) — so the queue contents below are probe-generated, not production.

### 5.1 The inventory (the artifact the plan asks for)

| Job | Trigger · schedule | Auth | Bound per run | Idempotency | Timeout vs `maxDuration` | On failure | Who finds out |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `POST`/`GET /api/jobs/outbox` | Vercel cron `0 4 * * *` (`vercel.json:3`); GitHub tick `*/10` (`outbox-tick.yml:9`); manual dispatch | Bearer `CRON_SECRET` or body `secret` (`lib/jobs.ts:19-31`) | ≤25 rows, 20 s deadline (`route.ts:6,25-26`) | One row per `dedupeKey`; claim-by-lease; completed rows skipped | 20 s deadline **+** one in-flight ≤10 s send = 30 s, exactly `maxDuration` (§5.10) | Row keeps its lease; retried by a later run; a row that *returns* on a mail error is marked complete instead (§5.7) | GitHub step `Drain email outbox` goes red on non-2xx; the JSON counts are otherwise seen by nobody |
| `POST`/`GET /api/jobs/screenshot` | Vercel cron `30 4 * * *` (`vercel.json:4`); GitHub tick; manual dispatch | Same | ≤10 targets, 20 s deadline; `backfill:true` upserts ≤50 `PREVIEW_GENERATE` rows (`route.ts:7,43-57`) | Same claim; `backfill` re-arms preview rows only, by `dedupeKey` `preview-<id>` | 20 s **+** one in-flight ≤10 s probe = 30 s, exactly `maxDuration` (§5.10) | Row keeps its lease; probe failures recorded in `lastError` | Same, step `Generate due previews` |
| `GET`/`POST /api/jobs/reconcile` | **Nothing in `vercel.json`** (deliberate, `route.ts:94-99`); GitHub tick `Reconcile — money that contradicts itself` (`outbox-tick.yml:89-98`) | Same, and additionally reads `?secret=` (`route.ts:47`) | Reads every `PAID` payment, counts all divergences, samples 5 (`route.ts:52-75`) | Read-only — running it twice is free | No deadline; unbounded row count (small by nature, docstring `route.ts:33-35`) | `divergent > 0` → **503**, body carries the samples | GitHub step red + `::error::` annotation in the run log |
| `GET`/`POST /api/jobs/config` | Same as reconcile — GitHub tick only (`outbox-tick.yml:78-87`) | Same (`route.ts:35`) | Reads `process.env`, no I/O | Read-only | Instant | Any `required` finding → **503**; advisories keep 200 (`lib/env.ts:107-140`) | GitHub step red; expect red until every required var exists |
| `POST /api/admin/outbox/retry` | Manual, operator | Bearer `ADMIN_TOKEN` only; 403 when unset or wrong, in **every** environment (`lib/jobs.ts:34-40`) | One row per call | `409 ALREADY_DONE` on a completed row; `404` on an unknown key | Instant | 400 bad JSON / 400 missing key / 404 / 409 (`route.ts:20-30`) | Nobody — no alert, and no `AuditLog` row (`14` R14-9) |
| `GET`/`POST /api/jobs/abandoned-checkouts` | GitHub tick only, step `Abandon stale checkouts` (`outbox-tick.yml:96-106`); **no** cron entry — Hobby allows two and both are spoken for (`route.ts:23-27`) | Same as the workers | ≤50 candidates, one pass `ABANDON_MAX_BATCH`; no per-row network call | Read-only candidate query, then a per-row `updateMany` that re-checks `PENDING`; only checkouts older than `CHECKOUT_ABANDON_TTL_MS` | No loop deadline; `maxDuration` 30 s and no 10 s per-row ceiling to spend it on (§5.15) | Unexpected error → **500**; the tick's `curl -fsS` fails that step | GitHub step red |

**One row above is a correction, and it is the inventory's own failure mode.** The sweep has no counterpart in the version of this doc that was authored: `/api/jobs/abandoned-checkouts` arrived in `08`'s fix pack (`6e4eca7`), after this doc was written against `9681bdc`, and nothing in the table's own rules would have caught its absence — which is what §8's last acceptance box is about. Its cells are the post-fix reading (§5.15); the other five rows are as measured on 2026-09-15, and §5.15 records where the fix pass moved their line numbers and bodies.

### 5.2 Auth, measured on the production-mode build

`curl.exe -s -o NUL -w '%{http_code}|%{size_download}B'` against `:3211`, no `CRON_SECRET` set in that process:

```
GET  /api/jobs/outbox?limit=1                 -> 401 | 24B
GET  /api/jobs/config                         -> 401 | 24B
GET  /api/jobs/screenshot?limit=1             -> 401 | 24B
GET  /api/jobs/reconcile                      -> 401 | 24B
GET  /api/jobs/outbox  (Authorization: Bearer wrong) -> 401 | 24B
GET  /api/jobs/reconcile?secret=wrong         -> 401 | 24B
POST /api/admin/outbox/retry                  -> 403 | 21B   {"error":"forbidden"}
```

All four job routes are indistinguishable to an anonymous caller, which is the property `11` §6 asserts. The same matrix on the **dev** server `:3215` answers `200` for `outbox`, `screenshot` and `reconcile`, and `503` for `config` (its findings, not its auth) — because `jobAuth` returns `null` rather than a 401 when the environment is not production (`lib/jobs.ts:25-28`). That is R13-2.

### 5.3 The four questions the plan asks, answered directly

| Question | Answer |
| --- | --- |
| Is `reconcile` supposed to be scheduled? | **Not on Vercel.** `app/api/jobs/reconcile/route.ts:94-99` says so in as many words: a cron run there "would produce a response nobody reads", and the route belongs on a monitor's URL list "next to `/api/jobs/config`". It *is* called — by the GitHub tick (§5.6), which fails the step on a non-200. |
| What is the operator cadence? | **`*/10` nominal, ~3 h in practice.** `.github/workflows/outbox-tick.yml:9` is the only cadence in the repository; the app-side paths are the daily 04:00/04:30 backstop. `lib/env.ts:137` names "every 10-minute tick" as the intended alert cadence, and `HANDOFF.md:807-821` records the 2026-09-11 decision that the external pinger is optional and the daily Vercel pair is the floor. The measured cadence is in §5.6. |
| What happens to a missed run? | **Nothing catches up, and nothing is lost.** The lease is time-based (`lib/outbox.ts:166-168`), so a row that a killed run left claimed becomes due again after five minutes and is picked up by the next tick or by the daily backstop. There is no catch-up burst: the per-run bound is fixed at 25/10, so a large backlog drains at the cadence, not faster. Worst observed gap is 6 h 40 m (§5.6), so a receipt enqueued just after a tick can wait that long; the daily backstop caps the absolute worst case at ~24 h. |
| Can the outbox back up invisibly? | **Yes, in three ways** — §5.11: a hard drain failure is caught and reported as `{completed: 0, failed: 0}`; abandoned rows sit at `attempts = 5` with no surface listing them; and no code path anywhere measures queue depth. The only depth signal that exists is the `claimed` / `checked` count in a tick's JSON body, visible to whoever reads the Actions log. |
| Can any job overlap itself? | **The queue protects itself; the schedulers protect the rest.** Two invocations at once cannot claim the same row (single `UPDATE … FOR UPDATE SKIP LOCKED`, `lib/outbox.ts:154-168`), and GitHub serialises its own ticks with `concurrency: {group: outbox-tick, cancel-in-progress: false}` (`outbox-tick.yml:19-21`). Measured: 4 concurrent drainers over 60 rows returned `20/20/20/0` with 60 completed rows and **zero** rows carrying `attempts > 1` (§5.5). |

### 5.4 Claim by lease, and the numbers around it

```
lib/outbox.ts:154-168   claimDueOutbox(limit, leaseMs = 300_000):
  UPDATE "OutboxEvent" SET "nextAttemptAt" = NOW() + lease
  WHERE id IN (SELECT id … WHERE "completedAt" IS NULL AND attempts < 5
               AND "nextAttemptAt" <= NOW() ORDER BY "nextAttemptAt" LIMIT n
               FOR UPDATE SKIP LOCKED) RETURNING id
lib/outbox.ts:15        OUTBOX_MAX_ATTEMPTS = 5
lib/outbox.ts:73-74     backoffMs(n) = min(3_600_000, 30_000 · 2^n)
lib/outbox.ts:128       "skipped" when completedAt set OR attempts >= 5
```

The lease is the whole mutual-exclusion mechanism, and it is *time*, not a heartbeat: a worker that dies holding a row costs the row one lease interval (5 minutes, §5.9) and nothing else.

### 5.5 Exactly-once, measured

Four concurrent drainers were run against a queue of 60 `STAKE_ANALYTICS` marker rows (`conc-lock-030…089`) on the scratch database:

```
worker 1 -> {"ok":true,"claimed":20,"completed":20,"failed":0}
worker 2 -> {"ok":true,"claimed":20,"completed":20,"failed":0}
worker 3 -> {"ok":true,"claimed":20,"completed":20,"failed":0}
worker 4 -> {"ok":true,"claimed":0, "completed":0, "failed":0}

SELECT count(*) FROM "OutboxEvent" WHERE "dedupeKey" LIKE 'conc-lock-%' AND "completedAt" IS NOT NULL;   -> 60
SELECT count(*) FROM "OutboxEvent" WHERE "attempts" > 1;                                                -> 0
```

20/20/20/0 is the correct split: three workers took the queue in full-size batches, the fourth found nothing due. No row was claimed twice (`attempts` never exceeded 1 on any row in the table), and the marker count is exactly 60. P5 holds under concurrency.

### 5.6 The real cadence — measured, not assumed

```
gh run list --workflow=outbox-tick.yml --limit 200 --json conclusion,event,startedAt,createdAt
gh workflow list
```

46 runs fetched; 34 were `schedule`, 12 were `workflow_dispatch` (all on 2026-09-10/11, while the workflow was being built). Over the scheduled runs:

| Metric | Value |
| --- | --- |
| Window | 2026-09-10T14:39:33Z … 2026-09-15T04:46:34Z (110.12 h) |
| Nominal `*/10` ticks in that window | 661 |
| Ticks observed | 34 → **5.1 % of nominal** |
| Gap min / median / max | **1 h 44 m / 3 h 12 m / 6 h 40 m** |
| Scheduled conclusions | 32 `success`, 2 `failure` |
| Last red tick | 2026-09-11T13:48:12Z → **26 consecutive green scheduled runs** since |
| Workflow state | `gh workflow list` → both `ci` and `outbox tick` **active** |

Two things follow. First, the workflow's own comment — "GitHub cron is best-effort and may fire a few minutes late" (`outbox-tick.yml:5-6`) — understates the observed behaviour by roughly 19×, and `doc/PROD-READINESS-CHECKLIST.md` §4b already recorded the same effect on 2026-09-11 ("the cadence is ~7 %: 6 ticks in a 14 h 30 m window that should hold ~87"): this measurement confirms it over a longer window and adds the median. Second, the 2 red ticks and 26 green ones prove the alert path *works* — a non-2xx really does fail the run — which is what makes R13-3 a finding about **latency and reach**, not about a missing channel. The repository's own decision record (`HANDOFF.md:807-821`) accepts the daily Vercel pair as the floor; the cost that decision did not price is detection latency for `reconcile` and `config`, which are on this tick and nowhere else.

### 5.7 "Completed" does not mean "delivered"

Two independent witnesses, both in the code and both confirmed against the scratch database.

**(a) A failed send completes the row.** `deliver()` returns `"error"` for a non-2xx response and for a thrown request (`lib/email.ts:66,68`) — it does not throw. `handleOne`'s email cases therefore return normally, and `processOutboxRowById` marks the row complete (`lib/outbox.ts:126-134`). The next run skips it (`:128`), and the operator's own recovery tool refuses it (`409 ALREADY_DONE`, `admin/outbox/retry:25`). A Resend 500 at 04:00 is a permanently unsent receipt.

**(b) A completed row may never have been sent at all.** With `RESEND_API_KEY` unset, `deliver()` returns `"logged"` and writes an `EmailLog` row instead of sending (`lib/email.ts:41`, `lib/email.ts:20-35`). Whole-table read on the scratch database, 2026-09-15:

```
SELECT type, count(*) FROM "OutboxEvent" GROUP BY type;
  STAKE_ANALYTICS 78 | REPORT_EMAIL 14 | WAITLIST_EMAIL 11 | RECEIPT_EMAIL 7 | PREVIEW_GENERATE 6
SELECT count(*) FROM "OutboxEvent" WHERE "completedAt" IS NULL;   -> 0
SELECT count(*) FROM "OutboxEvent" WHERE "attempts" >= 5;         -> 0
SELECT max("attempts") FROM "OutboxEvent";                        -> 0
SELECT status, count(*) FROM "EmailLog" GROUP BY status;          -> logged 32
```

115 rows, all complete, zero abandoned, zero retried, and **every** one of the 32 `EmailLog` rows is `logged` — not one real send in the whole exercise. That is correct for a dev environment (`lib/email.ts:41` is doing its job), and it is exactly why "completed" cannot be read as "delivered". The same distinction applies to `STAKE_ANALYTICS`, which has no sink at all — its handler's comment says so (`lib/outbox.ts:115-116`) — yet 78 such rows are marked complete. A queue whose completion means "the handler did not throw" cannot answer the question the operator will ask it: *did the customer get the mail?* Only `EmailLog.status` can, and nothing reads it.

### 5.8 The screenshot worker claims other people's rows

```
app/api/jobs/screenshot/route.ts:58   const claimed = await claimDueOutbox(limit);   // no type filter
app/api/jobs/screenshot/route.ts:65   if (!row || row.type !== "PREVIEW_GENERATE") continue;
app/api/jobs/screenshot/route.ts:70   return NextResponse.json({ ok: true, checked: claimed.length, updated, failed });
```

`claimDueOutbox` takes no type argument in this route, so the claim is over **every** due row; rows of other types are read, skipped, and left claimed. The claim is a lease rather than a status change — it only pushes the row's own `nextAttemptAt` forward (`lib/outbox.ts:154-168`) — so such a row is not lost, it is unavailable to the worker that could process it until the lease expires. Measured on `:3215` (dev) with one `STAKE_ANALYTICS` row (`probe-park-b3-0001`) made the only due row:

```
$ curl.exe -s "http://127.0.0.1:3215/api/jobs/screenshot?limit=1"   # no credential required off production (R13-2)
{"ok":true,"checked":1,"updated":0,"failed":0}|HTTP 200

SELECT "dedupeKey", attempts, "completedAt",
       round(EXTRACT(EPOCH FROM ("nextAttemptAt" - now()))) AS lease_seconds
  FROM "OutboxEvent" WHERE "dedupeKey" = 'probe-park-b3-0001';
probe-park-b3-0001 | 0 |  | 299

$ curl.exe -s "http://127.0.0.1:3215/api/jobs/outbox?limit=5"       # the worker that *could* do this work, immediately after
{"ok":true,"claimed":0,"completed":0,"failed":0}|HTTP 200

$ sleep 310; curl.exe -s "http://127.0.0.1:3215/api/jobs/outbox?limit=5"
{"ok":true,"claimed":1,"completed":1,"failed":0}|HTTP 200
probe-park-b3-0001 | 0 | t
```

Three properties are visible in that transcript. The row is invisible to the outbox drain for the length of the lease (299 s of a 300 s lease). The invisibility leaves no trace: `attempts` stays `0` and `completedAt` stays null, so the row reads as untouched, while the screenshot run counts it in `checked: 1` — a number that mixes rows the job acted on with rows it merely claimed. And nothing is lost: after the lease expired the drain claimed and completed it. R13-7.

### 5.9 A claimed row needs no reaper

Because the claim is only a timestamp on the row, a worker killed mid-run (a 30 s `maxDuration` kill, a deploy, a crash) leaves nothing to clean up: the row becomes due again when its lease expires and the next tick takes it. The same property is what makes the deliberate `continue` in §5.8 cost up to five minutes of delay rather than a row.

### 5.10 The bound is the function limit, with no margin

```
app/api/jobs/outbox/route.ts:6      export const maxDuration = 30;
app/api/jobs/outbox/route.ts:25     const deadline = Date.now() + 20_000;
app/api/jobs/outbox/route.ts:31     if (Date.now() >= deadline) break;    // checked *before* each row
lib/email.ts:64                     AbortSignal.timeout(10_000)
lib/screenshots.ts:63               probeShot(url, timeoutMs = 10_000)
```

The deadline is checked between rows, so the last row always starts with up to 20 s of budget already spent and is allowed to run to its own 10 s ceiling: **20 s + 10 s = 30 s = `maxDuration`, exactly**, at both worker routes (`screenshot` has the same 20 s + 10 s shape at `:7,56,63`). There is no margin for the database round-trips the claim itself makes, and Prisma's own acquisition wait is not covered by the deadline. Exceeding 30 s means the platform kills the invocation: the response never arrives (the cron caller sees a 504/timeout, not the route's JSON), the row keeps its lease and self-heals per §5.9, and — because Vercel does not retry a failed cron invocation — the *next* run is the retry. `git grep` finds no code that shortens the deadline near the end of the loop or reserves headroom for the final row. R13-4.

### 5.11 A hard drain failure looks like an empty queue

```
lib/outbox.ts:177-191  drainDue(limit, types) { const claimed = await claimDueOutbox(limit, types) … }
lib/outbox.ts:188      console.error("outbox drain failed (non-blocking):", e);
```

The claim is outside the `try`; the *processing loop* is inside it, and a throw there is logged and swallowed. `drainDueWithin` then resolves with `{completed: 0, failed: 0, timedOut: false}` — a result identical to a queue with nothing due. In the inline path this is deliberate and defensible: settlement must not fail because mail did (`lib/settle.ts:282` is called after the money is committed). In the *job* path it means the one caller that could have noticed — the tick, which only fails on a non-2xx — reads a green body. R13-6.

### 5.12 Outbound idempotency: Stripe has a key, Resend does not

```
lib/stripe.ts:122   headers: { …, "Idempotency-Key": `pt_checkout_${paymentId}` }
```

That is the **only** `Idempotency-Key` in the repository: `git grep -n 'Idempotency-Key'` matches once, on the checkout session. The Resend call carries none (`lib/email.ts:46-64`), so the mail path's retry safety rests entirely on the claim-by-lease and on `deliver()`'s 10 s abort. The hole is narrow but real: a send that Resend *accepted* but whose response did not arrive inside 10 s is scored `"error"`, and — per §5.7 — that scores a completed row, so a double send needs the aborted send to have landed *and* the operator to retry the row manually. Ranked accordingly: P3, R13-8. The mail-side contract is `10`'s; the missing key is registered here because the retry machinery is this doc's.

### 5.13 Schedule reconciliation

| Surface | Declares | Calls |
| --- | --- | --- |
| `vercel.json:3-5` | 2 crons: `/api/jobs/outbox` `0 4 * * *`, `/api/jobs/screenshot` `30 4 * * *` | those 2 paths |
| `.github/workflows/outbox-tick.yml:9` | `*/10 * * * *` + `workflow_dispatch` | `screenshot` (backfill, manual only), `outbox`, `screenshot`, `config`, `reconcile` |
| `app/api/jobs/*` | 4 routes | — |
| `/api/admin/outbox/retry` | 1 route, no scheduler | operator only |

So four routes are reachable by two schedulers and one human; `reconcile` and `config` are reached by exactly one of the three, and that one is the scheduler whose cadence is 5.1 % of nominal.

### 5.14 Vercel cron behaviour, as declared

`vercel.json:1-12` sets no `crons` options beyond the two entries (no `path` variants, no per-cron timezone). Whatever Vercel does with a failing cron invocation is platform behaviour this review cannot observe from the checkout — **U13-2** and **U13-5** carry the residue, and `15` §12 records the cost consequence of a run that is killed rather than completed.

### 5.15 Fix verification

**2026-09-16, this worktree, after the §11 fix pass.** Like the `08`–`12` passes this one ran against a real Postgres — the same `postgres:16-alpine` container (`ptl-fix08-pg`, `127.0.0.1:55433`) with all **eleven** migrations `0000`–`0010` applied, so every DB-gated suite this doc's evidence came from executed rather than skipping. What the pass could not reach is unchanged from §5: no Vercel token, no production `CRON_SECRET`, no Neon credential, no pinger. So nothing below is a statement about the deployed schedule, and U13-1…U13-6 all stand.

```
TEST_DATABASE_URL=… npm run test:ci              → 52 files passed (52); 768 passed, 0 skipped (768)
npx vitest run            (no database at all)   → 44 passed | 8 skipped (52); 641 passed | 127 skipped (768)
npx tsc --noEmit                                 → clean
npx eslint lib app emails scripts                → clean (exit 0, no warnings)
npx prisma format --check                        → All files are formatted correctly!
npx prisma validate                              → the schema at prisma/schema.prisma is valid
npx prisma migrate diff --from-url … --to-schema-datamodel prisma/schema.prisma --script → No difference detected
npm run audit:prod                               → clean (no unaccepted high/critical runtime advisories)
bash -n (each of the tick's seven run: blocks)   → rc 0, 7 of 7
VERCEL_ENV=production NODE_ENV=production node scripts/check-prod-env.mjs
    without secrets                              → "Missing production configuration:" + 10 required lines, exit 1
    with the full set                            → "check-prod-env: production config OK.", exit 0
```

Both test runs report the same 768, which is what makes the DB-less figure usable: the difference is entirely `8` files that skip without a database, not a quietly smaller suite. The pass moved the count from `12`'s 749 to **768 (+19)**, and the movement is nameable: `lib/jobsAndCron.test.ts` (**new**, 16 tests — 13 static, 3 DB-gated), `lib/ops.test.ts` 19 → 21 (the two `jobAuth` arms and the new `heartbeats` field), `lib/outbox.test.ts` 13 → 14 (the retry route's `delivery` verdict), and two files whose *assertions* moved without adding a test — `lib/phase8.test.ts` (24, both stale static pins repaired: the seven-verb `apiRoute` destructure and the `failing` extraction) and `lib/suppression.test.ts` (15, header-capturing `fetch` stubs so the `Idempotency-Key` is asserted rather than assumed).

**One defect was found by the tests and fixed here rather than logged.** `jobLimit`'s query-string read was `Number(stated)` for any non-null value, so `?limit=` — the shape a hand-edited `vercel.json` or a dashboard cron field produces when someone clears the number — became `0`, clamped up to `1`, and a scheduler asking for the work would have drained exactly one row per day. Empty and whitespace-only now mean *absent* and fall through to the verb default (`lib/jobBudget.ts:66-71`), and the case is pinned (`lib/jobsAndCron.test.ts:116-117`).

**R13-1 — the reporting half was `10`'s; the surface half is this pass's.** `git log -S assertDelivered --oneline` names exactly one commit, `6dcd955` — doc `10`'s fix pack — so the criterion's first half (*a send that returns `"error"` leaves the row retryable*) was already closed: `assertDelivered` throws on `"error"` (`lib/outbox.ts:147-153`), the row keeps its lease and its backoff, and `config`'s `mail` block is where a terminal failure becomes readable. What was left is the criterion's second half — *distinguishable in the retry route's response* — because both histories the route refuses answer the identical `409 ALREADY_DONE`: a `sent` row and a `logged` row are both completed with zero attempts. The refusal now carries `delivery`, the newest `EmailLog` row for the key ordered `createdAt desc, id desc` (the `id` breaks same-millisecond ties so the verdict cannot depend on row order), reported verbatim as `sent`, `logged`, `suppressed:<reason>` or `none` when there is no log row at all (`app/api/admin/outbox/retry/route.ts:72-84`). It uses `apiJson` rather than `apiError` because the shared error envelope is exactly `{error, code}` (`lib/route.ts:46`) and this payload is deliberately not that shape. **No new refusal arm was added**: the two histories are the same row shape, and inventing a revival for `logged` would have been a guess about the register rather than a read of it — so a reheard rehearsal row is now *legible* (the operator sees `delivery: "logged"` and knows why there is nothing to retry) rather than silently re-sendable.

**R13-2 — the exemption moved from the framework's environment string to the database's host.** `isLocalDatabase()` (`lib/env.ts:60-73`) parses `DATABASE_URL` and accepts only `localhost`, `127.0.0.1`, `[::1]`, `::1`; unset or unparsable counts as *remote*. `jobAuth` now refuses — `401`, the same body as the production arm — when `isProduction() || !isLocalDatabase()` (`lib/jobs.ts:55-57`), so all three shapes §5.2 measured as open fail closed: a preview deployment, a laptop running `next start` against the production `.env`, and `next dev` pointed at any remote database. A host test rather than a DNS lookup, deliberately: no network call on the auth path, no cache to stale, and the loopback containers `08`–`12` used (`:55433`, `:55440`) are inside the accepted set, so the suite still runs without a secret. Two tests pin the two branches (`lib/ops.test.ts`), including the negative control this doc could not make: a *dev* environment whose `DATABASE_URL` is remote answers 401.

**R13-3 — the app now records its own liveness, and the bound is derived from §5.6 rather than chosen.** `JobHeartbeat` (`prisma/schema.prisma:474-480`, migration `0010_job_heartbeats`) is one row per route keyed by the route path, with `lastRunAt`, a monotonic `runs` counter and `lastError` (`VarChar(280)`, so no stack trace can make the bookkeeping itself fail). `stampHeartbeat()` is best-effort by design — it catches, logs `job heartbeat not recorded for <key>` and returns (`lib/jobHeartbeat.ts:65-80`) — because a job that did its work must not report failure because the *record* of it could not be written. All five routes stamp on the way out, including the two this doc's §5.13 counted as unobservable. `config` reads `heartbeatReport()` **before** stamping itself (`app/api/jobs/config/route.ts:109-118`) — its own age is the age of the pinger, so a report that says "config last ran three days ago" is the report telling you nobody has been reading reports — and returns both halves: one `operator` finding per route that has never reported or has passed its bound, and a `heartbeats` block carrying `boundMs / ageMs / runs / lastRunAt / lastError` for all five, findings or not. The bounds are the measurement, not a round number: `TICK_WORST_OBSERVED_MS = 6 h 40 m`, so a tick-only route is allowed **twice** the worst observed gap (13.3 h) and the two routes that also own a daily Vercel cron are allowed that backstop plus two hours (26 h, `lib/jobHeartbeat.ts:42-53`); the test asserts the derivation (`bound ≥ 2 × TICK_WORST_OBSERVED_MS`) rather than the numbers, so the bounds follow if the measurement is ever re-taken. The alternative §7's *Proposed fix* (a) offered — `config` going **503** on a stale heartbeat — was rejected: `configFindingsOk` still fails only on `required` (`lib/env.ts:174-176`), because `ok` has meant one question since R07 (*would `requireProdEnv()` refuse to serve?*) and a starved CI scheduler is not an answer to it. The residual that leaves is stated rather than papered over: the finding rides a **200** body, and the reader it needs is a caller that still arrives.

**R13-4 — the arithmetic is now an identity with the platform's ceiling, and a test is what keeps it so.** `lib/jobBudget.ts` states the three numbers (`PLATFORM_CEILING_MS 30_000`, `RESPONSE_SLACK_MS 6_000`, `ROW_CEILING_MS 10_000`), derives the work budget (`JOB_WORK_BUDGET_MS = 30_000 − 6_000 = 24_000`) and answers `canStartRow(deadline, now)` with "a whole row ceiling still fits" — `deadline − now >= 10_000` (`:33-37`) — not "the reference instant is inside the deadline", which is what §5.10 measured. Both workers therefore stop claiming at 24 s *and* stop starting rows earlier still, so the worst case is 24 s of work + ≤10 s of row + the claim and response round-trips inside the remaining 6 s; the measured shape was 20 s + 10 s + **0** s. The doc's other option — shortening the loop to 15 s — was rejected as the weaker of the two: it leaves the in-flight row uncounted and it is a number a later edit can drift away from silently. Instead two statements are pinned in `lib/jobsAndCron.test.ts`: the identity (`24 s budget + 6 s slack = the 30 s the workers declare`) and the **coupling** — the routes' own `export const maxDuration` is read out of the source and compared to `PLATFORM_CEILING_MS / 1000`, so a route that raises its own limit fails a test instead of a production invocation.

**R13-5 — the backlog drains in bounded time, and the response says how much is left.** `drainInBatches()` (`lib/outbox.ts:349-399`) loops: claim `limit` rows, start each only while a row ceiling fits, stop on a short batch (nothing else was claimable) or a spent budget; a row claimed but not started keeps the claim's lease and is re-claimed when it expires — slower than starting it, never delivered twice, which is the rule the single-batch worker always used. Three fields make the loop decidable rather than a guess: `remaining` is measured **after** the loop by `dueOutboxCount()` (`:401-410`), a `count(*)` over the same predicate the claim uses (so it is the queue's own answer, not an estimate), `batches` says how many claims it took, and `deferred` names rows this call paid for and could not start. `vercel.json` now states each cron's batch in the path (`?limit=25`, `?limit=10`), so the bound is readable by anyone who reads the schedule instead of living in a route default; and the tick re-loops up to four calls per step, breaking as soon as `remaining` is 0 (`.github/workflows/outbox-tick.yml:62-94`), which is up to 100 outbox rows per tick and ~600 an hour against the 25-per-tick the review measured. Four is the cap because the step's own `timeout-minutes` is 5 against a 24 s budget per call: a deeper queue still drains, just over more ticks.

**R13-6 — a swallowed failure is now a count and a status.** The claim moved *inside* the drain's `try`, so a claim that throws outright is `errors: 1` instead of being indistinguishable from an empty queue, and the workers answer **500 with the same counts** on that path (`app/api/jobs/outbox/route.ts:60-72`) — which is what makes the tick's `curl -fsS` fail the step rather than print a green zero. `drainDue`/`drainDueWithin` grew the same `errors` field for the inline drains (settlement, report, waitlist) without changing their deadline semantics, and `timedOut` and `errors` stay separate on purpose: "the drain is still running" and "the batch never started" are different answers and only one of them is a failure.

**R13-7 — the preview worker claims only what it can act on.** `drainInBatches({ limit, types: ["PREVIEW_GENERATE"], budgetMs })` (`app/api/jobs/screenshot/route.ts:79-83`) — the claim predicate always accepted a type filter and the inline drains already used it, so this is the argument the untyped call was not passing — and `checked` is now `out.claimed`, the count of rows the job could act on. The row §5.8 watched (`STAKE_ANALYTICS`, claimed, re-read, skipped, *and still counted* while holding a 299 s lease) cannot be claimed here at all: it stays due for the outbox drain, which is the worker that can process it.

**R13-8 — the send carries the key our own register already keys it by.** `mailIdempotencyKey()` (`lib/email.ts:490-494`) is `pt_mail_<dedupeKey>`, replaced by `pt_mail_sha256_<hex>` only when the prefixed key would exceed Resend's 256-character ceiling — hashed rather than truncated, because two long keys sharing a 256-char prefix would collide into one no-op; and the header is sent only when a `dedupeKey` exists (`:526-528`), so an unkeyed send is not silently handed a shared key. `deliver()` receives the key as an argument rather than reading it off the row, so the inline drains and the retry path cannot disagree about which message they are re-sending. The limit is the provider's and is stated as such: Resend honours the key for 24 h, which bounds a duplicate inside that window and not beyond it.

**R13-9 — an increase is visible without opening the log.** The tick compares `unverified.count` with `RECONCILE_UNVERIFIED_BASELINE` — a job env var, `"0"` recorded from the 2026-09-16 reading of run `35065018318` (`paidTotal: 3`, `divergent: 0`, `unapplied: 0`) — and emits `::warning::` with the operator's instructions when it grows, keeping the design's "never page on it" and the status code's meaning intact (`.github/workflows/outbox-tick.yml:145-151`). Below the baseline it prints the count and the baseline, so the reading is in the log either way. Raising the baseline is a deliberate act: the note that accounts for the new rows and the new number are one commit, which is written into the workflow's own comment rather than left to the operator's memory.

**The tick's wiring was verified by running it, not by reading it.** All seven `run:` blocks pass `bash -n`; the YAML parses to seven steps in the order §5.6 records (guard, sweep, reconcile, config); and the three re-looped or annotated blocks were exercised against a stub `curl` that scripts the route's answers — **10 of 10 cases as designed**: the outbox step makes 3 calls on `remaining: 3, 1, 0`, 1 call when the body has no `remaining`, 1 when it is `null`, 1 when the body is junk (the `case` guard), and exits 1 when the call itself fails; the screenshot step makes 3 calls on `2, 1, 0`; the reconcile step prints no annotation at 0-vs-0, warns and stays **rc 0** at 5-vs-0, and warns at 5-vs-2. The risk that measurement was for is the one an annotation invites: a loop that never terminates, or a warning arm that turns an advisory into a red run.

**Two things the pass records without changing.** (a) *The `abandoned-checkouts` page is a candidate page.* `sweepAbandonedCheckouts` passes `take: limit` to the **candidate** query and only then filters with `isAbandonable`, so a page of ineligible candidates can leave eligible rows unvisited for that call — the per-row `updateMany` re-checks `PENDING` as the race guard and cannot recover a row it never reached. Its only caller states `{"limit": 50}` (`ABANDON_MAX_BATCH`), so the production shape is unaffected, and unlike the two workers this route has no 10 s per-row network ceiling, so its 30 s `maxDuration` has room a page of errors could not exhaust. Recorded rather than changed: making the candidate query filter on the same predicate is a change to a money-adjacent query for a case no caller produces, and R13-5's ask (a backlog bound and a legible response) is met without it. (b) *A test-hygiene defect that hides a real one.* `lib/ops.test.ts` is DB-less by design, but `config`'s handler imports `lib/jobHeartbeat`, which imports `lib/prisma` and constructs the client from the auto-loaded `.env` — the **production** URL — so the file was logging a production `P2021` (`The table public.JobHeartbeat does not exist`) while passing. The file now pins `process.env.DATABASE_URL` to a local URL before that import, so the DB-less run is DB-less on purpose.

**Every line number and body in §5.1–§5.14 is the at-authoring one.** `outbox` and `screenshot` gained `maxDuration` and moved their constants into `lib/jobBudget.ts`, so the `route.ts:6,25-26` citations are historical; their bodies gained `errors / skipped / deferred / batches / remaining` and `config`'s gained `heartbeats`, so the sampled bodies in §5.8 and §5.13 are the shape *before* the pass; `lib/jobs.ts:19-31` is now `:40-57`; and the inventory listed five rows for a tree that has six — the sixth was added by this pass. The cadence measurement itself — §5.6's 34 runs, 5.1 %, median 3 h 12 m, worst 6 h 40 m, 26 consecutive green since 2026-09-11T13:48:12Z — is unchanged, and is now the *input* to the stale bounds rather than only a finding.

## 6. Failure and edge matrix

| Trigger | Current behaviour | Who finds out | Acceptable? |
| --- | --- | --- | --- |
| Resend answers 500 while draining a receipt | `deliver()` → `"error"`; the handler returns; row **completed**; no further attempt | Nobody. `EmailLog.status` records `error` and nothing reads it | **No.** R13-1 |
| Resend unreachable, request times out at 10 s | Same as above — completed, not retried | Nobody | **No.** R13-1, and the abort is what makes it look "done" |
| `RESEND_API_KEY` missing | Sends nothing, writes `EmailLog.status='logged'`, row completed | The `config` tick goes red (`RESEND_API_KEY` is a required var, `lib/env.ts:47`) — the queue stays green | Yes for dev, **no** for production: the queue reports success while sending nothing (§5.7b) |
| `CRON_SECRET` missing in production | Every job route 401s (`lib/jobs.ts:24-26`) | The tick's own step fails; `outbox-tick.yml:31-37` also fails loudly when the repository secret is absent | Yes |
| `CRON_SECRET` missing off production | `jobAuth` returns `null` — **all four routes are open** | The `config` advisory does not cover it; nothing fails | **No.** R13-2 |
| A 30 s `maxDuration` kill mid-run | Invocation dies holding the lease; the caller sees a timeout, not the route's JSON; the row is re-claimable after 5 minutes | Vercel's function error log only; the tick sees a failed curl | Partly — self-healing, but the operator cannot tell a kill from a queue that is simply slow. R13-4 |
| `reconcile` finds a divergence | 503 + `::error::` annotation with samples in the body | GitHub step red; the run's log holds the body | Yes — and it is the *only* money-contradiction channel |
| `reconcile` finds money accepted with no provider figure | `unverified` block, **200** | Nobody unless the log is opened | Yes by design (`route.ts:37-43` reasons it out), with a residual: the count is only visible in a log. R13-9 |
| `config` finds a required var missing | 503 with `findings` | GitHub step red | Yes |
| `config` finds only advisories (Upstash pair, `ADMIN_TOKEN`) | 200 with `findings` | Nobody | Yes — but see `14` for what fail-open rate limiting costs |
| GitHub tick starved | Median gap 3 h 12 m, worst 6 h 40 m; the daily Vercel pair is the floor | Nobody, until a tick goes red | Acceptable for retry latency; the *detection* half is not (§5.6). R13-3 |
| GitHub disables the workflow (60 days of repository inactivity) or Actions are off for the repo | No ticks at all; mail retries fall to the daily backstop, `reconcile`/`config` go dark | Nobody — the app has no way to notice a tick that never arrives | **No.** R13-3 |
| A row reaches 5 attempts | Terminal (`"skipped"`); stays in the table at `attempts = 5` | Nobody; only a manual `SELECT` finds it | **No.** R13-3 |
| Two ticks overlap | Disjoint claims (single `UPDATE … SKIP LOCKED`); GitHub also serialises its own | — | Yes (§5.5) |
| A `STAKE_ANALYTICS` row is due when the screenshot job runs | Claimed, skipped, parked for ≤5 min; reported as `checked` | Nobody — the response has no field for it | Yes in effect, no in legibility. R13-7 |
| A preview row is due when the outbox job runs | Claimed by the untyped claim too; skipped there, parked for ≤5 min | Nobody | Yes in effect — the cost is a delay, and `backfill` re-arms preview rows by `dedupeKey` (`screenshot/route.ts:49-51`) so it cannot resurrect a *mail* row |

**After the fix pass** (§5.15), the rows whose behaviour changed — every other row above is as measured on 2026-09-15 and stands:

| Trigger | Before the pass | After it |
| --- | --- | --- |
| Resend answers 500, or the request times out at 10 s, while draining a receipt | `"error"` scored as delivery; row **completed**; no further attempt; the row is not re-claimable by construction | `assertDelivered` throws on `"error"` (`10`'s pack, `6dcd955`), so the existing backoff and the five-attempt limit apply; the retry surface now names the register's verdict (`delivery`) so a `logged` row can be told from a `sent` one before re-arming |
| `CRON_SECRET` missing off production | `jobAuth` returned `null` — all four routes open to anyone who could reach them | 401 whenever `DATABASE_URL` is not loopback-local, in **every** environment (`lib/jobs.ts:55-57`); a loopback database still rehearses without a secret |
| A 30 s `maxDuration` kill mid-run | Worst case `20 s + 10 s = maxDuration` exactly, with nothing left for the claim's own round-trips | 24 s work budget + 6 s slack, and a row only starts if a 10 s ceiling still fits — asserted against the routes' own `maxDuration` |
| GitHub tick starved, disabled, or the repository's Actions off | Invisible to the application: no heartbeat, no `lastRunAt`, the trace only in GitHub's history | `JobHeartbeat` per route, ages returned by `config` as `operator` findings; `runs` also gives the cadence an in-app source. A scheduler that is dark *and* is the only thing that reads `config` still has no channel — that residue is U13-4 |
| A row reaches 5 attempts | Nobody finds out; only a manual `SELECT` finds it | Still nobody is *notified*, but it can no longer hide behind a green body: `errors` is a field, `dueOutboxCount()` reports the due backlog, and `lastError` is stamped per route |
| A backlog exceeds one run's bound | Drained 25 rows (10 for previews) per opportunity, at the tick cadence — median 3 h 12 m | The route loops inside its 24 s budget, reports `remaining`, and the tick re-loops up to four calls per step; the daily crons state their batch in the path (`?limit=25` / `?limit=10`) |
| A `STAKE_ANALYTICS` row is due when `screenshot` runs | Claimed by the untyped claim, skipped, parked for ≤5 min, and **counted** as `checked` | Not claimed at all (`types: ["PREVIEW_GENERATE"]`), so it stays due for the outbox drain, and `checked` counts only rows the job can act on |
| A hard drain failure | `{"ok":true,"claimed":n,"completed":0,"failed":0}` — identical to an idle queue | `errors` field plus **500 with the same counts**; the tick's `curl -fsS` fails the step |
| `reconcile`'s `unverified` grows | Only visible to someone who opened the run's log | `::warning::` with instructions, against a recorded baseline that is raised deliberately and in the same commit as the note that accounts for the new rows — the status code is untouched |

## 7. Findings

### R13-1 — A mail send that failed is marked complete, and a completed row cannot be retried

- **Severity.** P1
- **Category.** correctness · operational blind spot · customer-visible
- **Evidence.** `lib/email.ts:66,68` return `"error"` (no throw) for a non-2xx or a thrown request; `lib/outbox.ts:126-134` therefore takes the success branch and sets `completedAt`; `lib/outbox.ts:128` skips completed rows on every later run; `app/api/admin/outbox/retry/route.ts:25-26` answers `409 ALREADY_DONE` for the same row. Witness §5.7: 115 rows all complete, zero retried, 32 `EmailLog` rows all `logged`.
- **Reproduction.** With `RESEND_API_KEY` absent (so `deliver()` returns `"logged"`, `lib/email.ts:41`) enqueue a `RECEIPT_EMAIL` row and drain it; then read `EmailLog.status` — the row is complete and no mail exists. For the error branch, point `lib/email.ts:46` at a 500 and repeat; the same completion happens with `lastError` unset.
- **Proposed fix.** In `handleOne`'s email cases, throw when `deliver()` returns `"error"` so the existing backoff and attempt limit apply; treat `"logged"` as non-terminal in production only (or surface `EmailLog.status` in the retry route's response so the operator can see it before re-arming).
- **Fix.** Split by owner, as the Status line said. The reporting half needed no new code here: `assertDelivered()` throws on `"error"` (`lib/outbox.ts:147-153`), which landed in `10`'s pack (`6dcd955` — `git log -S assertDelivered --oneline` names exactly that commit), so the row keeps its lease and its backoff instead of completing, and the register's verdict is readable in `EmailLog` and in `config`'s `mail` block. The surface half is this pass's: both refusals for a completed row now carry `delivery` — the newest `EmailLog.status` for the key, ordered `createdAt desc, id desc` so the verdict cannot depend on row order, or `"none"` when no log row exists — sent as `apiJson({…}, {status: 409})` because the shared `apiError` envelope is exactly `{error, code}` (`lib/route.ts:46`) and this payload is not that shape (`app/api/admin/outbox/retry/route.ts:60-84`). A **new refusal arm** for the rehearsed case was considered and rejected: `logged` and `sent` produce the same row (completed, zero attempts), so reviving one would be a guess about the register rather than a read of it; disclosing its verdict is what makes the operator's next action unambiguous. Pinned by `lib/outbox.test.ts` — "names the log's verdict when it refuses a completed row (R13-1)" — and by the tightened `delivery: "sent"` assertion on the pre-existing case.
- **Status.** fixed — the queue-side half by `10` (`6dcd955`), the retry surface by this pass (§5.15). What a `logged` row *means* for delivery stays `10`'s, and `10` §7 R10-1 remains the register of the contract side.

### R13-2 — Job authentication is fail-open outside production

- **Severity.** P2 (P1 if a preview deployment shares the production `DATABASE_URL`)
- **Category.** security · operational
- **Evidence.** `lib/jobs.ts:25-28` returns `null` — i.e. *allow* — when the environment is not production. Measured on `:3215` (and re-confirmed by every §5.8 call, which carries no credential): unauthenticated `GET /api/jobs/outbox`, `/api/jobs/reconcile`, `/api/jobs/screenshot` all answer **200**; only `config` answers 503, and that is its findings, not its auth (§5.2). The same matrix on the production-mode build answers 401 with a 24-byte body for every one of them.
- **Reproduction.** `npx next dev` with `DATABASE_URL` pointing at any database, then `curl -s "http://localhost:PORT/api/jobs/outbox?limit=25"` with no credentials — the drain runs.
- **Proposed fix.** Treat `VERCEL_ENV`/`NODE_ENV` *not equal to* `production` as "require the secret if it is configured", and require it outright whenever `DATABASE_URL` points at a non-local host; or make the dev exemption depend on a loopback database.
- **Fix.** The second option, in the form the review preferred. `isLocalDatabase(url = process.env.DATABASE_URL)` (`lib/env.ts:60-73`) accepts only `localhost`, `127.0.0.1`, `::1` and `[::1]`, and treats unset or unparsable as **remote**; `jobAuth` now returns the same 401 as the production arm when `isProduction() || !isLocalDatabase()` (`lib/jobs.ts:55-57`), so all three postures §5.2 measured as open fail closed — a preview deployment, `next start` on a laptop with the production `.env`, and `next dev` against any remote database. A host test rather than the doc's other option ("require the secret whenever one is configured") because a *configured* secret is exactly what a preview deployment borrows from production, and rather than a DNS resolution because the auth path should not do I/O. The loopback containers `08`–`12` used (`:55433`, `:55440`) stay inside the accepted set, so the DB suites still run without a secret. Two arms pinned in `lib/ops.test.ts`, including the control this review could not make: dev environment, remote `DATABASE_URL` → **401**.
- **Status.** fixed (§5.15). The reachability chain through a preview deployment stays `14`'s (`14` R14-1); the queue-draining half is closed here, `10` §7 R10-10 keeps the mail-queue half.

### R13-3 — The maintenance channel runs at 5 % of its nominal cadence, alerts one human, and cannot notice its own death; inside the queue, no failure notifies anyone

- **Severity.** P2
- **Category.** operability · money detection latency
- **Evidence.** §5.6: 34 scheduled runs in 110.12 h against 661 nominal ticks (**5.1 %**), gap min/median/max **1 h 44 m / 3 h 12 m / 6 h 40 m**, 32 green and 2 red, last red 2026-09-11T13:48:12Z, 26 consecutive green since. `outbox-tick.yml:5-6` expects those ticks to be "a few minutes late". The same effect is already recorded in `doc/PROD-READINESS-CHECKLIST.md` §4b (~7 % on 2026-09-11) and accepted in `HANDOFF.md:807-821`. `reconcile` and `config` are called by this tick and nothing else (§5.13).
- **Nobody is told.** Per job, the failure surfaces are empty: a mail row that exhausts its five attempts (`lib/outbox.ts:15,128`) sets no flag, increments no counter anyone reads, and appears in no response field and no admin view (§5.11) — the only reader is a human with a `psql` session; an `EmailLog` row with `status='error'` (`lib/email.ts:66`) is written once and never read by any code in the repo; an invocation killed at `maxDuration` appears only in Vercel's function error log (§5.10, R13-4); and a tick that never arrives is invisible to the application, because the application never records one arriving (no heartbeat table, no `lastRunAt` column — the tick's only trace is in GitHub's Actions history, §5.6).
- **Reproduction.** `gh run list --workflow=outbox-tick.yml --limit 200 --json event,startedAt,conclusion` and compare the scheduled count with elapsed time / 10 minutes.
- **Fix.** (a) taken, in a modified form: `JobHeartbeat` (`prisma/schema.prisma:474-480`, migration `0010_job_heartbeats`) records `lastRunAt` / `runs` / `lastError` per route, all five job routes stamp it best-effort (`lib/jobHeartbeat.ts:65-80`), and `config` reads `heartbeatReport()` **before** stamping itself, so a never-reported or past-bound route becomes an `operator` finding and a `heartbeats` block in the 200 body (`app/api/jobs/config/route.ts:109-118`). The 503 in the doc's own wording was **rejected** deliberately: `configFindingsOk` still fails only on `required` (`lib/env.ts:174-176`), because `ok` has meant "would `requireProdEnv()` refuse to serve?" since R07 and a starved CI scheduler is not an answer to that question — the price is that the finding must be *read* rather than *noticed*, which is recorded in §5.15 rather than hidden. The bounds are §5.6's measurement and not a round hour: twice the worst observed gap (13.3 h) for the three tick-only routes, and the daily Vercel backstop plus two hours (26 h) for `outbox`/`screenshot` (`lib/jobHeartbeat.ts:42-53`), with the *derivation* asserted in tests rather than the numbers, so re-taking the measurement moves the bounds. (b) **not taken**: moving `reconcile` onto the daily Vercel pair is `08` R08-3's decision, Hobby allows two cron entries and both are spent, and this pass's answer was to make starvation survivable and visible instead. The heartbeat **notification** is not implemented either — it needs a channel outside the repository, which is what U13-4's pinger is.
- **Status.** fixed in part (§5.15) — the app now records every arrival, reports each route's age against a measurement-derived bound, and stamps `lastError`; what is missing is any **push**: nobody is alerted, and a scheduler that is dark *and* is the only caller of `config` still has no reader. Acceptance box 1 stays open for that reason. That `reconcile` is absent from `vercel.json` and that a terminal rejection alerts nobody remain `08` §7 R08-3's.

### R13-4 — Both workers' worst-case work equals their `maxDuration` exactly

- **Severity.** P2
- **Category.** resilience · operability
- **Evidence.** §5.10: `jobs/outbox/route.ts:6,25,31` and `jobs/screenshot/route.ts:7,56,62` check a 20 s deadline *between* rows, while the in-flight row may run to its own 10 s ceiling (`lib/email.ts:64`, `lib/screenshots.ts:63`) — 20 s + 10 s = 30 s = `maxDuration`, with no allowance for the claim's own database round-trips or Prisma connection acquisition.
- **Reproduction.** Enqueue 25 rows whose handler sleeps 10 s (a stub is enough) and call the route in production mode; the invocation can exceed the platform limit instead of returning the route's JSON.
- **Fix.** The first option, generalised into a module the routes share. `lib/jobBudget.ts` declares `PLATFORM_CEILING_MS 30_000`, `RESPONSE_SLACK_MS 6_000` and `ROW_CEILING_MS 10_000`, derives `JOB_WORK_BUDGET_MS = 24_000`, and answers `canStartRow(deadline, now)` with `deadline − now >= ROW_CEILING_MS` (`:33-37`) — "a whole row still fits", not "the reference instant is inside the deadline", which is what §5.10 measured. Both workers claim against the 24 s budget and check `canStartRow` before every row (`lib/outbox.ts:377,388`), so the worst case is 24 s of work + ≤10 s of row + the claim and response round-trips inside the remaining 6 s, against the measured 20 s + 10 s + 0 s. The doc's other option — shorten the loop to 15 s — was rejected as the weaker of the two: it leaves the in-flight row uncounted and is a number a later edit can drift away from silently. `lib/jobsAndCron.test.ts` pins the identity (24 s + 6 s = the 30 s the workers declare) and the **coupling**: the routes' `export const maxDuration` is read out of the source and compared with `PLATFORM_CEILING_MS / 1000`, so a route that raises its own limit fails a test rather than a production invocation.
- **Status.** fixed (§5.15) — the ceiling is now an identity with the platform's limit and the per-row ceiling, and both halves are asserted against the routes rather than restated in prose.

### R13-5 — The queue's retry cadence is the tick, and a backlog drains at the cadence rather than catching up

- **Severity.** P2
- **Category.** operability · customer-visible latency
- **Evidence.** `lib/outbox.ts:154-168` bounds a claim at 25 rows per run for the outbox path and 10 for the screenshot path (`jobs/outbox/route.ts:26`, `jobs/screenshot/route.ts:57`); the next opportunity is the next tick (median 3 h 12 m, §5.6) or the daily Vercel pair (`vercel.json:3-5`). The inline drains cover the common case only in bulk-up to 10 rows and 15 s in settlement (`lib/settle.ts:282`, budget `lib/settle.ts:76`) and 5 rows / 3 s for report and waitlist (`app/api/report/route.ts:74`, `app/api/waitlist/route.ts:63`).
- **Reproduction.** Enqueue 30 `RECEIPT_EMAIL` rows with delivery failing and watch how many attempts accumulate per hour: at most 25 rows are touched per tick, and the backoff floor of 30 s per attempt means attempt 5 is an hour out (`lib/outbox.ts:73-74`).
- **Fix.** `drainInBatches({ limit, types, budgetMs })` (`lib/outbox.ts:349-399`) loops claims inside one invocation — stopping on a short batch (nothing else was claimable), a spent budget, or a row that cannot fit a full 10 s ceiling — and reports `remaining`, `batches` and `deferred` alongside the old counts. `remaining` is a `count(*)` over the claim's **own** predicate (`dueOutboxCount()`, `:401-410`), so the caller loops on the queue's answer rather than on an estimate; the tick re-loops up to four calls per step and breaks as soon as `remaining` is 0 (`.github/workflows/outbox-tick.yml:62-94`), which is up to 100 outbox rows and 40 previews per tick against the 25 the review measured. The daily backstop's bound is now stated where the schedule is — `vercel.json` names it in the path (`?limit=25`, `?limit=10`) — and it stays 25 because it is the **loop**, not a bigger batch, that makes a backlog drain: a bigger `limit` only lengthens a single invocation toward its ceiling. `jobLimit()` reads body > query string > verb default and clamps to `[1, max]` (`lib/jobBudget.ts:60-71`); its first draft turned an empty `?limit=` into a clamped `1` — one row per day from a scheduler asking for work — which the new tests caught before commit (§5.15).
- **Status.** fixed (§5.15) — the report/waitlist chain's own 3 s/5-row drain and 04:00 retry stay `05` §7 R05-7's, cited rather than re-reported.

### R13-6 — A hard drain failure is reported as an empty queue

- **Severity.** P3
- **Category.** correctness · legibility
- **Evidence.** `lib/outbox.ts:177-191`: the claim is awaited outside the `try`, the processing loop is inside it, and a throw is swallowed into `console.error("outbox drain failed (non-blocking):", e)` at `:188`. `drainDueWithin` (`:203-220`) then resolves with `{completed: 0, failed: 0, timedOut: false}` — indistinguishable from an idle queue in the response body the tick prints.
- **Reproduction.** Make the handler throw for every row (or drop the database connection between claim and process) and call `/api/jobs/outbox`: the response is `{"ok":true,"claimed":n,"completed":0,"failed":0}`.
- **Fix.** Both halves of the doc's second option, plus the claim itself. The claim moved *inside* the drain's `try`, so a claim that throws is `errors: 1` instead of an empty queue; `drainInBatches` catches per iteration and counts, logging once per batch (`lib/outbox.ts:349-399`); `drainDue` and `drainDueWithin` carry the same `errors` field with their deadline semantics untouched (`:423`, `:459`). The two job routes answer **500 with the counts still in the body** on that path (`app/api/jobs/outbox/route.ts:60-72`, `app/api/jobs/screenshot/route.ts:99-115`), so the tick's `curl -fsS` fails the step instead of printing a green zero — and the counts travel with the failure because they are the diagnosis. `timedOut` and `errors` are kept separate on purpose: "still draining" and "never started" are different answers and only one of them is a failure.
- **Status.** fixed (§5.15) — the response is now honest in both directions: a failed drain fails the step, and it says how many rows it did and did not touch while doing so.

### R13-7 — The screenshot worker claims rows it cannot process, and reports them as `checked`

- **Severity.** P3
- **Category.** correctness · legibility
- **Evidence.** §5.8: `jobs/screenshot/route.ts:58` claims with no type filter, `:65` continues past every non-`PREVIEW_GENERATE` row, `:70` reports `checked: claimed.length`. Measured on `:3215`: `{"ok":true,"checked":1,"updated":0,"failed":0}` while a `STAKE_ANALYTICS` row gained a 299 s lease (`attempts` unchanged at `0`, `completedAt` still null) and the outbox drain that could have processed it answered `{"ok":true,"claimed":0,…}`; after the lease expired the same drain answered `{"ok":true,"claimed":1,"completed":1,…}` and the row was complete.
- **Reproduction.** Make a single non-preview row the only due row and call the route with `limit=1`; compare `checked` with what the job can act on.
- **Fix.** Both, as proposed: `drainInBatches({ limit, types: ["PREVIEW_GENERATE"], budgetMs })` (`app/api/jobs/screenshot/route.ts:79-83`) and `checked: out.claimed` (`:90`). The claim predicate always took a type filter and the inline drains already used it — the screenshot worker was the one caller that asked for everything due. The `STAKE_ANALYTICS` row §5.8 watched cannot be claimed here at all now, so it stays due for the drain that can actually process it instead of collecting a five-minute lease and a false count. The `backfill` mode still re-arms only `preview-<id>` rows, so no path in this route touches a mail row.
- **Status.** fixed (§5.15) — `checked` now means what the review read it as: rows this job acted on.

### R13-8 — The mail send carries no provider idempotency key

- **Severity.** P3
- **Category.** correctness
- **Evidence.** §5.12: `git grep -n 'Idempotency-Key'` matches exactly once, `lib/stripe.ts:122` (`pt_checkout_${paymentId}`); the Resend call (`lib/email.ts:46-64`) sets none, and its 10 s abort (`:64`) is what converts an unanswered-but-delivered send into an `"error"` (which §5.7 then marks complete).
- **Reproduction.** Point `lib/email.ts:46` at a server that accepts the payload and never responds; the row completes as `"error"`, and `POST /api/admin/outbox/retry` with the same `dedupeKey` sends it a second time.
- **Fix.** `mailIdempotencyKey(dedupeKey)` (`lib/email.ts:490-494`) is `pt_mail_<dedupeKey>`, replaced by `pt_mail_sha256_<hex>` only when the prefixed key would pass the provider's 256-character cap — **hashed, not truncated**, because two long keys sharing a 256-character prefix would otherwise collide into one no-op retry. `deliver()` sets the header only when a `dedupeKey` exists (`:526-528`) and takes that key as an argument rather than reading the row, so the inline drains and the operator retry cannot disagree about which message they are resending. Asserted through header-capturing `fetch` stubs: the key equals `mailIdempotencyKey(dedupeKey)`, a long key is hashed, and an unkeyed send carries no header at all.
- **Status.** fixed (§5.15), bounded by the provider's window — Resend honours the key for 24 h, so a retry inside a day is a no-op and one beyond it is not. What a duplicate receipt costs the customer relationship stays `10`'s.

### R13-9 — Money accepted without a provider cross-check is only visible in a CI log

- **Severity.** P3
- **Category.** operability · residual risk
- **Evidence.** `app/api/jobs/reconcile/route.ts:64-80` counts `unverified` rows and groups them by provider; `:90` answers **200** for them by design, and the docstring at `:37-43` reasons that a report paging on it "would be muted before the divergent case ever fired". The only caller prints the body into the Actions log and fails the step on a non-200 (`outbox-tick.yml:89-98`), so the count reaches a reader only when someone opens the run.
- **Reproduction.** `GET /api/jobs/reconcile` with credentials on a database holding a `PAID` payment with `providerAmount = null`: `ok: true` (200) with `unverified.count ≥ 1`.
- **Fix.** Exactly the proposed shape, with the baseline **recorded** rather than assumed: `RECONCILE_UNVERIFIED_BASELINE: "0"` in the tick's job env (`.github/workflows/outbox-tick.yml:31-40`) and a comparison against `unverified.count` that emits `::warning::` when the count grows, with the instruction to cross-check the samples by hand and raise the baseline in the same commit as the note that accounts for the new rows (`:145-151`). At or below the baseline it prints the count *and* the baseline, so the reading is in the log either way. The step's exit code and the route's 200 are untouched — that is the point of taking the documentation arm of a design decision rather than overruling it. The baseline's provenance is recorded next to it: run `35065018318` on 2026-09-16 read `paidTotal: 3`, `divergent: 0`, `unapplied: 0`, which is what makes "0" a fact rather than a hope.
- **Status.** fixed (§5.15) — this was a residual on a deliberate decision and it **stays** deliberate: nothing about the status code changed, only the count's visibility. `::warning::` never fails a run.

## 8. Acceptance criteria

- [x] A mail send that returns `"error"` leaves the row retryable, and a row completed while `deliver()` returned `"logged"` is distinguishable in the retry route's response. (R13-1, §5.15, §7)
- [x] `jobAuth` fails closed whenever the database is not local, whatever the framework's environment string says. (R13-2, §5.15, §7) — proven by the arm this review could not make: dev environment, remote `DATABASE_URL` → 401.
- [x] The worst case of one invocation — deadline plus the in-flight per-row ceiling plus claim round-trips — is provably inside `maxDuration`. (R13-4, §5.15) — and provably *coupled* to it: the test reads `maxDuration` out of the route sources.
- [x] A backlog larger than one run's bound drains in a bounded time rather than at the tick cadence, and the bound is stated in the job's response. (R13-5, §5.15) — the bound is the budget + per-row ceiling; the response carries `remaining` so the caller loops on the queue's own count.
- [x] `claimed > 0, completed = 0` cannot be produced by a swallowed exception. (R13-6, §5.15) — and the failing arm answers 500 with the counts rather than 200.
- [x] `screenshot` claims only `PREVIEW_GENERATE` and its `checked` counts only rows it can act on. (R13-7, §5.15)
- [x] A retry that follows an aborted-but-delivered send does not send a second time. (R13-8, §5.15) — inside the provider's 24 h idempotency window; beyond it the guarantee is the lease, not a new one.
- [x] An increase in never-cross-checked paid money is visible without opening a CI log. (R13-9, §5.15) — `::warning::` is a workflow annotation, so it appears on the run list; the baseline is recorded beside the comparison.
- [x] The last successful tick's age is an input to `config`'s verdict, so a dead timer is itself a finding. (R13-3, §5.15) — **as amended by the fix pass**: the age is an input to the *report*, carried as an `operator`-severity finding and a `heartbeats` block, and deliberately **not** to the status code. The doc's own wording ("let `config`'s report fail when it is older than an hour") was not taken, because `ok` has meant "would `requireProdEnv()` refuse to serve?" since R07 and a starved CI scheduler is not an answer to it. The box is ticked on the amended reading and the amendment is stated rather than absorbed.
- [ ] **Every job's failure has a named owner** — the detection half is closed by R13-3 (a never-reported or past-bound route is a finding in `config`'s body), the *push* half is not: nobody is alerted, and a scheduler that is both dark and the only caller of `config` still has no reader. Owned by §12 U13-4's pinger and `08` §7 R08-3's terminal-rejection alerting. **This is the one box the fix pass leaves open on purpose**, and it is the reason R13-3 reads "fixed in part".
- [ ] `POST /api/admin/outbox/retry` writes an `AuditLog` row (`14` R14-9) — not done here; `14` owns the audit trail.
- [x] The schedule inventory in §5.1 stays true: adding a route under `app/api/jobs/` without a caller, or adding a caller without a run bound, is caught in review. — and the criterion earned its place: §5.1 **was** stale when this pass started (the sixth route landed in `08`'s pack after this doc was authored), so the table and a correction paragraph were added. The check that keeps it true remains a reading of §5.1, not a test — no automated detector for it exists.

Budget: to reach **GO** for this doc, one of R13-1, R13-3 must be closed and the other must have an owner and a date; R13-2 must be closed before any preview deployment shares the production `DATABASE_URL`. R13-4 through R13-9 may ship with an issue each, because each is bounded and self-healing.

After the fix pass (§5.15), the criteria the pass added — ticked in the same run that produced §5.15's command list:

- [x] Each finding the pass closed has a `Fix.` and a `Status.` in §7 that names the file, the mechanism, and the limit it did **not** close (§7 R13-1…R13-9)
- [x] Every number the fixes rest on was re-derived rather than rounded to: the 30 s ceiling, the 10 s row ceiling, the 6 s slack and the 24 s budget are one identity asserted against the routes; the heartbeat bounds are asserted as *twice the measured worst gap*, so re-taking §5.6's measurement moves them (§5.15)
- [x] The gates ran on the fix pass's own tree, both arms: the full suite against a real Postgres at 52 files / **768 passed / 0 skipped** (749 → 768, +19 accounted for file by file), plus the DB-less run at 44 passed | 8 skipped files, `tsc` and `eslint` clean, `prisma format --check` and `validate` clean, `audit:prod` clean, and the production-config gate failing on a missing required var and passing on a complete one (§5.15)
- [x] The two defects the fix pass found by writing tests were fixed before the commit and are recorded rather than quietly dropped: the empty `?limit=` → `1` clamp, and the §5.1 staleness (§5.15)
- [x] The claim-vs-delivery split the review's own findings forced is written down: the *app* keeps the lease and the backoff, the *provider* holds the 24 h idempotency window, and neither is presented as covering the other (§7 R13-1, R13-8)
- [x] The doc's own §5.1–§5.14 readings keep their 2026-09-15 date and stay as measured; where a fix changed the mechanism they describe, the change is in §5.15 and §6 and the old line numbers are not retro-fitted (§5.15, closing paragraph)

Budget after the fix pass: R13-1 is closed, R13-1's and R13-3's owners are named, and R13-2 is closed — so this doc's own GO conditions hold, with the residue (§12 U13-4, `08` R08-3, `14` R14-9) named rather than waived.

## 9. Open questions

1. **Is `reconcile`'s 200-for-`unverified` still right now that its only caller is a CI step rather than a pager?** The docstring's argument was about a pager that would mute a noisy report; a CI step cannot mute, but it also cannot be read unless someone looks. Recorded as R13-9 with the design credited. *Answered by the fix pass, and the 200 stands:* the pass took the documentation arm rather than overruling the decision — the count is now compared against a recorded baseline and annotated with `::warning::` on growth (R13-9), so it is visible on the run list without opening the log, and an increase is what raises the question again rather than an arbitrary threshold. If a pager is ever pointed at the route, this question reopens and `08` §7 R08-3 owns that decision.
2. **What is the intended cadence for `config`?** The route's own docstring says "every tick" (`app/api/jobs/config/route.ts:27-28`) and the only tick is the GitHub one; `lib/env.ts:137` calls it "every 10-minute tick". Neither the plan nor the runbook states a number, so the intent is 10 minutes and the practice is 3 h 12 m (R13-3). *Answered by the fix pass — by measuring instead of declaring:* no cadence number was invented and the docstrings were not edited to match reality, because the honest answer is that the schedule is best-effort and the *arrivals* are what matter. The heartbeat bounds are §5.6's measurement made load-bearing: `2 × 6 h 40 m` = 13.3 h for the three tick-only routes and the daily Vercel backstop + 2 h = 26 h for the two that own one (`lib/jobHeartbeat.ts:42-53`). The "every 10 minutes" phrasing in the code comments therefore survives as the *nominal* figure, and the gap between nominal and practice is now a reported number rather than a footnote. §5.6's 5.1 % measurement is unchanged and is the input to both bounds.
3. **Should the two Vercel crons carry staggered `limit` values?** They currently duplicate the GitHub tick's work with the same 25/10 bounds (`vercel.json:3-5`), so on a day when both fire the queue is served twice within half an hour and then not again for the rest of the day. *Unchanged by the fix pass, with the input it was missing now present:* the bounds were not staggered, but they are now **stated in the scheduler itself** — `vercel.json` names them in the path (`/api/jobs/outbox?limit=25`, `/api/jobs/screenshot?limit=10`), so a reader of the schedule can see what each entry will do without opening the route. Whether to stagger still needs U13-2 (whether these entries fire at all), and staggering would only smooth a day whose shape is not yet observed.
4. **Does anything need `POST` on `config`?** `reconcile`'s docstring justifies exposing both verbs "so this can be put on a cron without a code change" (`route.ts:93-95`); `config` exposes both too (`app/api/jobs/config/route.ts:34`), but the tick uses `GET`, leaving `POST` unused by any caller. *Answered by the fix pass, in the affirmative but not the way the question expected:* every arrival at `config` now stamps its own heartbeat, on either verb (`app/api/jobs/config/route.ts:115`), so the unused verb is no longer a branch nothing exercises as far as the schedule record is concerned — it is a second door to the same recorded arrival. `GET` remains the only verb the tick uses, and `POST` is kept as the docstring's no-code-change affordance; the cost of keeping it is one branch in the same handler that already had to exist.
5. **Is the `backfill` path (`screenshot/route.ts:43-53`) safe to run against production?** It re-arms up to 50 preview rows per call and is reachable by the authenticated tick's manual dispatch; nothing in the repository says when it should be used. Recommend confining it to `workflow_dispatch` (which it already is, `outbox-tick.yml:11-16`) and stating that in the operator runbook. *Answered by the fix pass on the safety half, deferred on the paperwork:* the path is still `workflow_dispatch`-only and still re-arms only `preview-<id>` rows, and the drain it feeds is now type-filtered to `PREVIEW_GENERATE` (R13-7) — so a production run of `backfill` cannot claim a mail row or an analytics row, which is the part of the question that could cost money. The sentence "when to use it" is not written: the operator runbook is `17`'s surface and this doc records the residue rather than inventing a procedure.

## 10. Cross-references

- `11` §5 documents these routes' HTTP shape (status codes, envelopes); this doc adds only unattended-caller semantics. `11` R11-4 (no rate limit on job and admin routes) is not re-reported here: a job endpoint cannot be per-IP-throttled without throttling the scheduler that calls it.
- **`11` U11-5 is settled here.** The question was "whether anything actually calls `/api/jobs/config`". Answer: yes — `.github/workflows/outbox-tick.yml:78-87` (config) and `:89-98` (reconcile), as the workflow's last two steps, each guarded by `if: ${{ !cancelled() }}`, with a non-2xx failing the run. Evidence: 26 consecutive green scheduled runs since 2026-09-11T13:48:12Z (§5.6). `11` §12 is updated accordingly.
- `05` §7 R05-7 (the report/waitlist mail chain, its 3 s/5-row drain and the 04:00 cron retry) is batch-1 territory and is cited, never re-reported; R13-5 only adds the *bulk* case the 3 s/5-row budget does not cover.
- `12` owns `OutboxEvent`'s DDL, the partial index that makes the claim cheap (R12-6) and the enum case split (R12-7). The lease, the backoff and the abandonment rule are this doc's.
- **`10` (email and notifications, batch 2) owns** what a receipt must contain, who is suppressed, and whether `EmailLog.status='logged'` counts as delivery; R13-1 and R13-8 register the queue-side halves and say so in their Status lines. **`06`/`08`** own the acceptance and settlement rules that decide *when* a `RECEIPT_EMAIL` row is enqueued (`lib/settle.ts:282`).
- `14` owns exploitability: R13-2's fail-open auth is the queue-draining path to the free stake chain `14` R14-1 describes; the query-string `?secret=` form (`reconcile/route.ts:47`, `config/route.ts:35`) is a token-in-URL habit that reaches access logs, registered there.
- `15` owns the cost and latency of these runs: the 25/10 bounds and the daily backstop are inputs to its checkout-rate model, and `15` §12 carries the value of a killed invocation.
- `03` (the board) and `04` (money) are untouched by this doc except where settlement enqueues mail.
- `doc/PROD-READINESS-CHECKLIST.md` §4b records the 2026-09-11 cadence measurement (~7 %) and the manual-dispatch proof; §7 records why the Vercel cron history cannot be read from a checkout. Both are cited, not repeated.
- `HANDOFF.md:807-821` records the 2026-09-11 decision that the external pinger is optional; this doc measures what that costs (R13-3).
- `lib/jobBudget.ts` and `lib/jobHeartbeat.ts` are this doc's fix pass's own modules (§5.15) — the shared budget identity the two workers and the tests read, and the heartbeat record plus the report `config` serves. `prisma/migrations/0010_job_heartbeats/` is the table they store into, and `lib/jobsAndCron.test.ts` is the suite that keeps the numbers coupled to the routes rather than merely written down.
- `vercel.json` — the two daily entries now name their per-invocation bound in the path (`/api/jobs/outbox?limit=25`, `/api/jobs/screenshot?limit=10`), so a reader of the schedule can see what each entry will do without opening the route; §5.1's inventory is where the entry-to-route mapping is recorded, and R13-5 explains why the bound stayed at 25.
- `lib/env.ts`'s `isLocalDatabase()` (R13-2) is the predicate the job auth now depends on, and it is deliberately keyed on the host rather than on the environment string — the DB suites of `05` and `08`–`12` run against loopback containers that stay inside the accepted set, so none of them gained a secret to run.
- `app/api/admin/outbox/retry/route.ts`'s `delivery` field (R13-1) is this doc's one addition to `11`'s HTTP contract: `11` §5 documents the shared envelope, and the retry route's 409 is the response that carries a field beyond `{error, code}` — §5.15 records why the shared `apiError` helper could not be used for it.
- `doc/ARCHITECTURE.md` §7 — the outbox-processing paragraph, now naming the budget, the `?limit=` schedules, the tick's `remaining` re-loop and the heartbeat block, so the architecture doc and this one describe the same mechanism.
- `HANDOFF.md:135-141` — the operator-facing list of job paths went from four to five, with the `?limit=` values and the note that a heartbeat finding is advisory and does not move `config`'s status code.
- `doc/PROD-READINESS-CHECKLIST.md:157` — carries this pass's note on the 2026-09-11 ingested `crons.definitions` against the current paths, so the divergence between what the platform has ingested and what `vercel.json` now says is disclosed on the row that quotes it rather than only here.

## 11. Change log

- 2026-09-16 (working tree) — fix pass for R13-1…R13-9, each cited in §7 with its verification in §5.15 (a new section). Written against a real Postgres: the same `postgres:16-alpine` the `08`–`12` passes used on host port 55433, all **eleven** migrations `0000`–`0010` applied with `prisma migrate deploy`, `npm run test:ci` green at **52 files / 768 passed / 0 skipped** (749 → 768, the +19 accounted for file by file in §5.15), the DB-less run green at 44 passed | 8 skipped files and 641 passed | 127 skipped tests, `tsc` and `eslint` clean, `prisma format --check` and `validate` clean, `migrate diff` empty against a freshly migrated database, `npm run audit:prod` clean, and the production-config gate exercised on **both** arms — exit 1 on a missing required variable, `check-prod-env: production config OK.` on a complete one. The pass added two modules (`lib/jobBudget.ts`, `lib/jobHeartbeat.ts`), one migration (`0010_job_heartbeats`), one suite (`lib/jobsAndCron.test.ts`, 16 tests, 3 of them DB-gated) and one lazily-imported table, and rewrote five job routes, the retry route's refusal payload, the `vercel.json` cron paths and the tick workflow. Two defects were found by the new tests and fixed before this entry was written: an empty `?limit=` clamping to 1 (one row per day from a scheduler asking for work), and §5.1's route inventory, which was stale because the sixth route landed in `08`'s pack after this doc was authored. Behavioural evidence beyond the suite: production run `35065018318` (2026-09-16T06:43Z) answered `reconcile` with `{"divergent":0,"ok":true,"paidTotal":3,"unapplied":0}` and `config` with 200 plus one Upstash `degraded` advisory, all seven `run:` blocks pass `bash -n`, the workflow YAML parses to seven steps, and a stub-`curl` harness over the rewritten tick logic passed 10/10. R13-3 is closed **in part** — detection yes, notification no — and U13-4 records why that half is not the repository's to close.
- 2026-09-15: authored 2026-09-15 against `9681bdc`, from the reads and probes in §5 (production-mode build on `:3211`, dev on `:3215`, scratch Postgres on `127.0.0.1:55440`, `gh run list` against the repository's own workflows); nothing fixed, no production row touched, no secret printed, no `.env` created. §1 corrects the plan's "exactly two jobs" framing by adding the GitHub Actions scheduler; §10 settles `11` U11-5.

## 12. UNKNOWN log

| Id | Unknown | What settles it |
| --- | --- | --- |
| U13-1 | Whether the GitHub tick ever reaches its nominal `*/10` cadence on a busier day — 5.1 % is measured over 110 h with a median gap of 3 h 12 m, and the mechanism (shared CI scheduler, best-effort) cannot be fixed from the repository. | `gh run list --workflow=outbox-tick.yml --limit 200 --json event,startedAt` re-run after a week of higher repository activity. *The fix pass makes this a load-bearing input rather than a curiosity:* the heartbeat bounds are asserted as *twice the worst observed gap*, so a re-run that finds a longer gap moves the bounds and fails the derivation test until they are updated (§5.15, R13-3) |
| U13-2 | Whether the two `vercel.json` crons actually fire on the current deployment, and what Vercel does with a failing invocation (retry, or nothing). Read-only, needs production access this checkout does not have. | Vercel dashboard `Project → Settings → Cron Jobs` history for `periodictable.lol`, or `vercel crons ls` with a working token. *Unchanged by the fix pass, and now self-answering if it is:* the entries are identifiable in the dashboard by their query strings (`?limit=25`, `?limit=10`), and a firing entry stamps the same heartbeat the GitHub tick does — so if they fire, `outbox` and `screenshot` will show stamps far newer than 24 h apart |
| U13-3 | Whether GitHub disables the scheduled workflow after 60 days of repository inactivity, and whether anyone is notified when it does. Quoted from platform behaviour; the repository was pushed to on 2026-09-15, so the clock is far from expiry. | The repository's Actions tab after a 60-day quiet period — or read the workflow page's own state; it reports `active` via `gh workflow list` today. *Unchanged by the fix pass, which is what makes it visible in principle:* a disabled schedule stops all five stamps at once, so `config`'s `heartbeats` block would list five never-reported-or-stale routes — subject to the same reader problem R13-3 records, since `config` has no other caller |
| U13-4 | Whether an external pinger (cron-job.org or similar) exists and is pointed at the four job URLs — the repository's decision record makes it optional, and nothing in the checkout can see an external service. | The pinger's own console / URL list (operator reading). This is the same residue as `11` U11-5's second half. *The fix pass promotes this row from optional to the named owner of R13-3's open half:* acceptance box 1 stays unticked because nothing pushes an alert, and no code in this repository can close that |
| U13-5 | The exact number of sends a platform kill at 30 s costs: the row keeps its lease and self-heals (§5.9), but whether the in-flight send had already left Resend is not observable from here. | One real 30 s kill in production (`vercel logs` for the invocation) plus the `EmailLog` rows around it. *Narrowed by the fix pass, not settled:* the worst case is now 24 s of work plus one row's ≤10 s ceiling inside the remaining 6 s (R13-4), so a kill is no longer reachable by a legitimate full row unless that row itself overruns its own ceiling; and whether an in-flight send escaped no longer decides whether a retry duplicates, because the row's idempotency key holds for 24 h (R13-8) |
| U13-6 | The production queue's depth, attempt distribution and `EmailLog.status` mix — §5.7 reads a scratch database replayed from migrations, so its 115/0/0/32 figures describe the probe, not the product. | `GET /api/jobs/outbox` with credentials on production (its body reports `claimed/completed/failed`) plus a read-only `SELECT count(*) … WHERE "attempts" >= 5` against the production database. *Unchanged, with one half now cheaper:* every drain response carries `remaining`, a `count(*)` over the due rows (`lib/outbox.ts:401-410`), so the same call that drains also answers the depth question; the attempt distribution and the `EmailLog.status` mix still need SQL |

**Nothing in this table was settled by the fix pass.** One row became a load-bearing input (U13-1 — the bounds are derived from it), two gained a mechanism that will show when they are answered (U13-2 and U13-3, via the heartbeat's stamps), one was promoted to the owner of R13-3's open half (U13-4), one was narrowed without being settled (U13-5), and one gained a cheaper read path for half of its question (U13-6).
