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

## 7. Findings

### R13-1 — A mail send that failed is marked complete, and a completed row cannot be retried

- **Severity.** P1
- **Category.** correctness · operational blind spot · customer-visible
- **Evidence.** `lib/email.ts:66,68` return `"error"` (no throw) for a non-2xx or a thrown request; `lib/outbox.ts:126-134` therefore takes the success branch and sets `completedAt`; `lib/outbox.ts:128` skips completed rows on every later run; `app/api/admin/outbox/retry/route.ts:25-26` answers `409 ALREADY_DONE` for the same row. Witness §5.7: 115 rows all complete, zero retried, 32 `EmailLog` rows all `logged`.
- **Reproduction.** With `RESEND_API_KEY` absent (so `deliver()` returns `"logged"`, `lib/email.ts:41`) enqueue a `RECEIPT_EMAIL` row and drain it; then read `EmailLog.status` — the row is complete and no mail exists. For the error branch, point `lib/email.ts:46` at a 500 and repeat; the same completion happens with `lastError` unset.
- **Proposed fix.** In `handleOne`'s email cases, throw when `deliver()` returns `"error"` so the existing backoff and attempt limit apply; treat `"logged"` as non-terminal in production only (or surface `EmailLog.status` in the retry route's response so the operator can see it before re-arming).
- **Status.** open (draft) — the *queue* semantics are this doc's; what a receipt must contain and whether a `logged` row counts as delivered is `10`'s.

### R13-2 — Job authentication is fail-open outside production

- **Severity.** P2 (P1 if a preview deployment shares the production `DATABASE_URL`)
- **Category.** security · operational
- **Evidence.** `lib/jobs.ts:25-28` returns `null` — i.e. *allow* — when the environment is not production. Measured on `:3215` (and re-confirmed by every §5.8 call, which carries no credential): unauthenticated `GET /api/jobs/outbox`, `/api/jobs/reconcile`, `/api/jobs/screenshot` all answer **200**; only `config` answers 503, and that is its findings, not its auth (§5.2). The same matrix on the production-mode build answers 401 with a 24-byte body for every one of them.
- **Reproduction.** `npx next dev` with `DATABASE_URL` pointing at any database, then `curl -s "http://localhost:PORT/api/jobs/outbox?limit=25"` with no credentials — the drain runs.
- **Proposed fix.** Treat `VERCEL_ENV`/`NODE_ENV` *not equal to* `production` as "require the secret if it is configured", and require it outright whenever `DATABASE_URL` points at a non-local host; or make the dev exemption depend on a loopback database.
- **Status.** open (draft) — the reachability chain to a free stake through a preview deployment is `14`'s (`14` R14-1); this row registers the queue-draining half.

### R13-3 — The maintenance channel runs at 5 % of its nominal cadence, alerts one human, and cannot notice its own death; inside the queue, no failure notifies anyone

- **Severity.** P2
- **Category.** operability · money detection latency
- **Evidence.** §5.6: 34 scheduled runs in 110.12 h against 661 nominal ticks (**5.1 %**), gap min/median/max **1 h 44 m / 3 h 12 m / 6 h 40 m**, 32 green and 2 red, last red 2026-09-11T13:48:12Z, 26 consecutive green since. `outbox-tick.yml:5-6` expects those ticks to be "a few minutes late". The same effect is already recorded in `doc/PROD-READINESS-CHECKLIST.md` §4b (~7 % on 2026-09-11) and accepted in `HANDOFF.md:807-821`. `reconcile` and `config` are called by this tick and nothing else (§5.13).
- **Nobody is told.** Per job, the failure surfaces are empty: a mail row that exhausts its five attempts (`lib/outbox.ts:15,128`) sets no flag, increments no counter anyone reads, and appears in no response field and no admin view (§5.11) — the only reader is a human with a `psql` session; an `EmailLog` row with `status='error'` (`lib/email.ts:66`) is written once and never read by any code in the repo; an invocation killed at `maxDuration` appears only in Vercel's function error log (§5.10, R13-4); and a tick that never arrives is invisible to the application, because the application never records one arriving (no heartbeat table, no `lastRunAt` column — the tick's only trace is in GitHub's Actions history, §5.6).
- **Reproduction.** `gh run list --workflow=outbox-tick.yml --limit 200 --json event,startedAt,conclusion` and compare the scheduled count with elapsed time / 10 minutes.
- **Proposed fix.** Two independent, cheap: (a) have the *app* record the last successful tick and let `config`'s report fail when it is older than an hour — a dead timer then becomes a 503 on the surviving path; (b) move `reconcile` onto the daily Vercel pair, where a schedule the platform owns cannot be starved by a shared CI queue. Add a heartbeat notification (email/Slack) on a red tick so the alert does not depend on one human reading the Actions tab.
- **Status.** open (draft)

