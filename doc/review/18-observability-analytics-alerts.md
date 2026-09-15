# Phase 18 — Observability, analytics and alerts

| Field | Value |
|---|---|
| Phase | 18 |
| Batch | 4 — trust and operations |
| Owns (matrix, `00-REVIEW-PLAN.md` §1) | S12 L7; plus the cross-cutting instruction "must be read against every row" |
| Artifacts | this doc; `R18-1`…`R18-15` and `U18-1`…`U18-8` in `FINDINGS.md`; operator decisions `D17`–`D24` (this doc §9) |
| Commit reviewed | `9681bdcbff2435ef258224c52000e0f8d6089f5c` |
| Reviewed | 2026-09-15, read-only pass — no application code, config, test, migration or legal page changed |
| Reviewer | batch-4 agent pass; evidence = `git grep` censuses, file reads, live probes against `periodictable.lol`, one provider-documentation reading |
| Status | draft — findings registered, no fixes (read-only pass) |

| Probe not run | Why | Residue |
|---|---|---|
| Authenticated calls with the real `CRON_SECRET` (`POST /api/jobs/outbox`, `POST /api/jobs/screenshot`, `POST /api/jobs/reconcile`) | this worktree has no `.env`, the rule forbids creating one, and the secret is a production credential (never printed) | none — the calls would be writes (drain, preview capture) |
| `GET /api/jobs/config` / `reconcile` with a valid bearer | same | none |
| Stripe dashboard → Developers → Webhooks → the production endpoint's delivery attempts, response codes and error rates | provider dashboard I cannot reach; needs the operator's session | none |
| Stripe dashboard → Developers → Logs (API request log; confirms whether the live key is in test mode) | same | none |
| Vercel dashboard → project → Logs / Observability for a past 03:00 window; Settings → Plan | same | none |
| Vercel dashboard → Integrations / Log Drains (present or absent) | same | none |
| The uptime monitor itself: cron-job.org (or whatever holds the job list), its URL list, its notification recipients | the repo does not name the monitor; existence is therefore unknown (`U18-3`) | none |
| Resend dashboard → Emails / Events for a past receipt (delivery, bounce, complaint) | same | none |
| Neon console → Monitoring → a past 03:00 window (query load, connection count, PITR window) | same | none |
| A genuine 500 on the money path in production, to see what the log entry actually contains | would require breaking production | none |
| Plausible dashboard (pageviews, funnel) | production ships no Plausible script at all (§5.6) — there is nothing to read until the operator sets `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` and redeploys | none |

The plan's §2 asks the question this whole phase is organised around: *what would be visible if something broke at 03:00?* Batch 1 already settled that the readiness pass **diagnosed a live 502 from a log line** (`doc/PROD-READINESS-CHECKLIST.md:247,250`). This doc's job is to test whether that was a property of the *system* or of *one file* — and then to turn the same lens on the business side: which metrics exist, whether they tell the truth, and what the operator would actually look at on launch day.

The short answer, established below with citations: **the money path is the best-instrumented part of the product and the mail path is the worst; there is no error tracker, no uptime monitor the repo can prove exists, no alert routed to a human, and every operational table the code writes — `AuditLog`, `EmailLog`, `ProviderEvent`, `OutboxEvent` depth — has no reader in production code.**

---

## 1. Scope

### 1.1 What this phase owns

- **S12 L7** per `00-REVIEW-PLAN.md` §1: "Observability and alerts" — the row that asks whether a failure is *visible*.
- The cross-cutting clause attached to S12: it "must be read against every row". Concretely, for every failure mode the other phases registered, this doc states whether anything would have told the operator, and by which channel.
- The plan's §2 batch-4 brief for this doc: structured logging on the money path; error tracking present or absent; uptime monitoring; job-failure notification; outbox depth; webhook failure; alert thresholds and recipients; then business visibility — which metrics exist, whether `/api/stats` tells the truth, what the operator would look at on launch day, what analytics collect client-side with what consent.

### 1.2 What this phase does not own

| Adjacent subject | Owner | This doc's relation |
|---|---|---|
| Route contracts, status codes, response shapes | phase 11 | cites per-path behaviour; does not re-derive it |
| Cron schedules and the 04:00 pair | phase 13 | cites `vercel.json`; adds only the *observability* of those jobs |
| Which secrets exist and who holds them | phase 14 / `17` §5.8–5.9 | cites `17`'s inventory; adds secret-rotation *alarms*, not the list |
| Cost, cold starts, provider limits as resilience | phase 15 | cites; this doc adds the one provider limit that is an observability limit (log retention) |
| Whether the privacy policy correctly describes analytics | `16` §7 `R16-4`/`R16-5`; this doc supplies the ground truth in §5.6 | `16` owns legal sufficiency; here the question is only *what runs and with what consent* |
| Runbook text an operator must follow at 03:00 | `17` §3.7 | this doc names the *signal* each runbook needs; `17` names the *procedure* |
| Schema, PII fields, retention periods | phase 12 | cites field names only |

### 1.3 Paths inspected

`app/api/checkout/route.ts`, `app/api/webhooks/stripe/route.ts`, `lib/stripe.ts`, `lib/settle.ts`, `lib/outbox.ts`, `lib/audit.ts`, `lib/email.ts`, `lib/txn.ts`, `lib/rateStore.ts`, `lib/abuse.ts`, `lib/analytics.ts`, `lib/env.ts`, `app/api/stats/route.ts`, `app/api/jobs/config|outbox|reconcile|screenshot/route.ts`, `app/api/admin/**`, `app/error.tsx`, `app/global-error.tsx`, `app/layout.tsx`, `vercel.json`, `.github/workflows/ci.yml`, `.github/workflows/outbox-tick.yml`, `scripts/audit-prod.mjs`, `prisma/schema.prisma`, `prisma/launch-seed.ts`, `package.json`, `package-lock.json`, `doc/PROD-READINESS-CHECKLIST.md`, plus a full `console.*` census of the tracked tree (§5.1).

---

## 2. Actors and what "observable" means to each

| Actor | What observability means for them | Current state |
|---|---|---|
| Anonymous visitor | never sees an error page; if they do, it is honest and says what to do | `app/error.tsx` / `app/global-error.tsx` render `BoundaryNotice` with the `ROUTE_ERROR` copy and a `Try again` button (`app/error.tsx:20`, `app/global-error.tsx:16` log to the browser only) — batch 2 `02 §7` owns the copy |
| Paying customer | a stake that fails to appear must be noticed *before the customer notices*; a missing receipt must be resendable | stake settlement is logged (`lib/settle.ts:71`); the mail path is not (§3.2 rows 11–12) |
| Defending holder | being outbid is a promise the product makes twice (board + email); a silent mail failure breaks the promise invisibly | outbid mail failures leave `EmailLog{status:"error"}` with the subject in `detail` and no log line (`lib/email.ts:66,106`) |
| Losing bidder | ditto, plus the reclaim link | as above |
| **Operator** | a single place that says "the system is healthy", and an alarm that reaches a human | three authenticated JSON URLs and a GitHub Actions page; see §3.10 and `R18-9` |
| Attacker | abuse must be visible without the defense leaking the token/secret/IP | `lib/abuse.ts:14,33,40` logs the decision without the token, secret or IP — genuinely good hygiene |
| Crawler | no requirement | n/a |
| Email recipient | must be able to stop mail (unsubscribe) and to receive the mail at all | unsubscribe is batch 1 `R05-7`/`R04-*` territory; delivery visibility is §3.2 row 8 |
| Payment provider (Stripe) | needs our endpoint to answer 2xx when it should, and to *know* when we do not | 5xx is returned correctly on retryable failures (`app/api/webhooks/stripe/route.ts:190-193`) and the cause *is* logged one frame down (`lib/settle.ts:298`, `:419`), but the route adds nothing of its own and the line dies with the ~1 h retention; after that Stripe's dashboard is the only trail |
| Future maintainer | must be able to answer "what happened at 03:00 on the 14th?" | impossible: no error tracker, no durable request log, Hobby log retention ≈ 1 h (documentation reading, `U18-1`) |
| Regulator / auditor | "prove what you did with this payment" | `AuditLog` has no reader; a `psql` session is the only way to see it (`R18-5`) |

---

## 3. Intended behaviour

### 3.1 The logging contract, as it actually is

There is no logging library and no logging convention document. The census (§5.1) finds **71 `console.*` call sites across 24 files**; 23 of those are in shipped runtime code (`app/` + `lib/`, 15 files), the remaining 48 are in local tooling (`prisma/` seeds, `scripts/`) plus one test.

