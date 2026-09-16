# Alerts and monitoring

Index and auth: `ops/README.md`. This file answers `R18-9` (every failure class
had no owner and no alarm), `R18-12` (the status codes a monitor reads were never
written down for the monitor) and `R18-15` (a runbook that says "check the logs"
has to say how long they last). Written by the phase-18 fix pass
(`doc/review/18-observability-analytics-alerts.md`, 2026-09-16).

## The two status codes, verbatim for the monitor

A free pinger can read a status code and nothing else. These are the only two
routes built for that, and they mean different things:

| URL | Code | Meaning |
| --- | --- | --- |
| `GET /api/health` | **200** | The process is serving **and** `SELECT 1` answered inside 2 s (`{ok:true,db:"up",ms,deploy,env}`). |
| | **503** | The database did not answer — down, unreachable, or slower than the 2 s budget (`{ok:false,db:"down",timedOut}`). |
| | 500 | Reserved for this route itself throwing. Treat as a bug here, not as a database incident. |
| `GET /api/jobs/config` | **200** | Authenticated **and** no `required` variable is missing, and Stripe accepted the key. |
| | **503** | Authenticated, but the deployment is misconfigured (`findings[]` says which key). Includes a *test-mode* `STRIPE_SECRET_KEY` in production (`R18-4`). |
| | **401** | The pinger's own secret is wrong. **Not** a deployment incident — fix the pinger, then check the log for what else it has been missing. |

Alarm on **anything that is not 200** for both. The distinction matters because a
401 that pings a phone for a week is how a real 503 gets ignored, and a monitor
whose liveness depends on a bearer token is one rotation away from that state
(`U18-3`).

`/api/health` answers without a token on purpose: liveness must not be gated on a
secret. It carries `no-store`, so a CDN cannot serve a stale 200. It says nothing
else about the deployment — no version list, no config, no counts.

## The monitor's URL list

Run one monitor (cron-job.org free tier or equivalent). The list, the interval
and the escalation path are operator decision **`D18-5`**; the interval below is
a recommendation, not a reading — nothing in this repository can prove a monitor
exists (`U18-3`). Five URLs, in this order of importance.

| # | URL | Auth | Alarm when |
| --- | --- | --- | --- |
| 1 | `/api/health` | none | not 200 |
| 2 | `/` (the public page) | none | not 200, or the body does not contain `periodic table` |
| 3 | `/api/jobs/config` | `-H "Authorization: Bearer $CRON_SECRET"` | 503 (401 = fix the monitor) |
| 4 | `/api/jobs/reconcile` | same header | 200 but `divergent.count > 0`, or not 200 |
| 5 | `/api/admin/ops?ok=1` | `-H "Authorization: Bearer $ADMIN_TOKEN"` | 503 |

The fifth URL is the one that reads the *queue and mail*, which no status code
could: it answers 200 normally and **503 exactly when its `alarms` list is
non-empty**. That is opt-in (`?ok=1`) because the route's default answer must
stay a stable 200 for anything that treats 200 as "the operator API works" — an
alarm is not an outage, and this route refuses to conflate them (`R18-8`,
`R18-12`). Poll it at **15 minutes** rather than 5: every number in it is a
window rate, and the thresholds below are hours, not seconds.

Monitor URL 2 is not paranoia. `/api/health` and `/` can fail independently: a
bad deploy that only breaks the server component render answers `200` on health
and 500 on the page.

## What pages a human (operator decision `D18-2`)

The channel and the recipient are the operator's to name — the repository cannot
know an address, and inventing one is worse than the blank. That answer is
decision **`D18-2`** (the alert channel, its recipient list and the thresholds)
in `doc/review/FINDINGS.md`; **`D18-5`** is whether a monitor runs at all, at
what interval, over which URLs, and **`D18-6`** is who is on call. Until those are
recorded, this table is the **signals**: what fires, at what threshold, and which
runbook acts on it.