### R13-4 — Both workers' worst-case work equals their `maxDuration` exactly

- **Severity.** P2
- **Category.** resilience · operability
- **Evidence.** §5.10: `jobs/outbox/route.ts:6,25,31` and `jobs/screenshot/route.ts:7,56,62` check a 20 s deadline *between* rows, while the in-flight row may run to its own 10 s ceiling (`lib/email.ts:64`, `lib/screenshots.ts:63`) — 20 s + 10 s = 30 s = `maxDuration`, with no allowance for the claim's own database round-trips or Prisma connection acquisition.
- **Reproduction.** Enqueue 25 rows whose handler sleeps 10 s (a stub is enough) and call the route in production mode; the invocation can exceed the platform limit instead of returning the route's JSON.
- **Proposed fix.** Budget the deadline *including* the in-flight ceiling: stop claiming rows once `remaining < perRowCeilingMs`, or shorten the loop deadline to 15 s so the worst case stays inside a 30 s function with margin.
- **Status.** open (draft)

### R13-5 — The queue's retry cadence is the tick, and a backlog drains at the cadence rather than catching up

- **Severity.** P2
- **Category.** operability · customer-visible latency
- **Evidence.** `lib/outbox.ts:154-168` bounds a claim at 25 rows per run for the outbox path and 10 for the screenshot path (`jobs/outbox/route.ts:26`, `jobs/screenshot/route.ts:57`); the next opportunity is the next tick (median 3 h 12 m, §5.6) or the daily Vercel pair (`vercel.json:3-5`). The inline drains cover the common case only in bulk-up to 10 rows and 15 s in settlement (`lib/settle.ts:282`, budget `lib/settle.ts:76`) and 5 rows / 3 s for report and waitlist (`app/api/report/route.ts:74`, `app/api/waitlist/route.ts:63`).
- **Reproduction.** Enqueue 30 `RECEIPT_EMAIL` rows with delivery failing and watch how many attempts accumulate per hour: at most 25 rows are touched per tick, and the backoff floor of 30 s per attempt means attempt 5 is an hour out (`lib/outbox.ts:73-74`).
- **Proposed fix.** Have the tick loop until the queue is empty or a wall-clock budget is spent (the route already returns counts, so a second call is a curl away), and raise the daily backstop's `limit` above 25.
- **Status.** open (draft) — the report/waitlist chain's own 3 s/5-row drain and 04:00 retry are settled in `05` §7 R05-7 and are cited, not re-reported.

### R13-6 — A hard drain failure is reported as an empty queue

- **Severity.** P3
- **Category.** correctness · legibility
- **Evidence.** `lib/outbox.ts:177-191`: the claim is awaited outside the `try`, the processing loop is inside it, and a throw is swallowed into `console.error("outbox drain failed (non-blocking):", e)` at `:188`. `drainDueWithin` (`:203-220`) then resolves with `{completed: 0, failed: 0, timedOut: false}` — indistinguishable from an idle queue in the response body the tick prints.
- **Reproduction.** Make the handler throw for every row (or drop the database connection between claim and process) and call `/api/jobs/outbox`: the response is `{"ok":true,"claimed":n,"completed":0,"failed":0}`.
- **Proposed fix.** Count swallowed failures into the `failed` field, or add an `errors` count to the response, so `claimed > 0 && completed === 0` can never be mistaken for a quiet queue.
- **Status.** open (draft)

### R13-7 — The screenshot worker claims rows it cannot process, and reports them as `checked`