Two shapes coexist:

| Shape | Example | Sites |
|---|---|---|
| One-line JSON with a `scope` field | `console.log(JSON.stringify({ scope: "settle", msg, ...fields }))` — `lib/settle.ts:70-72`; `{scope:"txn",msg:"retryable-txn-error",attempt}` — `lib/txn.ts:48`; `{scope:"og",msg:"png-render-failed",error}` — `lib/ogCardImage.tsx:58` | 3 |
| Free-text with a bracketed prefix or none | `console.log("[stripe-webhook] verified signature")` — `app/api/webhooks/stripe/route.ts:45`; `console.error("[route error]", error)` — `app/error.tsx:20`; `console.warn("report notify failed", err)` — `app/api/report/route.ts:77` | 20 |

Properties that do **not** exist anywhere:

- no log level contract (the same class of event — a non-blocking failure — is `console.error` in `lib/audit.ts:54` and `lib/outbox.ts:188`, but `console.warn` in `lib/settle.ts:103`, `lib/settle.ts:286` and `app/api/report/route.ts:77`);
- no request id / trace id / correlation id threaded through a request (the only identifiers that appear are domain-specific ones: `paymentId`, `eventId`, `dedupeKey`);
- no `env`, `version`, or `region` field, so a line copied out of a log cannot be attributed to a deployment;
- no sink: everything goes to stdout and dies with the platform's log retention (`U18-1`);
- no `process.on("unhandledRejection" | "uncaughtException")` handler anywhere in the tree;
- no server-side `instrumentation.ts` hook.

### 3.2 Per-path diagnosability at 03:00 — the central comparison

The plan's premise is that the 502 was diagnosable *because the route logged*. Here is the same question asked of every comparable path.

| # | Path | What a 03:00 failure leaves behind | Diagnosable? | Evidence |
|---|---|---|---|---|
| 1 | Checkout → provider HTTP error (`createStripeCheckoutSession` gets non-2xx) | a `console.warn` naming the HTTP status, the *mode* of the configured key (`sk_live` / `sk_test` / `unexpected-format`) and up to 300 chars of the provider's own error body — but **not** the payment id | **yes** — this is the line that made the readiness-pass 502 diagnosable | `lib/stripe.ts:129-139`; the key **value** is never logged (`:133-138`) |
| 2 | Checkout → provider unreachable (network) | a `console.warn` with the thrown error's message; no payment id, no status | **partially** — enough to know a network/DNS/TLS failure happened, not which payment it was | `lib/stripe.ts:153-157` |
| 3 | Checkout → session returned without `url`/`id` | a `console.warn` naming which field was missing **and** the top-level key names the provider did return | **yes** | `lib/stripe.ts:144-151` |
| 4 | Checkout → the 502 itself is returned to the customer (`app/api/checkout/route.ts:102`, `:367`) | **nothing from the route**; the 502 appears only in the platform's request log (≈1 h on Hobby, `U18-1`) | **partially** — the cause is logged one frame down, the *customer-visible event* is not | `app/api/checkout/route.ts:102,367`; the only related log is upstream in `lib/stripe.ts` |
| 5 | Checkout → Stripe keys unset or half-set | `console.warn` "partial Stripe configuration" (`:113`); silent when both keys are simply absent, because then the dev provider is the intended mode | **yes** | `app/api/checkout/route.ts:112-114`; `lib/stripe.ts:30-34` |
| 6 | Webhook → **signature verification fails** | **nothing at all**. A 401 goes back to Stripe and no line is written | **no — this is the worst gap on the money path** | `app/api/webhooks/stripe/route.ts:40-42` (401 at `:41`, no log); `:45` logs only the success case, and the comment at `:43-44` states in as many words that a silent 401 here is "unobservable from our side" |
| 7 | Webhook → settle succeeds (paid or failed) | a structured `{scope:"settle"}` line plus a `ProviderEvent` row | **yes** | `lib/settle.ts:70-72,89` |
| 8 | Webhook → **retryable settle failure** (`catch` → 500) | one structured `settle-error-retryable` line carrying the payment id, the provider event id and the reason (`lib/settle.ts:298`; the reversal path `:419`), plus the `ProviderEvent` row; the route itself adds nothing | **partially** — that one line is the whole trail, it expires with the ~1 h retention, and there is no alarm and no durable reader | `app/api/webhooks/stripe/route.ts:190-193` (500 at `:192`); `lib/settle.ts:289-299,410-420` |
| 9 | Webhook → deterministic rejection (take-below-reserve, ledger-invariant, money mismatch, reference conflict) | one `settle-error-terminal` line (`lib/settle.ts:295`) plus a `ProviderEvent` row with `outcome:"ERROR"` and a `detail` string, returned as **200** so Stripe never redelivers it | **partially** — the line expires, and the durable half (the row) has no reader (`R18-2`) | `app/api/webhooks/stripe/route.ts:126-161,186-187`; `lib/settle.ts:291-296` |
| 10 | Outbox drain (per-row failure) | `console.error` with the row's identity and error, plus `attempts`/`nextAttemptAt` on the row itself | **yes** | `lib/outbox.ts:181-190` |
| 11 | **Mail send failure** (receipt, outbid, report, waitlist) | `deliver()` returns the string `"error"` after discarding the provider's response body; an `EmailLog` row is written with `status:"error"` and `detail:` = the **subject line** (for waitlist, subject + source). No `console` call exists anywhere in `lib/email.ts` | **no — the least observable money-adjacent path in the product** | `lib/email.ts:66,69` (reason discarded), `:106,138,164,178` (`detail` is the subject), no match for `console.` in that file (§5.1) |
| 12 | Mail suppressed (unsubscribe) | `EmailLog{status:"suppressed"}`, same silent file | **no** | `lib/email.ts:15-33` and its callers; batch 1 `R04-*` owns the suppression *behaviour* |
| 13 | Abuse: Turnstile missing token / rejected / unreachable | a `console.warn` naming the decision and never the token, secret or IP | **yes** | `lib/abuse.ts:14,33,40` |
| 14 | Rate-limit store missing or failing open | a `console.warn` once per instance (missing store) or `console.error` (store threw) | **partially** — once-per-instance gating means silence proves nothing | `lib/rateStore.ts:76,93` |
| 15 | Retryable transaction error (`lib/txn.ts`) | a structured line per attempt with the attempt number | **yes** | `lib/txn.ts:48` |
| 16 | Audit write failure | `console.error` with the error (non-blocking outside a txn) | **yes** | `lib/audit.ts:47-56` |
| 17 | **Database down** (Prisma cannot connect) | per-call retry lines from `lib/txn.ts:48`, then unknown 500s from every route; no single "the database is down" signal and no alarm | **no** | `lib/txn.ts:47-52`; no route or job reports DB reachability (`R18-6`) |
| 18 | **Process crash / OOM / bad deploy** | nothing but a failed request rate; no crash reporter, no `global-error` server handler | **no** | absence probe §5.2 |
| 19 | **Client-side crash** | `console.error("[global error]")` / `("[route error]")` in the *user's* browser console, which the operator never sees | **no** | `app/error.tsx:20`; `app/global-error.tsx:16` |
| 20 | Preview generation failure | structured `{scope:"og"}` line; the customer-visible fallback is the SVG | **yes** | `lib/ogCardImage.tsx:58` |
| 21 | Screenshot job failure per element | `{ok:false}` in the job response plus `failed` in the counter | **partially** — visible only if someone reads the job response | `app/api/jobs/screenshot/route.ts`; §5.3 |

**The pattern.** The money path's *provider-facing* operations are instrumented to an unusually good standard (status + mode + truncated provider body, secrets never printed). What is missing is uniform: **the event that tells you the system is broken at all** — a webhook that cannot verify, a database that is unreachable, a mail provider that is refusing everything, a process that died. Each of those leaves either no trace or a trace nobody reads.

### 3.3 Error tracking: absent, and provably so

- No error-tracking SDK in `package.json` dependencies (`@prisma/client`, `next`, `react`, `react-dom`, `swr` only).
- No Sentry/Rollbar/Datadog/Honeycomb/Bugsnag/Axiom/Highlight/Baselime reference anywhere in the tracked tree — the vendor-name grep returns one row and it is the word "highlighted" inside a test comment (§5.2).
- `@opentelemetry/api` appears **only** as a transitive, optional entry in `package-lock.json:5553,5560` — never imported.
- The only two error boundaries write to the user's browser console (`app/error.tsx:20`, `app/global-error.tsx:16`), so even a user-visible crash reaches nobody.
- Server errors surface only as platform log lines and status codes, with retention measured in hours (§5.8).