| # | Class | Signal (what to poll) | Threshold | Where it is acted on |
| --- | --- | --- | --- | --- |
| 1 | Site down | `/api/health` ≠ 200, or `/` ≠ 200 | one failure, re-checked once | `ops/rollback.md`, `ops/comms.md` |
| 2 | Checkout 5xx | `/api/checkout` refusing buyers — **nothing polls this path**; today it shows up as `ProviderEvent` `ERROR` rows and a lower funnel in `/api/admin/ops` | any `ERROR` row in the window | `ops/payments-stuck.md`, keys `U18-5` |
| 3 | Webhook failure | Stripe dashboard endpoint error rate; `ProviderEvent` rows with `outcome='error'` | any non-zero | `ops/webhooks.md` |
| 4 | Ledger divergence | `/api/jobs/reconcile` → `divergent.count` | **> 0** | `ops/payments-stuck.md` |
| 5 | Queue depth / staleness | `/api/admin/ops` → `outbox.pending`, `oldestPendingMinutes`, `exhausted` | `pending ≥ 25`, or oldest ≥ 120 min, or `exhausted > 0` | `ops/email.md` |
| 6 | Mail failure | `/api/admin/ops` → `mail.failedCount`, `mail.driver` | `failedCount > 0` (warn), `driver == "logged"` (critical) | `ops/email.md`, `ops/secrets.md` |
| 7 | A tick stopped running | `/api/jobs/config` → `heartbeats[]` (advisory), `/api/admin/ops` → `staleTicks` (alarm) | `age > bound` — 26 h for the two daily-cron routes, 13 h 20 m for the three tick-only ones | `ops/README.md` §"The clock and the alarm" |

Rows 5–7 are the three the repository could not express before this pass: the
queue's depth was invisible everywhere (`R18-8`), a failed send was a row nobody
read (`R18-3`), and "the scheduler died six hours ago" looked exactly like "there
was nothing to do" (`R13-3`, `R18-9`).

### The shape of the channel, until `D18-2` is answered

The rows above name a signal, not an address. The smallest posture that covers
all seven, using accounts that already exist, is:

- **One mailbox** — the same address the operator signs in with — receiving the
  monitor's own failure mail, GitHub's red-Action mail for `outbox-tick.yml`
  (`U18-4`: confirm who is on that list) and Stripe's endpoint notifications
  (`U18-6`: confirm they are enabled). Four senders, one inbox, no pager.
- **Stripe's dashboard** for classes 2 and 3, because Stripe is the party that
  knows a charge failed or an endpoint is being disabled — our rows record what
  arrived, not what the provider gave up on (`U18-5`).
- **The monitor** for classes 1, 4, 5, 7 — the four questions a status code or
  the dashboard answers.

What none of that supplies is the night: classes 1–7 all reach a mailbox, and a
mailbox that is not being looked at is the same as no alarm. `D18-6` is that
decision, and "accept the delay" is a legitimate answer a solo launch can give —
it just has to be given rather than assumed.

### The alarm codes, as the code emits them

`GET /api/admin/ops` (or `/api/admin/ops?ok=1`) returns an `alarms[]` array, and
each entry carries `code`, `severity`, `detail`, `threshold` and `surface`. The
codes are stable; an alert rule keys on them, not on the prose.

| Code | Severity | Fires when |
| --- | --- | --- |
| `outbox-depth` | critical | `pending ≥ 25` **and** `due == 0` — the queue is not draining at all |
| `outbox-depth` | warn | `pending ≥ 25` with work still due — deep, but moving |
| `outbox-stale` | critical | the oldest undelivered row has waited ≥ 120 minutes |
| `outbox-exhausted` | critical | `exhausted > 0` — rows that have spent all attempts and will never be retried |
| `mail-failed` | warn | `failedCount > 0` — sent-and-failed messages no success superseded |
| `mail-not-sending` | critical | `RESEND_API_KEY` unset: every send is *recorded*, nothing leaves |
| `config-required` | critical | a `required` finding, including a test-mode Stripe key in production |
| `stale-tick:<route>` | critical | a worker has not stamped its heartbeat inside its bound |