- **Severity.** P3
- **Category.** correctness · legibility
- **Evidence.** §5.8: `jobs/screenshot/route.ts:58` claims with no type filter, `:65` continues past every non-`PREVIEW_GENERATE` row, `:70` reports `checked: claimed.length`. Measured on `:3215`: `{"ok":true,"checked":1,"updated":0,"failed":0}` while a `STAKE_ANALYTICS` row gained a 299 s lease (`attempts` unchanged at `0`, `completedAt` still null) and the outbox drain that could have processed it answered `{"ok":true,"claimed":0,…}`; after the lease expired the same drain answered `{"ok":true,"claimed":1,"completed":1,…}` and the row was complete.
- **Reproduction.** Make a single non-preview row the only due row and call the route with `limit=1`; compare `checked` with what the job can act on.
- **Proposed fix.** Pass `["PREVIEW_GENERATE"]` to `claimDueOutbox` (the parameter already exists — the inline drains use it) and report `checked` as the count of rows this job could act on.
- **Status.** open (draft)

### R13-8 — The mail send carries no provider idempotency key

- **Severity.** P3
- **Category.** correctness
- **Evidence.** §5.12: `git grep -n 'Idempotency-Key'` matches exactly once, `lib/stripe.ts:122` (`pt_checkout_${paymentId}`); the Resend call (`lib/email.ts:46-64`) sets none, and its 10 s abort (`:64`) is what converts an unanswered-but-delivered send into an `"error"` (which §5.7 then marks complete).
- **Reproduction.** Point `lib/email.ts:46` at a server that accepts the payload and never responds; the row completes as `"error"`, and `POST /api/admin/outbox/retry` with the same `dedupeKey` sends it a second time.
- **Proposed fix.** Send a deterministic `Idempotency-Key` derived from `dedupeKey` (Resend honours it for 24 h), so a retry inside that window is a no-op rather than a duplicate.
- **Status.** open (draft) — what a duplicate receipt costs the customer relationship is `10`'s.

### R13-9 — Money accepted without a provider cross-check is only visible in a CI log

- **Severity.** P3
- **Category.** operability · residual risk
- **Evidence.** `app/api/jobs/reconcile/route.ts:64-80` counts `unverified` rows and groups them by provider; `:90` answers **200** for them by design, and the docstring at `:37-43` reasons that a report paging on it "would be muted before the divergent case ever fired". The only caller prints the body into the Actions log and fails the step on a non-200 (`outbox-tick.yml:89-98`), so the count reaches a reader only when someone opens the run.
- **Reproduction.** `GET /api/jobs/reconcile` with credentials on a database holding a `PAID` payment with `providerAmount = null`: `ok: true` (200) with `unverified.count ≥ 1`.
- **Proposed fix.** Have the tick assert the `unverified.count` against a recorded baseline and annotate the run when it grows (`echo "::warning::"`), which keeps the design's "never page on it" while making an increase visible without opening the log.
- **Status.** open (draft) — this is a residual on a deliberate decision, not a re-report of it.

## 8. Acceptance criteria

- [ ] Every job's failure has a named owner: `outbox` and `screenshot` alert on a red tick, `reconcile` and `config` alert independently of that tick, and a row reaching five attempts appears somewhere a human reads. (R13-3)
- [ ] A mail send that returns `"error"` leaves the row retryable, and a row completed while `deliver()` returned `"logged"` is distinguishable in the retry route's response. (R13-1)
- [ ] `jobAuth` fails closed whenever the database is not local, whatever the framework's environment string says. (R13-2)
- [ ] The worst case of one invocation — deadline plus the in-flight per-row ceiling plus claim round-trips — is provably inside `maxDuration`. (R13-4)
- [ ] A backlog larger than one run's bound drains in a bounded time rather than at the tick cadence, and the bound is stated in the job's response. (R13-5)
- [ ] `claimed > 0, completed = 0` cannot be produced by a swallowed exception. (R13-6)
- [ ] `screenshot` claims only `PREVIEW_GENERATE` and its `checked` counts only rows it can act on. (R13-7)
- [ ] A retry that follows an aborted-but-delivered send does not send a second time. (R13-8)
- [ ] An increase in never-cross-checked paid money is visible without opening a CI log. (R13-9)
- [ ] `POST /api/admin/outbox/retry` writes an `AuditLog` row (`14` R14-9).
- [ ] The last successful tick's age is an input to `config`'s verdict, so a dead timer is itself a finding. (R13-3)
- [ ] The schedule inventory in §5.1 stays true: adding a route under `app/api/jobs/` without a caller, or adding a caller without a run bound, is caught in review.