### 3.4 Uptime monitoring: a monitor that the repo cannot prove exists

What the repository *does* establish:

1. The readiness checklist treats an external pinger as part of the design: `app/api/jobs/reconcile/route.ts` deliberately exists as a POST-able URL and its own comment says it "belongs on the pinger's URL list"; `lib/reconcile.test.ts` and `lib/ops.test.ts` mention cron-job.org by name in comments.
2. `app/api/jobs/config/route.ts` is built so that **the HTTP status code alone** is the signal: 503 when any `required` finding exists, 200 otherwise, because "the free cron-job.org tier can only see status codes" (`lib/env.ts:128-144`; `lib/ops.test.ts:124-160` asserts the `ok`/status coupling deliberately).
3. Therefore the intended uptime story is: *something outside* polls `/api/jobs/config` (and ideally `reconcile`) every few minutes and alerts when the code is not 200.

What the repository does *not* establish:

- Nothing in the tree names the monitor, its URL list, its interval, or who receives its notifications. `.github/workflows/outbox-tick.yml` does not poll; it *calls the workers* every 10 minutes when GitHub feels like it (§5.3).
- No route or document states an SLO, a threshold, or a recipient.
- There is no `/api/health` or `/api/status` route: the API tree contains `activity, admin, board, checkout, dev, elements, emails, jobs, manage, report, search, startups, stats, table-order, unsubscribe, waitlist, webhooks` and nothing health-named (directory listing, §5.2).

The strongest *verifiable* statement is therefore: **the product's only designed uptime signal is a status code on an authenticated URL, and whether anything polls it is unknown (`U18-3`).** A green monitor cannot even be distinguished from no monitor in the repository.

### 3.5 Job-failure notification: one red GitHub Action, at a measured 6.7 % cadence

The only *verified-to-exist* automated check is the workflow at `.github/workflows/outbox-tick.yml` (§5.3 measured, §7 `R17-1` for the runbook side):

| Step | What it does | What a failure looks like |
|---|---|---|
| secret guard (`:31-36`) | fails fast if `CRON_SECRET` is absent | red step, message "CRON_SECRET not set" |
| backfill / drain / previews (`:37-58`) | calls `POST /api/jobs/outbox` with `{limit:25}` and `{limit:10}` | red step if the HTTP call itself fails or returns non-2xx |
| config check (`:78-87`) | calls `GET /api/jobs/config`; **non-2xx fails the job** | red step; this is the only place in the product where a `required` env finding is escalated automatically |
| reconcile check (`:88-97`) | calls `POST /api/jobs/reconcile`; a `divergent` count above zero fails the job | red step |
| delivery of that failure to a human | **undefined** — GitHub's default notification settings decide (email to watchers, or nothing) | unknown recipient set (`U18-4`) |

Two limits are structural, not incidental:

- **Coverage.** The config check is the *poller substitute*; between ticks nothing is checked. Measured cadence (§5.3): 46 runs over five days against a nominal 720 (10 per hour for 120 hours) — **6.4 %**. The workflow that would report a broken production also mostly does not run.
- **Semantics.** `advisory` findings never fail `ok` (`lib/env.ts:128-144`), deliberately: the live production report's single finding (Upstash unconfigured) is `degraded` and therefore green. This is correct design — and it is why the *only* finding the operator currently has is invisible to the alarm channel.

### 3.6 The writable-but-unread telemetry

Four operational tables receive high-quality data and have no reader in production code. This is the single largest observability asset in the product, sitting idle.

| Table | Written by | Read in production code | Evidence (whole-tree `git grep`, §5.2) |
|---|---|---|---|
| `AuditLog` | `lib/audit.ts:41` (9 action types: `STARTUP_CREATED`, `CHECKOUT_STARTED`, `MANAGE_LINK_REQUESTED`, `MANAGE_LINK_CONSUMED`, `PROFILE_UPDATED`, `WAITLIST_JOINED`, `REPORT_TRIAGED`, `PROFILE_MODERATED`, `PAYMENT_REVERSED`) | **nowhere** — only tests (`lib/manage.test.ts:67`, `lib/moderation.test.ts:212`, `lib/routes.test.ts:258`) and the demo-cleanup delete (`scripts/clear-demo-data.ts:185`) | 12 grep rows; filtering out the one write, the one delete and the tests leaves **zero** (§5.2) |
| `ProviderEvent` | `lib/settle.ts:89`, and the webhook's `ERROR`/`DUPLICATE`/`IGNORED` rows (`app/api/webhooks/stripe/route.ts:58,68,110,130,141,154,163`) | only **idempotency lookups** (`lib/settle.ts:116,321`) — never aggregated, never listed for an operator | grep: 22 rows total, of which the only production reads are those two lines (§5.2) |
| `EmailLog` | `lib/email.ts:23` (template, status `sent`/`logged`/`suppressed`/`error`, `detail`) | **nowhere** — `lib/settle.test.ts:271` and a demo-cleanup delete (`scripts/clear-demo-data.ts:200`) | 4 grep rows; filtering out the write, the delete and the test asserts leaves **zero** (§5.2) |
| `OutboxEvent` depth | `lib/outbox.ts:66,127-140`, `app/api/jobs/screenshot/route.ts:48,64` | **nowhere counts depth**: the only `findMany` outside tests is `scripts/clear-demo-data.ts:152`, and it filters by `type:"PREVIEW_GENERATE"` + demo `startupId` for deletion, not for metrics | grep for `outboxEvent.(count\|aggregate\|groupBy)` returns **exactly one row, and it is a test** (`lib/settle.test.ts:255`) |

Consequences: an `ERROR` provider event, a bounced receipt, a moderation action taken without a reason, or a queue growing 4 000 rows deep are all **invisible through the product's own surfaces**. They are visible only by opening `psql` — which is exactly the launch-day need (§3.7) and exactly what `17` found is undocumented.

### 3.7 Business metrics: `/api/stats` is the only one, and it was measured lying

`app/api/stats/route.ts` is the product's entire business-metrics surface (whole file read; §5.4 probe):

```json
{"elementsTotal":122,"claimedElements":0,"unclaimedElements":122,"stakeCount":0,"totalStakedUsd":0}
```