The same numbers ride in headers for a poller that reads only those:
`X-Ops-Alarms` (comma-joined codes, or `-`), `X-Ops-Outbox-Pending`,
`X-Ops-Paid-Net-Usd`, `X-Ops-Errors` (rows the sink recorded in the window).

**Three deliberate gaps, stated so they are not mistakes.** Money is *not*
alarmed on: a refund is a decision, not a fault, and a threshold on the settled
rate would fire on every honest one. Divergence is not duplicated into
`alarms[]` because reconcile already turns it red on its own (`R18-4`, `E13`) —
the dashboard carries the ledger number (`money.paidNetUsd`, "paid payments net
of reversals") so a human can compare, not so a robot can page. And recorded
errors are not alarmed on either: `errors` reports what the sink wrote, and a
buyer whose browser threw once is not an outage — alert on the classes in the
table, and read `errors` when you are already looking.

## The stale-tick condition, exactly

`lib/jobHeartbeat.ts` stamps a row on every tick for five routes
(`/api/jobs/outbox`, `/api/jobs/screenshot`, `/api/jobs/abandoned-checkouts`,
`/api/jobs/reconcile`, `/api/jobs/config`). The bound is *derived*, not guessed:

| Route | Bound | Why |
| --- | --- | --- |
| `/api/jobs/outbox`, `/api/jobs/screenshot` | 26 h | `vercel.json` gives each a daily cron (04:00 and 04:30); 24 h + `HEARTBEAT_SLACK_MS` (2 h) |
| `/api/jobs/abandoned-checkouts`, `/api/jobs/reconcile`, `/api/jobs/config` | 13 h 20 m | Tick-only — no cron of their own; twice `TICK_WORST_OBSERVED_MS` (6 h 40 m, the worst gap in the 34-run / 110 h sample) |

The bounds are wide on purpose: GitHub's `*/10` schedule is best-effort, and a
2 h gap is normal. Only a stopped schedule trips these. If a route has *never*
run, the dashboard says so in those words (`stale-tick:<route>`, "has never
run").

`/api/jobs/config` reports the same ages as **advisories** that never fail its
`ok` — its 200/503 must keep meaning "config", and an unattended worker is
operator work, not an unservable deployment. `/api/admin/ops` escalates the same
read to a critical alarm, because that route's whole job is to answer "is
anything wrong?".

### Reading a log line (`R18-11`)

Every runtime line is one JSON object on stdout/stderr, written through
`lib/log.ts`:

```json
{"level":"error","scope":"api","msg":"unhandled","env":"production","deploy":"a1b2c3d4e5f6","requestId":"cku3…","method":"POST","path":"/api/checkout","status":500,"ms":412,"err":"Error: …"}
```

| Field | Reading |
| --- | --- |
| `level` | `info` \| `warn` \| `error` — see the rule below |
| `scope` / `msg` | Where it came from (`api`, `mail`, `outbox`, `settle`, `stripe`, `audit`, …) and what happened, both short and stable enough to filter on |
| `env`, `deploy` | The environment and the build: commit sha, else deployment id, else `dev` |
| `requestId` | Present only inside a request — `api` invocation lines and anything they call. A worker or a script has none, and says so by omission |
| everything else | The fields the call site passed, with credentials, addresses and payloads deliberately left out |

**The level rule**, and the filter it makes safe:

- `warn` — a failure the caller **survived**: mail that did not go out, a preview
  that did not render, an audit row that could not be written. The user got the
  outcome they were promised and something else retries the work.
- `error` — a failure that **changed the outcome**: a rejected delivery, a
  payment that could not be applied, an unhandled route error. Anything an
  operator should be woken for is here and nowhere else.
- `info` — things that happened as designed, including the one line per request
  (`{"scope":"api","msg":"invocation"}` with `path`, `status`, `ms`).

So `level:"error"` is a filter for "something is broken" and `level:"warn"` is a
to-do list, not an alarm. A line that cannot be serialised renders as
`{"level":…,"unserializable":true}` rather than throwing inside the logger.

## Log retention, and what survives it (`R18-15`)

Runtime logs are the platform's. On Vercel's free/Hobby tier the retention is
**about one hour**, and no log drain is configured unless the operator has
bought one (`U18-1`, `U18-2`, decision `D18-4`). **Never treat a log line as a
record.** Everything that must outlive an incident is already in Postgres:

| Question you would ask a log | Durable substitute | Lifetime |
| --- | --- | --- |
| Did an error happen, and how often? | `ErrorReport` rows (`/api/internal/error` sink, `R18-1`), read back as `/api/admin/ops` → `errors` (`count`, `bySource`, `recent`) | **forever — nothing deletes them yet.** Writes are capped at 30 per 60 s per instance with a per-fingerprint dedupe window, so the growth is slow and pruning is an operator chore, not an incident |
| What did the webhook do with this event? | `ProviderEvent` (`detail`, `outcome`), written for every delivery | forever |
| Did the receipt mail leave? | `EmailLog.status`/`detail` (truncated provider reason, `R18-3`) | forever |
| Why did this outbox row fail? | `OutboxEvent.lastError`, `attempts` | until the row completes |
| When did a worker last succeed? | `JobHeartbeat.lastRunAt`/`lastError` | forever (upserted) |
| Who changed what? | `AuditLog` (`GET /api/admin/audit`) | forever |
| What did a payment do? | `Payment` + `AuditLog.action = PAYMENT_REVERSED` | forever |
| Is the deployment configured? | `GET /api/jobs/config` | live read |

So a runbook step that says "check the logs" means check *within the hour*, and
use the table above for anything older. That is the whole of `R18-15`: the
retention window is one hour, and each substitute is named by the runbook that
used to point at a log line.

## Reading the audit trail (`R18-5`)

`GET /api/admin/audit` is the reader the review found missing: `PAYMENT_REVERSED`,
`PROFILE_MODERATED` and `REPORT_TRIAGED` wrote rows nothing could show.

```sh
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$APP_URL/api/admin/audit?action=PAYMENT_REVERSED"
```

| Parameter | Meaning |
| --- | --- |
| `action=` | One of the actions in `lib/audit.ts`. An unknown value is **400** `BAD_ACTION`, not an empty page — a filter that silently matches nothing is how a cleared queue looks like a clean one. |
| `startup=` | Rows for one listing's domain. |
| `payment=` | Rows for one payment. |
| `before=` | Cursor: only rows older than this id. Newest-first, 50 per page, so a fifth page continues with the last id. |

The response body is a bare array and the counts are headers
(`X-Audit-Window-Days`, `X-Audit-Payment-Reversed`, `X-Audit-Profile-Moderated`,
`X-Audit-Report-Triaged`, `X-Audit-Operator-Writes`), so one call answers "what
happened recently" and "how much of it" at once. The same data by SQL, for a
`psql` session without the API:

```sh
psql "$DATABASE_URL" -c "SELECT action, count(*) FROM \"AuditLog\" WHERE \"createdAt\" > now() - interval '7 days' GROUP BY action ORDER BY 2 DESC;"
```

## What is not covered here

- **No log drain** until `D18-4` says so; the platform's hour is the entire story.
- **No status page** until `D18-8` (customer-facing comms is `ops/comms.md`).
- **No on-call rotation** until `D18-6`; for a solo launch "on call" is that
  decision's answer, and the honest default is "the monitor emails, and nothing
  pings a phone".
- **The dashboard's form is `D18-7`** — a manual SQL checklist or this
  operator-only page. The page exists either way (`R18-7`); what is not settled
  is whether it becomes the procedure.
- **Analytics are off, and gated** (`R18-13`): the switch is
  `NEXT_PUBLIC_PLAUSIBLE_DOMAIN`, and even when it is set the script loads only
  after a visitor accepts the notice (`lib/analyticsConsent.ts`, decision
  `D18-3`). No funnel
  number comes from a browser — `/api/admin/ops` → `funnel` computes
  click → checkout → paid from our own tables (`R18-14`).