Budget: to reach **GO** for this doc, one of R13-1, R13-3 must be closed and the other must have an owner and a date; R13-2 must be closed before any preview deployment shares the production `DATABASE_URL`. R13-4 through R13-9 may ship with an issue each, because each is bounded and self-healing.

## 9. Open questions

1. **Is `reconcile`'s 200-for-`unverified` still right now that its only caller is a CI step rather than a pager?** The docstring's argument was about a pager that would mute a noisy report; a CI step cannot mute, but it also cannot be read unless someone looks. Recorded as R13-9 with the design credited.
2. **What is the intended cadence for `config`?** The route's own docstring says "every tick" (`app/api/jobs/config/route.ts:27-28`) and the only tick is the GitHub one; `lib/env.ts:137` calls it "every 10-minute tick". Neither the plan nor the runbook states a number, so the intent is 10 minutes and the practice is 3 h 12 m (R13-3).
3. **Should the two Vercel crons carry staggered `limit` values?** They currently duplicate the GitHub tick's work with the same 25/10 bounds (`vercel.json:3-5`), so on a day when both fire the queue is served twice within half an hour and then not again for the rest of the day.
4. **Does anything need `POST` on `config`?** `reconcile`'s docstring justifies exposing both verbs "so this can be put on a cron without a code change" (`route.ts:93-95`); `config` exposes both too (`app/api/jobs/config/route.ts:34`), but the tick uses `GET`, leaving `POST` unused by any caller.
5. **Is the `backfill` path (`screenshot/route.ts:43-53`) safe to run against production?** It re-arms up to 50 preview rows per call and is reachable by the authenticated tick's manual dispatch; nothing in the repository says when it should be used. Recommend confining it to `workflow_dispatch` (which it already is, `outbox-tick.yml:11-16`) and stating that in the operator runbook.

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

## 11. Change log

- 2026-09-15: authored 2026-09-15 against `9681bdc`, from the reads and probes in §5 (production-mode build on `:3211`, dev on `:3215`, scratch Postgres on `127.0.0.1:55440`, `gh run list` against the repository's own workflows); nothing fixed, no production row touched, no secret printed, no `.env` created. §1 corrects the plan's "exactly two jobs" framing by adding the GitHub Actions scheduler; §10 settles `11` U11-5.

## 12. UNKNOWN log

| Id | Unknown | What settles it |
| --- | --- | --- |
| U13-1 | Whether the GitHub tick ever reaches its nominal `*/10` cadence on a busier day — 5.1 % is measured over 110 h with a median gap of 3 h 12 m, and the mechanism (shared CI scheduler, best-effort) cannot be fixed from the repository. | `gh run list --workflow=outbox-tick.yml --limit 200 --json event,startedAt` re-run after a week of higher repository activity. |
| U13-2 | Whether the two `vercel.json` crons actually fire on the current deployment, and what Vercel does with a failing invocation (retry, or nothing). Read-only, needs production access this checkout does not have. | Vercel dashboard `Project → Settings → Cron Jobs` history for `periodictable.lol`, or `vercel crons ls` with a working token. |
| U13-3 | Whether GitHub disables the scheduled workflow after 60 days of repository inactivity, and whether anyone is notified when it does. Quoted from platform behaviour; the repository was pushed to on 2026-09-15, so the clock is far from expiry. | The repository's Actions tab after a 60-day quiet period — or read the workflow page's own state; it reports `active` via `gh workflow list` today. |
| U13-4 | Whether an external pinger (cron-job.org or similar) exists and is pointed at the four job URLs — the repository's decision record makes it optional, and nothing in the checkout can see an external service. | The pinger's own console / URL list (operator reading). This is the same residue as `11` U11-5's second half. |
| U13-5 | The exact number of sends a platform kill at 30 s costs: the row keeps its lease and self-heals (§5.9), but whether the in-flight send had already left Resend is not observable from here. | One real 30 s kill in production (`vercel logs` for the invocation) plus the `EmailLog` rows around it. |
| U13-6 | The production queue's depth, attempt distribution and `EmailLog.status` mix — §5.7 reads a scratch database replayed from migrations, so its 115/0/0/32 figures describe the probe, not the product. | `GET /api/jobs/outbox` with credentials on production (its body reports `claimed/completed/failed`) plus a read-only `SELECT count(*) … WHERE "attempts" >= 5` against the production database. |