- `claimedElements` is computed with `FACE_STAKE_WHERE` (the board-truth predicate, per `R03-2` as cited in the file's own doc comment `:11-21`) — **honest by construction**.
- `stakeCount` and `totalStakedUsd` are "hidden-inclusive money aggregates" by the same comment (`:11-21`) — honest *as defined*, but not the numbers a launch-day question asks for.
- The response is cached module-level for 30 s (`:8-9`) — **in-process**, so N warm instances are N independent caches; a freshly deployed instance answers cold while its neighbour is warm. Batch 3's `12` owns the caching *behaviour*; the observability consequence is that two 30 s-apart reads can disagree without anything being wrong.

And on the same day at the same time, `/api/jobs/reconcile` — a different authenticated surface — reported **`paidTotal: 3`** with `divergent.count: 0` and `unverified.count: 0`. So the product simultaneously asserts "0 stakes, $0 staked" (`/api/stats`, the surface a launch-day watcher would use) and "3 paid". Both can be true: the money-truth predicate behind `stats` is the visible board (`FACE_STAKE_WHERE`), while `reconcile` counts `Payment.status = 'paid'` *whatever became of the stake* — reversed, refunded, disqualified, on a hidden listing. **The product has no single surface that answers "how many stakes did we actually get paid for?"** — see `R18-7`.

Two further structural gaps on the business side:

- **No surface exists for the operational questions.** `17` §5.9's access inventory shows the operator has four routes; none answers "is the queue draining", "are emails leaving", "are we reversing things", "is anyone abusing checkout". The queries that would answer them are one-liners (§3.8) — but they are not implemented, and the tables they read are written but unread (§3.6).
- **No analytics exist either**, so the *funnel* is not merely unowned but empty (§3.9).

### 3.8 The launch-day dashboard, defined in terms of queries that already exist

Requirement from the plan: define it using what exists. Two of the seven rows below do not exist today, and that gap is itself a finding (`R18-8`) — recorded honestly rather than dressed up.

| # | Question | Existing surface or query | Answers fully? |
|---|---|---|---|
| 1 | Is the deployment configured? | `GET /api/jobs/config` (bearer) → 200 + `findings[]`, or 503 | yes for `required`; blind to advisories *by design* and to key mode (`R18-4`) |
| 2 | Does the money agree with itself? | `GET /api/jobs/reconcile` → `paidTotal`, `divergent{count,samples}`, `unverified{count,byProvider,note}` | yes for the two classified classes; `unverified` is advisory |
| 3 | Is work moving? | `POST /api/jobs/outbox {limit:25}` → `{ok,claimed,completed,failed}`; `POST /api/jobs/screenshot {limit:10}` → `{ok,checked,updated,failed}` | `claimed:0` is ambiguous ("nothing due" vs "nobody has run me") |
| 4 | Did anything get paid, and what became of it? | `SELECT status, count(*), sum("amountUsd") FROM "Payment" GROUP BY status;` | query does not exist in code — must be run by hand |
| 5 | Is the queue deep, stale, or failing? | `SELECT count(*) FILTER (WHERE "completedAt" IS NULL) AS pending, count(*) FILTER (WHERE attempts > 0) AS retried, max(attempts) FROM "OutboxEvent";` | query does not exist; nothing writes it into any surface |
| 6 | Did the customer-facing mail actually leave? | `SELECT status, count(*), max("createdAt") FROM "EmailLog" GROUP BY status;` | query does not exist; the row's `detail` cannot tell you *why* a send failed (§3.2 row 11) |
| 7 | What has the operator done, and to whom? | `SELECT action, count(*) FROM "AuditLog" GROUP BY action ORDER BY 2 DESC;` | query does not exist |

Enum values are stored lowercase (`prisma/schema.prisma:5,39-43` — the schema's own comment explains why), so `status = 'paid'` and `outcome = 'error'` are the correct literals; batch 3's `12` owns that convention, cited not re-derived.

### 3.9 Analytics: seven funnel events, wired to a provider that is not installed

`lib/analytics.ts` defines exactly seven events — `tile_click`, `drawer_open`, `search_submit`, `checkout_start`, `checkout_paid`, `reclaim_click`, `go_click` — and a `track()` that:

- calls `window.plausible(...)` if and only if that global exists (`lib/analytics.ts:17-24`, the `typeof w.plausible === "function"` guard at `:22`);
- swallows every error in a `try/catch` (`:18,25-27`) and returns silently when the global is absent;
- is gated by the script tag in `app/layout.tsx:29-31`, rendered **only** when `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is set.

The live probe (§5.6) fetched `https://periodictable.lol/` (200, 152 029 B) and found **zero** occurrences of `plausible.io`, **zero** cookie/consent words, and no `Set-Cookie`. Therefore in production today **the seven events fire nowhere** and `track()` is a pure no-op.

That has three consequences worth stating precisely:

1. **Nothing is collected client-side today**, so there is no consent problem *in fact* — and, equally, no funnel data at all.
2. The moment the operator sets the variable, a US-based third-party analytics processor (Plausible — though the script tag is inserted only if the env var is present, the vendor is whoever serves that script) starts receiving pageviews and the seven event names **with no consent gate and no notice**. `16` §7 (`R16-4`, `R16-5`) owns the legal sufficiency of the privacy copy; this doc records the *technical* fact that no consent mechanism exists to build on (`R18-13`) and that the switch is a single env var.
3. The `checkout_paid` event is the only client-side signal about a completed purchase, and it fires from a page whose data comes from our own server; if it is ever enabled, it will be *the* funnel's money number — competing with `Payment` rows. Any dashboard must pick one definition; §3.8 row 4 is the honest one.

### 3.10 Alert thresholds and recipients: none are defined

A whole-tree reading finds **no** threshold, no alert rule, no notification webhook, no Slack/Discord/email hook, and no recipient list. The complete set of *possible* signals is:

| Signal | Reaches a human how? | Defined recipient? |
|---|---|---|
| `/api/jobs/config` returns 503 | only if something polls it; the GitHub Action does, at 6.4 % cadence | none named |
| `/api/jobs/reconcile` reports divergence | the GitHub Action fails the job (§3.5) | GitHub's default watcher set (`U18-4`) |
| `POST /api/jobs/outbox` / `screenshot` fail | same | same |
| A webhook 401/500 storm | Stripe's own dashboard shows the endpoint's error rate *if someone looks* | none |
| The site is down | nothing in the repo polls `/` | none (`U18-3`) |
| A customer cannot check out | nothing polls the checkout route | none |
| Mail stopped leaving | nothing reads `EmailLog` | none |
| The database is unreachable | nothing checks | none |

This is the doc's headline: **every one of those eight rows is an unowned, unalarmed failure.**

---

## 4. The path walked

### 4.1 It is 03:00 and Stripe shows 500s on our webhook endpoint

An operator waking at 03:00 (having been told by Stripe, or by a customer, or by nobody at all) has these tools. Their quality varies enormously.

*What they can find:*

- `ProviderEvent` rows for the failures — `outcome:"ERROR"`, a `detail` string like `reference-mismatch:cs_live_…` or `take-below-reserve:`, and the raw payload. **Excellent data** (`app/api/webhooks/stripe/route.ts:126-161`).
- A `{scope:"settle"}` line for any *successful* settle (`lib/settle.ts:71`) with the payment id and the amounts.
- The 500 responses themselves, visible in Stripe's dashboard as the endpoint's failed delivery attempts.
- `/api/jobs/reconcile` to ask whether the ledger diverged (`divergent.count`).

*What they cannot find:*

- **Why the requests are failing** if the failure is at verification: a 401 from a mismatched `STRIPE_WEBHOOK_SECRET` is silent here (`app/api/webhooks/stripe/route.ts:40-42`) *and* silent in the log retention window once an hour passes. The recipe a competent operator would follow — "check the logs for the signature failure" — has nothing to check. `17` §7 `R17-2` registers the missing "stale signing secret" runbook; this is the *evidence* half of that finding: the runbook would have nowhere to point.
- **Which deploy changed it**, because no log line carries a version or env field (§3.1).
- **Whether the DB was the cause** of a retryable 500: `lib/txn.ts:48` logs attempt-level retries, but nothing says "the database is unreachable".
- A durable record: the request log is ~1 h (`U18-1`), so an incident noticed on the morning after (the normal case — Stripe's own email about endpoint failures is not guaranteed and disabled endpoints are noticed late) is reconstructible only from `ProviderEvent` rows and Stripe's dashboard.

The diagnosis that *did* work in the readiness pass worked because the checkout route's failure happened to traverse `lib/stripe.ts`'s logging. The webhook path has no equivalent.

### 4.2 Launch day, 09:05: "how many stakes did we sell?"

The honest answer requires `psql`. The three candidate surfaces give three different answers:

| Question | Surface | Answer at the probe time |
|---|---|---|
| How many elements are claimed on the board? | `/api/stats` → `claimedElements` | `0` |
| How many stakes exist (hidden included)? | `/api/stats` → `stakeCount` | `0` |
| How many payments are paid, in total, whatever their stake became? | `/api/jobs/reconcile` → `paidTotal` | `3` |
| How many paid stakes are unverified because the provider stated no amount? | `reconcile` → `unverified.count`, `byProvider` | `0` |
| Is anything waiting to be processed? | **no surface** | unknown (`R18-8`) |
| Did every receipt leave? | **no surface** | unknown |

An operator launching this product would very plausibly open the site, read the board, and conclude zero sales — while three payments sit settled in the ledger. The reverse error is worse: a dashboard built on `stakeCount` would report money that has since been hidden, reversed or refunded (`16`'s refund-copy work and the reversal path in `app/api/webhooks/stripe/route.ts:81-100` are the mechanisms; `PAYMENT_REVERSED` is an audit action, `lib/audit.ts:17-26`).

### 4.3 14:00: "I never got my receipt"

The customer is right or wrong; the operator must decide which, and cannot.

- `EmailLog` has a row for the attempt: `template:"receipt"`, `status`, and a `detail` that is **a copy of the subject line** (`lib/email.ts:134-138`), not the provider's reason.
- If the send failed, `deliver()` returned `"error"` after discarding the response body (`:66`), and **no line was written to stdout** (no `console.` in the file, §5.1). So the log-retention window, however short, is not even the binding constraint: the reason was never captured anywhere.
- Resending means re-running a settle-adjacent code path by hand, which does not exist as a tool; `17`'s access inventory has no email console.
- Deciding whether the customer has a legal right to the document (a receipt for a payment) is `16`'s ground; the *inability to answer the factual half of the question* is registered here as `R18-3`.

### 4.4 The cron stopped — and how would anyone know?

Simulate the failure: GitHub Actions silently stops scheduling `outbox-tick.yml` (a documented behaviour for workflows in inactive repositories, and the observed 6.4 % cadence shows the scheduler is already unreliable), or `CRON_SECRET` is rotated without updating the GitHub secret.

| Failure | Observable effect | Who notices, how |
|---|---|---|
| Ticks stop | nothing changes on the site; the outbox accumulates `completedAt IS NULL` rows | **nobody** — no depth metric, no alarm; "OutboxEvent depth" is on the plan's list precisely because nothing reads it |
| The 04:00 Vercel cron stops (it is in `vercel.json:3-6`, so Vercel shows its runs) | same as above, plus intake mail and outbid mail stop *leaving* | a customer waiting for an outbid email complains; no system signal |
| `CRON_SECRET` rotated in Vercel but not in GitHub | every tick step fails the job at the `curl` (`:47-52`) → **red Action** | whoever GitHub notifies (`U18-4`); this is the one case the existing design catches |
| `ADMIN_TOKEN` rotated/absent | admin routes 403 (`17` §5.1 measured) | the operator notices only when they try to moderate something |

So: the *most likely* operational failure in this product (the queue silently deepens) is the one with **no signal at all** — it is `R18-8` and it is the first row of §7's ordered gap list.

### 4.5 Retrace: what a silent failure costs the launch

For each silent class, the cost is not abstract:

- a webhook 401 storm → Stripe disables the endpoint after enough consecutive failures → **stakes stop settling** → everyone who paid sees a `pending` checkout while the money left their card (the worst customer-facing state the product can be in);
- a mail outage → receipts never arrive → the operator must reconstruct proofs of purchase from `Payment` rows by hand, per customer, with no template runner;
- a queue that stops draining → previews missing (cosmetic) *and* intake mail undelivered (promise-breaking, since batch 1 settled that intake mail is a shipped promise, `05` §7 `R05-7`);
- a database outage → all of the above simultaneously, with the operator unable to distinguish "the database is gone" from "one route is broken" from the log window.

---

## 5. Live evidence

All probes on 2026-09-15, from this worktree, read-only. No secret was printed; no request with credentials was made.

### 5.1 The `console.*` census (whole tracked tree)

Command and output (abridged to counts; full line list retained in session):

```
$ git --no-pager grep -n -E 'console\.' -- app lib components prisma scripts e2e
=> 71 matches across 24 files

$ git --no-pager grep -n -E 'console\.' -- app lib ':!*.test.*'
=> 23 matches across 15 files:
   app/api/checkout/route.ts, app/api/report/route.ts, app/api/waitlist/route.ts,
   app/api/webhooks/stripe/route.ts, app/error.tsx, app/global-error.tsx,
   lib/abuse.ts, lib/audit.ts, lib/manage.ts, lib/ogCardImage.tsx, lib/outbox.ts,
   lib/rateStore.ts, lib/settle.ts, lib/stripe.ts, lib/txn.ts
```

- **Method note.** The census was re-run with `git grep` after a first pass built on PowerShell `Select-String -Path app\**\*.ts …` missed `app/api/checkout/route.ts:113` — `-Path` globs do not recurse reliably on this host. Every figure in this doc is from the `git grep` runs; §11 records the correction.
- **`lib/email.ts` does not appear.** The mail path contains no log statement at all — the finding of §3.2 row 11 rests on this absence *plus* `lib/email.ts:66,69` discarding the reason.
- Two of the 23 runtime sites are `console.error` in **client** components (`app/error.tsx:20`, `app/global-error.tsx:16`) — they write to the user's browser.
- One site is `lib/manage.ts:67`, warning on every manage-link request that the link is not sent because the feature is not shipped (v1 dormancy is settled by `doc/PROD-READINESS-CHECKLIST.md:181`; `17` §7 `R17-7` owns the client gap).

### 5.2 Absence probes

```
$ git --no-pager grep -n -E 'sentry|rollbar|datadog|honeycomb|bugsnag|axiom|highlight|baselime|otel|opentelemetry' -- package.json app lib components
=> 1 match, and it is a false positive:
   lib/searchCombobox.test.ts:9  ("the highlighted one" — a comment about browser QA)
   => no error-tracking or telemetry vendor is named by any manifest or source file

$ git --no-pager grep -n 'opentelemetry' -- .
=> package-lock.json:5553,5560 only (transitive, optional; never imported)

$ git --no-pager grep -c -E 'auditLog\.' -- app lib components prisma scripts
=> 12 matches in 8 files: lib/audit.ts:41 (the only write), scripts/clear-demo-data.ts:185 (a delete),
   and 10 rows across lib/{ledger,manage,moderation,routes,settle,webhook}.test.ts
   => filtered to non-write, non-delete, non-test: zero rows

$ git --no-pager grep -c -E 'emailLog\.' -- app lib components prisma scripts
=> 4 matches: lib/email.ts:23 (the write), lib/settle.test.ts:271,272 (asserts),
   scripts/clear-demo-data.ts:200 (a delete)
   => filtered: zero rows

$ git --no-pager grep -n -E 'providerEvent\.' -- app lib components prisma scripts
=> 22 matches. Production code: app/api/webhooks/stripe/route.ts ×7 (writes),
   lib/settle.ts ×3 (:89 write, :116 and :321 idempotency reads),
   scripts/clear-demo-data.ts:172 (a delete). Tests: ledger ×2, moderation ×1,
   routes ×1, settle ×3, webhook ×4.
   => the only reads in production code are lib/settle.ts:116 and :321

$ git --no-pager grep -n -E 'outboxEvent\.(count|aggregate|groupBy)' -- app lib components prisma scripts
=> 1 match, and it is a test: lib/settle.test.ts:255
   => zero rows in production code

$ Get-ChildItem -Recurse -Directory app\api
=> activity admin board checkout dev elements emails jobs manage report search
   startups stats table-order unsubscribe waitlist webhooks    (no health/status route)
```

`providerEvent` census detail (the complete production set): `lib/settle.ts:89` (write), `:116` and `:321` (idempotency reads), `app/api/webhooks/stripe/route.ts:58,68,110,130,141,154,163` (writes in **seven** branches — two `IGNORED` before the payment is known, one `IGNORED` for an unrelated event, three `ERROR`, one `DUPLICATE`), `scripts/clear-demo-data.ts:172` (demo delete). No aggregation, no list-for-operator.

### 5.3 What the alerting channel actually did (measured, not asserted)

Measured from the GitHub API (46 runs of `outbox-tick.yml`):

- window: **2026-09-10T10:45:29Z → 2026-09-15T04:46:34Z**, **46 runs**;
- nominal for a `*/10` schedule over 5 days: **720**; delivered: **6.4 %**;
- inter-run gaps: min **1.1 min**, median **141 min**, max **400 min**.

Representative run `34930125741` (started 04:46:42Z), four consecutive steps, verbatim bodies:

```json
{"ok":true,"claimed":0,"completed":0,"failed":0}
{"ok":true,"checked":0,"updated":0,"failed":0}
{"ok":true,"env":"production","findings":[{"key":"UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN","severity":"degraded","detail":"Upstash is unconfigured: rate limits fall back to per-instance memory and fail open (lib/rateStore.ts)"}]}
{"ok":true,"paidTotal":3,"divergent":{"count":0,"samples":[]},"unverified":{"count":0,"byProvider":[],"samples":[],"note":"Paid on our own checkout figure alone: the provider's delivery stated no amount, so nothing could be cross-checked."}}
```

Readings:

1. The channel works and its payloads are good — a red Action carries the *reason*.
2. The cadence is the alarm's real reliability: a failure introduced between ticks is reported up to ~6.7 h later (max gap), and the median gap means "every ~2.4 h".
3. `claimed:0` cannot distinguish "the queue is empty" from "this drain has nothing to do" — both are green and both look identical in the log. There is no row that says the queue is *deep* (§3.6).
4. The config finding is `degraded`, so the workflow is green — correct, and the reason the operator's only known production issue is not escalated anywhere.

### 5.4 `/api/stats` versus `/api/jobs/reconcile`, same day, same system

```
2026-09-15T07:37:58Z  GET https://periodictable.lol/api/stats
200 99 B  X-Vercel-Cache: MISS
{"elementsTotal":122,"claimedElements":0,"unclaimedElements":122,"stakeCount":0,"totalStakedUsd":0}

2026-09-15T04:46:45Z  POST /api/jobs/reconcile (via the scheduled workflow)
{"ok":true,"paidTotal":3,"divergent":{"count":0,...},"unverified":{"count":0,...}}
```

Analysis in §3.7. The observability finding is not that either number is wrong — both are honest under their own definitions — but that **no surface reconciles them for a human**, and a launch-day watcher reading the public surface would conclude the opposite of the ledger.

### 5.5 The alert surface's own contract (probe output)

```
2026-09-15T07:33:22Z  GET /api/jobs/config        401  24 B  {"error":"unauthorized"}
2026-09-15T07:33:23Z  GET /api/jobs/reconcile     401  24 B  {"error":"unauthorized"}
2026-09-15T07:33:24Z  GET /api/admin/reports      403  21 B  {"error":"forbidden"}
```

Both are correct (auth before health is deliberate, `lib/env.ts:128-144`'s design note; `17` §5.1 measured the same). The observability consequence: **an unauthenticated poller learns nothing**, and the status code for a *misconfigured* secret is indistinguishable from the status code for an *unreachable* deployment to anyone reading only "is it 200". The 503-on-required-finding design (config) and the 401-on-bad-secret design are individually right and jointly ambiguous; a monitor must be configured with a valid secret *and* must treat 401 as distinct from 503 (§8).

### 5.6 Analytics at the edge

```
2026-09-15T07:14:57Z  GET https://periodictable.lol/   200  152,029 B
occurrences of "plausible.io":            0
occurrences of "cookie" / "consent":      0
Set-Cookie headers:                       0
X-Vercel-Cache: HIT (Age: 649)
```

Therefore `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is unset in the production environment as served, `app/layout.tsx:29-31` renders no script, and all seven `track()` calls in `lib/analytics.ts` are silent no-ops. This is the ground truth `16` §7 (`R16-4`, `R16-5`) needs and does not change the fact that, once set, no consent gate exists to hook into (`R18-13`).

### 5.7 Test-suite baseline (relevant only as the "can we verify a fix" backdrop)

```
$ npx vitest run     2026-09-15, this worktree
Test Files  13 failed | 27 passed (40)
Tests        6 failed | 426 passed (432)
Skipped      0
Duration     65.31 s
```

The 6 failures are the pre-existing CRLF artifact the run instructions name (`lib/legalMeta.test.ts` ×5, `lib/claimFace.test.ts` ×1) and are out of scope. Noted here rather than in `FINDINGS.md` because it is environmental, not a product defect. Note the observed numbers differ from the brief's expectation (~470 passed / 71 skipped): this checkout ran 432 tests with **0** skipped.

### 5.8 Provider-documentation reading: log retention (not a console reading)

Read on 2026-09-15 from Vercel's documentation and public answers: log **drains** are a Pro-and-above feature, and Hobby runtime logs are visible in the dashboard for a short rolling window (commonly reported as about one hour). This is *documentation*, not a reading of `periodictable.lol`'s plan or dashboard, so it is registered as `U18-1` with the exact dashboard step that settles it. It matters because every "check the logs" instruction in every runbook that might be written inherits this limit.

---

## 6. Failure and edge matrix

Every row: does a failure here reach a human? "Owner" is the person who would act; the credential inventory in `17` §5.9 shows every credential has exactly one undocumented holder, so no row has a *named* owner today.

| # | Failure | Detected by | Owner | Alarm | Registered as |
|---|---|---|---|---|---|
| E1 | Database unreachable / Prisma down | per-attempt `txn` warns only | none | none | `R18-6` |
| E2 | Webhook signature failures (stale secret) | **nothing** | none | none | `R18-2` |
| E3 | Webhook retryable settle failures (500s) | one `settle-error-retryable` line (`lib/settle.ts:298`) that expires with the log window, plus the `ProviderEvent` row; Stripe's dashboard if read | none | none | `R18-2` |
| E4 | Mail provider refusing sends | **nothing** (`EmailLog` unread, reason discarded) | none | none | `R18-3` |
| E5 | Queue stops draining (cron dead) | **nothing** | none | none | `R18-8` |
| E6 | Queue deep / rows stuck retrying | **nothing** | none | none | `R18-8` |
| E7 | Site down / 5xx on all routes | **nothing in the repo** | none | none | `R18-9`, `U18-3` |
| E8 | Checkout broken for customers (502s) | **nothing**; cause logged per-occurrence in `lib/stripe.ts` | none | none | `R18-9` |
| E9 | Server crash / OOM / bad deploy | request-rate drop only | none | none | `R18-1` |
| E10 | Client-side crash (React boundary) | user's own console | none | none | `R18-1` |
| E11 | Env drift (a required var unset) | GitHub Action config step — **if** a tick runs | GitHub watchers | red Action at 6.4 % cadence | `R18-4`, `R18-9` |
| E12 | Upstash missing (rate limits per-instance) | `/api/jobs/config` advisory only | none | never (advisory never fails `ok`) | `17` (cites checklist §5) |
| E13 | Ledger divergence | reconcile `divergent.count > 0` | none | red Action, if a tick runs | `R18-4` |
| E14 | Money mismatch / reference conflict / take-below-reserve | `ProviderEvent` `ERROR` row | none | none | `R18-2` |
| E15 | Someone moderates/hides content | `AuditLog` row | n/a | none | `R18-5` |
| E16 | Refund or chargeback arrives | webhook + `PAYMENT_REVERSED` audit + `EmailLog` | none | none | `R18-5`, `R18-3` |

**Each row above is a failure with no owner and no alarm, as the plan requires registering — `R18-9` states the class; the specific rows carry their own findings.**

---

## 7. Findings

Registered in `FINDINGS.md` as `R18-1`…`R18-15`. Severity per `00-REVIEW-PLAN.md` §4 (P0 blocks announce; P1 must fix before announce; P2 first week; P3 backlog). All are `open`; this pass changes no code.

**R18-1 — No error tracking: a 03:00 crash leaves nothing durable to read.** P1 · `ops`
**Evidence.** No error-tracking SDK in `package.json`; whole-tree grep for `sentry|rollbar|datadog|honeycomb|bugsnag|axiom|highlight|baselime|otel|opentelemetry` returns exactly **one** match, a false positive in a test comment (`lib/searchCombobox.test.ts:9`, the word "highlighted"), and the `opentelemetry`-only grep returns `package-lock.json:5553,5560` (transitive, unimported). §5.1 census: the only two "global" handlers are client-side (`app/error.tsx:20`, `app/global-error.tsx:16`). §5.8: log retention ≈1 h on the plan level, `U18-1` settles the actual plan.
**Reproduction.** Deploy a build with a top-level import error, or kill the process; observe that nothing except platform logs records it.
**Proposed fix.** Add a minimal error sink (a provider SDK or a `/api/internal/error` route writing to a table) wired into both boundaries and a server-side `instrumentation.ts`; document the retention the sink provides. Operator decision `D17` covers the vendor.
**Status.** open.

**R18-2 — Webhook verification failures and terminal provider events are invisible.** P1 · `money`,`ops`
**Evidence.** `app/api/webhooks/stripe/route.ts:40-42` returns 401 on a bad signature with no log (the file's only console call is `:45`, the success case, whose comment at `:43-44` says a silent 401 is "unobservable from our side"); `:190-193` returns 500 on a retryable settle failure, where the only trace is one `settle-error-retryable` line one frame down in `lib/settle.ts:298`; `:126-169` write `ERROR`/`DUPLICATE`/`IGNORED` rows and return 200 with the silent `IGNORED` cases at `:57-64,67-75,109-116`. No production reader for `ProviderEvent` (§5.2).
**Reproduction.** Send a webhook with a wrong signature to a dev server and watch the console: nothing appears for the 401.
**Proposed fix.** Log a one-line structured event on signature failure (no payload, no secret) and on every terminal rejection; add a `/api/jobs/provider-events?since=`-style read (or a documented SQL) so the row class is not write-only.
**Status.** open.

**R18-3 — Mail failures are unlogged and undiagnosable; `EmailLog.detail` is the subject line.** P1 · `money`,`ops`
**Evidence.** No `console.` in `lib/email.ts` (§5.1). `deliver()` discards the provider's response: `if (!res.ok) return "error"` (`:66`), `catch { return "error" }` (`:69`). All four senders store `detail: subject` (`:106,138,164,178`). No production reader for `EmailLog` (§5.2). `17` §7 `R17-13` owns the operator-side runbook.
**Reproduction.** Point `RESEND_API_KEY` at an invalid key in a dev environment; the only evidence is an `EmailLog` row whose `detail` names the subject.
**Proposed fix.** Capture the provider's status and error body into `EmailLog.detail` (truncated) and log one structured line per failed send; add the "mail health" query from §3.8 row 6.
**Status.** open.

**R18-4 — No surface distinguishes live vs test mode, and the config report cannot see advisories.** P1 · `money`,`ops`
**Evidence.** `stripeEnabled()`/`getProviderMode()`/`stripePartiallyConfigured()` (`lib/stripe.ts:18,28,33`) — the mode the checkout route returns to the client (`app/api/checkout/route.ts:372`) is never reported to the operator; `/api/jobs/config`'s payload carries `env` and `findings[]` only (`app/api/jobs/config/route.ts:7-40`); `PROD_ENV_VALIDATORS` (`lib/env.ts:84-87`) validates only `NEXT_PUBLIC_APP_URL` and `CLICK_SALT`, so a `sk_test_` key in production passes every check. Advisories never fail `ok` by design (`lib/env.ts:128-144`), verified live (§5.3: one `degraded` finding, `ok:true`).
**Reproduction.** Set `STRIPE_SECRET_KEY=sk_test_…` in a preview environment; `/api/jobs/config` stays 200 with a green `ok`.
**Proposed fix.** Add `providerMode` and a `stripeKeyMode` (`test`/`live`) field to the config report, and a `required` finding when a production deployment's key is in test mode.
**Status.** open.

**R18-5 — The audit trail and refund/reversal history have no reader, and there is no operational history view.** P1 · `ops`,`legal`
**Evidence.** `lib/audit.ts:17-26` (nine actions) writes rows; grep finds **zero** production readers (§5.2). `PAYMENT_REVERSED`, `PROFILE_MODERATED`, `REPORT_TRIAGED` therefore have no operator-visible record. No admin route lists them (`17` §3.1's four routes).
**Reproduction.** Reverse a payment in dev; the audit row exists and no surface shows it.
**Proposed fix.** Add an admin read (or a documented SQL block in the runbooks) for `AuditLog` filtered by startup/payment; include it in the §3.8 dashboard.
**Status.** open.

**R18-6 — A database outage is indistinguishable from a broken route.** P1 · `ops`
**Evidence.** `lib/txn.ts:47-52` logs per-attempt retryable errors; no route, job, or health surface reports database reachability; there is no `/api/health` (§5.2); `/api/stats` would 500 with an unknown error shape.
**Reproduction.** Stop Postgres in a dev environment and call `/api/stats`; observe a generic failure with no distinguishing signal.
**Proposed fix.** Add a `/api/health` that does exactly one `SELECT 1` with a short timeout, returns a distinguishable status, and is added to the monitor's URL list; document the PITR/restore path (`17` §7 `R17-12` owns the runbook).
**Status.** open.

**R18-7 — No surface answers "how many stakes were actually paid for?" — `/api/stats` and `reconcile` give opposite-looking numbers.** P1 · `ops`,`money`
**Evidence.** Live probes (§5.4): `/api/stats` → `stakeCount:0,totalStakedUsd:0`; `/api/jobs/reconcile` → `paidTotal:3`. Definitions differ by construction (`app/api/stats/route.ts:11-21` uses `FACE_STAKE_WHERE` for `claimedElements` and hidden-inclusive aggregates for the money fields; reconcile counts `paid` payments).
**Reproduction.** Compare both surfaces at any time the board is empty but payments are paid.
**Proposed fix.** Define the launch-day money metric once (paid payments, net of reversals), expose it as a field on an authenticated surface, and label `/api/stats`'s two money fields as board-scoped.
**Status.** open.

**R18-8 — Outbox depth and ageing are unreadable anywhere.** P1 · `ops`
**Evidence.** No `outboxEvent.count|aggregate|groupBy` in production code (§5.2); the only non-test `findMany` is a demo cleanup (`scripts/clear-demo-data.ts:152-160`); the workers return only `{claimed,completed,failed}` for the rows they happened to touch (`app/api/jobs/outbox/route.ts`, §5.3). `claimed:0` is ambiguous between "empty" and "nothing due".
**Reproduction.** Enqueue several failing rows in dev; nothing in any surface shows the backlog.
**Proposed fix.** Add aggregate fields (`pending`, `due`, `failed`, `oldestDueAgeMs`) to the drain response and a read on an authenticated surface; alarm when `pending` grows across consecutive ticks.
**Status.** open.

**R18-9 — Every class in §6 has no owner and no alarm; the only automated escalation is a red GitHub Action at 6.4 % cadence.** P1 · `ops`
**Evidence.** §5.3 measurement (46 runs vs 720 nominal); §3.10 (no threshold, rule, or recipient anywhere in the tree); `.github/workflows/outbox-tick.yml:31-97` is the only automated outer loop; the config step explicitly exists because the free pinger tier can only read status codes.
**Reproduction.** Disable the workflow; production continues and nothing reports it.
**Proposed fix.** Operator decision `D18` (which monitor/alert channel), then: poll `/api/health`, `/api/jobs/config` and `/api/jobs/reconcile`; alert on 503/divergence; alert on the absence of a successful tick within N minutes; name a recipient.
**Status.** open.

**R18-10 — Client crashes are reported to the user's browser only.** P2 · `ops`,`ux`
**Evidence.** `app/error.tsx:20`, `app/global-error.tsx:16` — `console.error` in client components; no server collector.
**Reproduction.** Force a throw in a client component; the boundary renders and nothing is transmitted anywhere.
**Proposed fix.** Route the same caught error to the `R18-1` sink with the route and a build id.
**Status.** open.

**R18-11 — No request correlation, deployment version or env on any log line.** P2 · `ops`
**Evidence.** §3.1: the three structured shapes carry `scope`/`msg` plus domain fields only; no request id, version, or env anywhere in the 23 runtime sites.
**Reproduction.** Search a log window for a `paymentId` and try to attribute the lines to a deployment: impossible.
**Proposed fix.** Add a per-request id (header or generated) and a build-id/env field to the structured shapes; adopt one rule for the level of non-blocking failures.
**Status.** open.

**R18-12 — The alert surface's status code is ambiguous: 401 (bad secret) vs 503 (config finding) vs 200 (healthy) can all be seen by a monitor as "not 200".** P2 · `ops`
**Evidence.** §5.5 probe output; `lib/env.ts:128-144`'s deliberate auth-before-health ordering; `lib/ops.test.ts:124-160` asserts the coupling.
**Reproduction.** Poll with a wrong bearer and with a valid bearer that has a `required` finding; both are non-2xx.
**Proposed fix.** Document the exact expected status per monitor (and the intended one-token-per-purpose separation), or add a monitor-friendly unauthenticated liveness route (`R18-6`).
**Status.** open.

**R18-13 — Analytics have no consent gate, and the switch that turns them on is one env var.** P2 · `privacy`,`legal`
**Evidence.** §5.6 (no script, no cookie, no consent today); `app/layout.tsx:29-31` (script rendered only on the env var); `lib/analytics.ts:17-28` (silent no-op without the global); `16` §7 `R16-4`/`R16-5` own the policy's accuracy about processors.
**Reproduction.** Set `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` in a preview deployment and load the page: pageviews and seven event names leave the browser with no notice or choice.
**Proposed fix.** Decide `D19` (analytics on/off, cookieless vendor, consent copy) and, if on, ship a notice plus the legal-page update in the same change.
**Status.** open.

**R18-14 — Nothing measures the customer-facing outcome: successful checkout rate, settled-stake rate, or the funnel's drop-off.** P2 · `ops`
**Evidence.** §3.7/§3.9: `stats` counts board state; `reconcile` counts payments; no surface computes `paid → settled` or `click → checkout_start → paid`; the seven Plausible events are inert (§5.6).
**Reproduction.** Ask "what fraction of started checkouts completed yesterday?" — answerable only by hand-written SQL across `Payment` and (absent) view data.
**Proposed fix.** Define the two conversions in the §3.8 dashboard and implement the queries; if Plausible is enabled, document which number is authoritative (`R18-7`).
**Status.** open.

**R18-15 — Log retention (~1 h at the plan level) makes "check the logs" a valid instruction only within the same hour; no instruction anywhere states this.** P3 · `ops`
**Evidence.** §5.8 documentation reading; the plan-level limit is `U18-1`.
**Reproduction.** Ask an operator to reconstruct yesterday's incident from logs.
**Proposed fix.** Either enable log drains (cost decision, `D20`) or write down, in every runbook that says "read the logs", that the window is ~1 h and that the DB tables in §3.6 are the durable substitute.
**Status.** open.

---

## 8. Acceptance criteria

- [ ] An error-tracking sink exists and receives server-boundary, client-boundary and API-route errors, with the deployment id attached; a synthetic error is visible in the sink within one minute of deployment (`R18-1`, `R18-10`).
- [ ] A webhook request with an invalid signature produces exactly one log line (no payload, no secret) and one `ProviderEvent` row, and a test asserts both (`R18-2`).
- [ ] A failed mail send records the provider's status and a truncated reason in `EmailLog.detail` and logs one structured line; a test covers a non-2xx response and a timeout (`R18-3`).
- [ ] `/api/jobs/config` reports the payment provider's key mode, and a `required` finding is emitted when a production deployment runs against a test key; a test asserts the finding (`R18-4`).
- [ ] `/api/jobs/config`'s 200/503 contract is documented for the monitor verbatim, including that 401 and 503 mean different things (`R18-12`).
- [ ] An authenticated surface reports outbox `pending`, `due`, `failed` and oldest-due age; a test asserts the aggregate against a known queue state (`R18-8`).
- [ ] An authenticated `/api/health` (or documented liveness URL) returns a distinguishable status when the database is unreachable, and it is on the monitor's URL list (`R18-6`, `R18-9`).
- [ ] The launch-day dashboard's seven rows from §3.8 each resolve to a documented command or surface, and the two "query does not exist" rows are implemented (`R18-7`, `R18-14`).
- [ ] The money question has one authoritative definition ("paid payments net of reversals"), stated in the dashboard, and `/api/stats`'s money fields are labelled as board-scoped (`R18-7`).
- [ ] `AuditLog` has a production reader or a documented query in the runbooks, covering at least `PAYMENT_REVERSED`, `PROFILE_MODERATED` and `REPORT_TRIAGED` (`R18-5`).
- [ ] A documented alert policy exists naming, for each of: site down, checkout 5xx, webhook failure, divergence, queue depth, mail failure — the threshold, the channel and the recipient (`R18-9`, operator decision `D18`).
- [ ] The stale-tick condition (no successful tick for N minutes) is itself alarmed, not merely inferable (`R18-9`).
- [ ] Structured log lines carry a request/deployment identifier, and one documented rule defines which failures log at which level (`R18-11`).
- [ ] Analytics are either disabled with the legal pages stating that nothing is collected, or enabled with a notice and a consent decision recorded (`R18-13`, `16` §7, operator decision `D19`).
- [ ] Every runbook that instructs the operator to "check the logs" states the retention window and the durable substitute (`R18-15`, coordinated with `17`).

---

## 9. Operator decisions

Only the operator can make these; the code cannot decide them. Numbering continues from `16` (`D1`–`D9`) and `17` (`D10`–`D16`).

| # | Decision | Why it is the operator's | Where it lands |
|---|---|---|---|
| D17 | Error-tracking vendor and plan (or accept platform logs only, and accept the consequences of ~1 h retention) | spend, vendor and data-processing terms | `R18-1`, `R18-15`; privacy policy (`16 §7`) |
| D18 | The alert channel and its recipient list (email alias, phone, Slack, status page) and the thresholds | personal availability and what "wake me up" means | `R18-9`; `17` §7 `R17-1`–`R17-15` all name a signal |
| D19 | Whether analytics run at all, and if so the vendor, the consent posture, and the notice | legal basis, jurisdiction, and the funnel's value | `R18-13`; `16` §7 `R16-4`/`R16-5` |
| D20 | Whether to buy log drains / a longer-retention tier | cost against incident-reconstruction value | `R18-15` |
| D21 | Whether to run an uptime monitor at all, and if so its interval, its URL list and its escalation path | the repo cannot prove one exists (`U18-3`) | `R18-9` |
| D22 | Who is on call, and what "on call" means for a solo launch (accept delay, or page a phone) | availability | `R18-9`; `17` `D10` |
| D23 | Whether the launch-day dashboard is a manual SQL checklist or an operator-only page, and who may run it | build effort vs operational risk; DB credential custody (`17` §5.9) | `R18-7`, `R18-8`, `R18-14` |
| D24 | Whether a customer-facing status/communication page exists for site-down events | brand and legal exposure | `17` §7 `R17-15`; `R18-9` |

---

## 10. Cross-references

- `00-REVIEW-PLAN.md` §1 (S12 cross-cutting), §2 batch 4, §4 severity semantics.
- `TEMPLATE.md` — section order.
- `01`–`05` (batch 1): `05` §7 `R05-6` (refunds copy — cited, not re-reported), `R05-7` (intake mail promise: `17` owns the operator side, this doc owns its invisibility, `R18-3`), `05` §7 `R05-2`–`R05-4` (skip link/landmarks/focus rings — cited only).
- `doc/PROD-READINESS-CHECKLIST.md`: `:181` manage-link dormancy (cited by section, `17` `R17-7` owns the client gap), `:195` Upstash (cited; not re-reported), `:247,250` the 502 diagnosis chain (the premise of this phase), `§4b/§4c` cadence and job-auth asymmetry (cited), `:156,198` alerting channel (cited).
- `17-operator-tooling-and-runbooks.md`: §5.1 (the same auth probes), §5.8/5.9 (secret and access inventories — this doc adds alarms, not lists), §7 `R17-1`–`R17-16` (each needed signal is named here).
- `16-legal-privacy-tax.md`: §7 `R16-4`/`R16-5` (undisclosed processors/analytics — this doc supplies the ground truth in §5.6 and the technical consent gap in `R18-13`).
- `doc/review/FINDINGS.md`: `R18-1`…`R18-15`, `U18-1`…`U18-8`.

---

## 11. Change log

| Date | Change | By |
|---|---|---|
| 2026-09-15 | authored 2026-09-15 against `9681bdcbff2435ef258224c52000e0f8d6089f5c` — first draft of phase 18; findings registered, no fixes (read-only pass) | batch-4 agent |
| 2026-09-15 | corrected the `console.*` census from an earlier partial glob to a whole-tree `git grep` count (71 matches / 24 files; 23 runtime sites in 15 files) after the partial pattern was found to miss `app/api/checkout/route.ts:113`; §5.1 now shows the commands and outputs | batch-4 agent |
| 2026-09-15 | recorded the audit/email/provider/outbox **reader** censuses as explicit zero-row probes (§5.2) rather than assertions | batch-4 agent |
| 2026-09-15 | citation-verification pass: every `file:line` in §3.2, §3.6, §4, §6 and §7 re-read against the tree; corrected `lib/stripe.ts`, `lib/env.ts`, `lib/settle.ts`, `lib/analytics.ts` and webhook-route ranges that had drifted, downgraded §3.2 row 2 to "partially", and replaced two "no log line" assertions with the `settle-error-terminal`/`settle-error-retryable` lines that do exist | batch-4 agent |

---

## 12. UNKNOWN log

Each row names the exact step that settles it. None of these can be settled from the repository.

| ID | Category | Unknown | What settles it |
|---|---|---|---|
| U18-1 | ops | The plan level of the Vercel project and therefore the runtime-log retention window available in an incident | Vercel dashboard → project → Settings → Plan; then Logs for a past window to see the oldest retrievable entry |
| U18-2 | ops | Whether any log drain, integration or external log sink is configured | Vercel dashboard → project → Settings → Integrations (and → Log Drains if present) |
| U18-3 | ops | Whether an uptime monitor exists at all, what it polls (the site root? `/api/jobs/config`? `reconcile`?), at what interval, and to whom it alerts | the monitor's own console (cron-job.org job list or equivalent) → the job's URL(s), schedule and notification settings |
| U18-4 | ops | Who receives the GitHub Actions failure emails for `outbox-tick.yml` | GitHub → the repository → Settings → Notifications / the account's notification settings; plus the workflow's own watchers |
| U18-5 | money | Whether the live Stripe key is in live or test mode, and whether webhook delivery has failed recently (Stripe disables endpoints after sustained failure) | Stripe dashboard → Developers → Logs (key mode) and → Developers → Webhooks → the endpoint's delivery attempts and status |
| U18-6 | money | Whether Stripe's own notifications for failing endpoints/chargebacks are enabled and to which address (the product's `REPORT_NOTIFY_EMAIL`/`EMAIL_FROM` are separate) | Stripe dashboard → Settings → Notifications (and Business settings → email recipients) |
| U18-7 | ops | Whether any `ProviderEvent` `ERROR`/`DUPLICATE` rows, failed `EmailLog` rows, or `AuditLog` rows exist in production right now, and their counts | a `psql` session against production with the §3.8 SQL (no production reader exists) |
| U18-8 | ops | What a production 500 actually looks like in the platform log (fields, verbosity, presence of the route and status) | Vercel dashboard → the deployment → Logs, filtered to a known 500 from any route |
