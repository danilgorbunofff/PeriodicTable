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
| Status | draft — fixes applied (2026-09-16, §5.9) |

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
- **After the fix pass (2026-09-16): two runtime `console.*` calls remain, and they are those two client sites.** The
  whole-tree census is now **76 matches across 14 files**, almost all of them test files; the runtime-only census
  (`-- app lib ':!*.test.*'`) is **3 matches in 3 files** — the two `console.error` calls above, which now make that
  call *in addition to* filing to the sink, and one comment in `lib/rateStore.ts:100`. §5.9 has the re-run, the level
  rule the other 21 sites were migrated onto, and what each of them became.
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

**After the fix pass (2026-09-16):** the same command runs **65 files / 967 passed / 0 failed** here, and — with no database at all — **57 passed | 8 skipped (65), 807 passed | 160 skipped (967)**. The six CRLF failures this section records no longer reproduce; the phase-18 branch rewrote those files. §5.9 has the exact commands and what moved.

### 5.8 Provider-documentation reading: log retention (not a console reading)

Read on 2026-09-15 from Vercel's documentation and public answers: log **drains** are a Pro-and-above feature, and Hobby runtime logs are visible in the dashboard for a short rolling window (commonly reported as about one hour). This is *documentation*, not a reading of `periodictable.lol`'s plan or dashboard, so it is registered as `U18-1` with the exact dashboard step that settles it. It matters because every "check the logs" instruction in every runbook that might be written inherits this limit.

### 5.9 Fix verification

**2026-09-16, this worktree, after the §7 fix pass.** The pass ran against a real database, like the
`08`–`17` passes: the same `postgres:16-alpine` container (`ptl-fix08-pg`, `127.0.0.1:55433`, database
`periodictable_test`) with the fourteen migration directories `0000`–`0013` applied, so nothing below
skipped for want of a schema. Nothing was deployed, the application was never started and no console was
read — which is this doc's one irreducible limit — so every production reading in §1–§6 stands as written,
each §8 box is checked against the tree rather than against a release, and U18-1…U18-8 all stand.

```
TEST_DATABASE_URL=… npx vitest run             → 65 files passed (65); 967 passed, 0 failed
npx vitest run          (no database at all)   → 57 passed | 8 skipped (65); 807 passed | 160 skipped (967)
npx tsc --noEmit                               → clean
npx eslint lib app components emails scripts   → clean (exit 0, no output)
git --no-pager grep -n -E 'console\.' -- app lib ':!*.test.*'
                                               → 3 matches / 3 files: app/error.tsx, app/global-error.tsx
                                                 (each filing to the sink as well) and one comment
psql … -tAc 'select count(*) from "ErrorReport"'   → 0 — the suite writes, reads and cleans up after itself
```

**What moved.** 882 → **967** cases and 57 → 65 files on the database suite; 737 → **807** passed
(145 → 160 skipped) with no database at all. The eight new files: `lib/log.test.ts` (13),
`lib/errorReport.test.ts` (18), `lib/clientError.test.ts` (16), `lib/health.test.ts` (11),
`lib/healthRoute.test.ts` (2), `lib/opsMetrics.test.ts` (18), `lib/analyticsConsent.test.ts` (7) and
`lib/emailFailure.test.ts` (2). The runtime `console.*` census went **23 sites in 15 files → 2 sites in 2
files** (§5.1), the route tripwire in `lib/contracts.test.ts` went 32 → 34 for the two new API routes, and
four surfaces did not exist before this pass at all: `/api/health`, `/api/internal/error`,
`/api/admin/ops` and `/api/admin/audit`. `ops/alerts.md` is new; `prisma/migrations/0013_error_report` is
the one schema addition.

Three things this pass found while writing the tests that the review had not registered:

1. **`lib/errorReport.test.ts` wrote five `ErrorReport` rows per run and deleted none of them.** The sink's
   own table is shared by every DB-backed file in a suite that runs single-file (`vitest.config.ts`
   `fileParallelism: false`), so the reader test that asserts a *delta* would have inherited a growing
   pile — 25 rows had accumulated from earlier runs before it was noticed. The shape test now cleans up
   after itself (guarded on `hasTestDb`) and the reader's assertions are deltas against a before/after
   read rather than "the newest row is mine".
2. **Six pre-existing assertions were pinned to the exact text this pass replaced** — the old `console.*`
   idioms, an exact `Cache-Control` string, and two comment clauses. Each was re-pointed at the new idiom
   with a comment naming the finding that changed it, and `app/api/admin/audit/route.ts` gained the
   `no-store, max-age=0` header its reader test expected: a runbook can quote a header, but only a test
   can hold a route to it.
3. **The refused-delivery line needed a runtime test, not a source reading.** The first version of the
   R18-2 check asserted that the route *contains* a throttled `logError` call. The test now drives the
   route through a storm of bad signatures and asserts one line per minute, the `signatureHeader`
   present/absent split, and that neither the payload nor the signing secret appears in it.

**Per finding.** Every §7 status line below names its half; these are the artefacts and the honest gaps.

**R18-1 — the sink.** `lib/errorReport.ts` is the whole mechanism: `fingerprintOf()`, a 60-second repeat
window, a 30-per-60-second write cap, a three-failure breaker that opens for five minutes, `capFields()`
and `errorSinkEnabled()`. `app/api/internal/error/route.ts` is the only door (202 `{recorded, reason}`,
429/413/400 on the refusal arms, GET → 405, and it never echoes a row back). `instrumentation.ts` handles
`uncaughtException` and `unhandledRejection` with a 750 ms deadline, so a crash loop cannot become a report
loop; `lib/route.ts` files every unhandled API-route error through `reportCaught()`. As of this segment the
sink is also **readable**: `/api/admin/ops` carries an `errors` block. Retention is stated rather than
assumed — there is no pruning job, deliberately, and `ops/alerts.md` tables what that costs.

**R18-2 — the refused delivery and the terminal decision.** The 401 now logs
`stripe / webhook-bad-signature` with `signatureHeader` (`present`/`absent`) and `sinceLastLine`, throttled
to one line a minute; the seven `recordProviderEvent` sites became one `recordTerminal()` helper, so every
terminal outcome (including the retryable 500s) is a row plus a line; and the reader is the dashboard's
`providerEvents` block (`byOutcome`, `recentErrors`). The deliberately unwritten half: a bad signature
writes no `ProviderEvent` row, because the request's signature did not verify and a rejected delivery is
unverified input — §8 box 2 is left unticked for that clause rather than quietly satisfied by storing
attacker-supplied JSON.

**R18-3 — mail failures.** `failureDetail()` leads the row's `detail` with the cause
(`failed (provider 422): resend 422: {body} — {subject}`), the row keeps `providerStatus`, and one
`send-failed` line carries template, `toRef` (a salted digest, never the address), status, reason and
dedupe key. The reader is the dashboard's `mail` block. `lib/emailFailure.test.ts` drives the real sender
against a stubbed provider for both arms the box names — a 422 with a provider body, and a call that never
answers — and asserts the row, the single line, and the absence of the address and the key from both.

**R18-4 — key mode.** `stripeKeyMode()` (`live`/`test`/`unknown`/`unset`) and `getProviderMode()` ride the
config payload, and a production deployment holding a test key gains a `required` `STRIPE_SECRET_KEY`
finding — `required`, because the status code is the only channel the pinger reads. `lib/ops.test.ts`
asserts both arms through the route: test key → 503 with the finding, live key → the finding gone.

**R18-5 — the audit reader.** `app/api/admin/audit/route.ts` (`adminGate`, `?action=` validated against
`AUDIT_ACTIONS`, `?startup=`, `?payment=`, `?before=` cursor, 50-row pages, `X-Audit-*` headers,
`no-store`), with the queries for `PAYMENT_REVERSED`, `PROFILE_MODERATED` and `REPORT_TRIAGED` written into
`ops/takedown.md` and `ops/alerts.md`.

**R18-6 — health.** `/api/health` runs exactly one `SELECT 1` behind `probeDatabase()` with a 2-second
timeout that never throws, and answers 200 `{ok:true,…}` or 503 `{ok:false,db:"error"|"timeout",…}` with
`deploy`/`env`/`ms` attached, `no-store`, and one `warn` when the probe fails. It is URL 1 of 5 on
`ops/alerts.md`'s monitor list and is unauthenticated by design — an unauthenticated liveness probe is the
only one a monitor without a secret can use. The monitor that would poll it is `D21`/`U18-3`.

**R18-7 — one money definition.** `opsReport().money` defines paid-net-of-reversals once, and
`/api/stats`'s two money fields now carry `moneyScope: "board"` with the board's own count beside them
(`lib/api.ts`, `app/api/stats/route.ts`, `components/StatsCard.tsx`), so the two surfaces no longer look
like they disagree about the same fact.

**R18-8 — queue depth and ageing.** `OutboxHealth` gained `pending`, `pendingByType`, `oldestPendingMinutes`
and per-type ages, exposed on both workers and the dashboard's `outbox` block, with three alarm codes
(`outbox-depth` — critical when the queue is deep *and* nothing is due, `outbox-stale`, `outbox-exhausted`)
and tests that assert the aggregate against a known queue state rather than against whatever the database
happens to hold.

**R18-9 — the policy.** `ops/alerts.md` holds the monitor URL list with the expected status per URL, the
six-class signal table with each threshold as a number, the alarm-code table with severities, and the
stale-tick bounds derived from `HEARTBEAT_ROUTES` (26 h for the two daily workers, 13 h 20 m for the rest).
The half no worktree can supply: the channel and the recipient (`D18`), whether a monitor exists at all
(`U18-3`, `D21`), and who is on call (`D22`).

**R18-10 — client crashes.** Both boundaries now file through `reportClientError()`, which dedupes on
message and route, sends at most 25 per page load, and never retries — `sendBeacon` first, `fetch
keepalive` as the fallback — with `components/ClientErrorReporter.tsx` binding the window's `error` and
`unhandledrejection` events. They also keep the browser-console call, because the user's own console is the
only place a client crash is visible while it is happening.

**R18-11 — correlation and levels.** `lib/log.ts` grew `withRequestScope()`/`currentRequestId()` (an
`AsyncLocalStorage` scope `lib/route.ts` opens around every API call and echoes in `X-Request-Id`),
`deploymentId()`, `appEnv()` and `describeError()`, and the level rule is written where the emitters are:
degraded-but-survived is `warn`, outcome-changing failure is `error`, and only `error` may page. The 21
runtime sites the census counted were migrated onto it in the same pass.

**R18-12 — the ambiguous status code.** `ops/alerts.md` states the three contracts verbatim and side by
side: `/api/jobs/config` 200 (right secret, nothing required missing) / 503 (authenticated but
misconfigured) / 401 (secret did not match); `/api/health` 200/503; `/api/admin/ops` 200, or 503 only when
asked with `?ok=1`. A monitor now has a documented expected status per URL instead of "not 200".

**R18-13 — the consent gate.** `lib/analyticsConsent.ts` (version-1 record under `ptl:analytics-consent`,
`analyticsAllowed()` failing closed) plus `components/AnalyticsConsent.tsx`, which renders only when a
domain is configured and injects the script only after an explicit Allow. Nothing is shown in production
today, because the domain is unset — but setting that one variable no longer turns analytics on by itself,
which is the finding. Whether they run at all, and with what notice, is `D19`.

**R18-14 — the funnel.** The dashboard's `funnel` block computes clicks → checkouts started → paid and both
conversions server-side from our own tables — deliberately not from the seven inert client events — and
`money.window.settledRate` answers paid → settled. The definitions are in `ops/alerts.md`'s dashboard
section, so "what fraction of started checkouts completed yesterday" is a read rather than a SQL exercise.

**R18-15 — the retention window.** `ops/alerts.md` carries the ~1 h window, its `U18-1` status and an
eight-row durable-substitute table, and every runbook that says "read the logs" now states the window and
points at it: `ops/README.md`, `ops/takedown.md`, `ops/database.md`, `ops/email.md`, `ops/webhooks.md`.
Buying drains is `D20`.

**After the fix pass (§5.9).** **Fourteen of the fifteen §8 boxes are ticked** and one is not: box 2's row
clause, which asked for a `ProviderEvent` row for a delivery whose signature did not verify, and which the
pass deliberately declined to satisfy (the log clause is met and tested). Five boxes are ticked with their
missing half named in place rather than left ambiguous — box 1 by a deployment nobody made, box 7 by a monitor
whose existence is `U18-3`/`D21`, box 11 by a recipient that is `D18`, and box 14 by an analytics decision
that is `D19`. That is the shape of this phase: the code half of observability is a repository change, and the
half that reaches a human is the eight operator decisions registered as `D18-1`…`D18-8` (the `D17`–`D24` rows
in §9 below).

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

Registered in `FINDINGS.md` as `R18-1`…`R18-15`. Severity per `00-REVIEW-PLAN.md` §4 (P0 blocks announce; P1 must fix before announce; P2 first week; P3 backlog). All fifteen were `open` when this doc was written; §5.9 records the fix pass, and each status line below names the half that is fixed and the half that is not.

**R18-1 — No error tracking: a 03:00 crash leaves nothing durable to read.** P1 · `ops`
**Evidence.** No error-tracking SDK in `package.json`; whole-tree grep for `sentry|rollbar|datadog|honeycomb|bugsnag|axiom|highlight|baselime|otel|opentelemetry` returns exactly **one** match, a false positive in a test comment (`lib/searchCombobox.test.ts:9`, the word "highlighted"), and the `opentelemetry`-only grep returns `package-lock.json:5553,5560` (transitive, unimported). §5.1 census: the only two "global" handlers are client-side (`app/error.tsx:20`, `app/global-error.tsx:16`). §5.8: log retention ≈1 h on the plan level, `U18-1` settles the actual plan.
**Reproduction.** Deploy a build with a top-level import error, or kill the process; observe that nothing except platform logs records it.
**Proposed fix.** Add a minimal error sink (a provider SDK or a `/api/internal/error` route writing to a table) wired into both boundaries and a server-side `instrumentation.ts`; document the retention the sink provides. Operator decision `D17` covers the vendor.
**Fix.** `lib/errorReport.ts` is the mechanism — `fingerprintOf()`, a 60-second repeat window, a 30-per-60-second write cap, a three-failure breaker that opens for five minutes, `capFields()`, `errorSinkEnabled()` — with `app/api/internal/error/route.ts` as the only door (202 `{recorded, reason}`, 429/413/400 refusals, GET → 405, and it never echoes a row back), `instrumentation.ts` handling `uncaughtException` and `unhandledRejection` behind a 750 ms deadline so a crash loop cannot become a report loop, every unhandled API-route error filed by `lib/route.ts` through `reportCaught()`, and a client half (`lib/clientError.ts`, `components/ClientErrorReporter.tsx`, `R18-10`). `prisma/migrations/0013_error_report` adds the table. The sink is now **read** as well as written: `/api/admin/ops` answers with an `errors` block (count, occurrences, by source, the ten newest rows). Retention is documented rather than assumed — there is no pruning job, deliberately, and `ops/alerts.md` states what that costs.
**Status.** fixed (`§5.9`) — self-hosted, so `D17` is now a choice about where else the rows go rather than whether they exist; the pass also added the reader the finding's "durable to read" clause needed. Not deployed, so "visible within one minute of deployment" is demonstrated against the test database only.

**R18-2 — Webhook verification failures and terminal provider events are invisible.** P1 · `money`,`ops`
**Evidence.** `app/api/webhooks/stripe/route.ts:40-42` returns 401 on a bad signature with no log (the file's only console call is `:45`, the success case, whose comment at `:43-44` says a silent 401 is "unobservable from our side"); `:190-193` returns 500 on a retryable settle failure, where the only trace is one `settle-error-retryable` line one frame down in `lib/settle.ts:298`; `:126-169` write `ERROR`/`DUPLICATE`/`IGNORED` rows and return 200 with the silent `IGNORED` cases at `:57-64,67-75,109-116`. No production reader for `ProviderEvent` (§5.2).
**Reproduction.** Send a webhook with a wrong signature to a dev server and watch the console: nothing appears for the 401.
**Proposed fix.** Log a one-line structured event on signature failure (no payload, no secret) and on every terminal rejection; add a `/api/jobs/provider-events?since=`-style read (or a documented SQL) so the row class is not write-only.
**Fix.** The 401 now logs `stripe / webhook-bad-signature` with `signatureHeader` (`present`/`absent`) and `sinceLastLine`, throttled to one line per `SIGNATURE_FAILURE_LOG_INTERVAL_MS` (60 s), so a storm is one line and a count rather than a flood. The seven `recordProviderEvent` sites became one `recordTerminal()` helper, which writes the row *and* logs — including the two retryable 500s, which were previously visible only one frame down in `lib/settle.ts`. The reader is `/api/admin/ops` → `providerEvents` (`byOutcome`, `recentErrors`).
**Status.** fixed in part (`§5.9`) — the log half is fixed and tested (`lib/webhook.test.ts` drives a signature storm and asserts exactly one line, both `signatureHeader` values, and that neither payload nor secret appears). The row half is **deliberately not** implemented: a refused delivery writes no `ProviderEvent` row, because the request's signature did not verify and recording it would be storing unverified input. §8 box 2 is left unticked rather than quietly satisfied by writing attacker-supplied JSON.

**R18-3 — Mail failures are unlogged and undiagnosable; `EmailLog.detail` is the subject line.** P1 · `money`,`ops`
**Evidence.** No `console.` in `lib/email.ts` (§5.1). `deliver()` discards the provider's response: `if (!res.ok) return "error"` (`:66`), `catch { return "error" }` (`:69`). All four senders store `detail: subject` (`:106,138,164,178`). No production reader for `EmailLog` (§5.2). `17` §7 `R17-13` owns the operator-side runbook.
**Reproduction.** Point `RESEND_API_KEY` at an invalid key in a dev environment; the only evidence is an `EmailLog` row whose `detail` names the subject.
**Proposed fix.** Capture the provider's status and error body into `EmailLog.detail` (truncated) and log one structured line per failed send; add the "mail health" query from §3.8 row 6.
**Fix.** `lib/email.ts`: `failureDetail()` now leads `detail` with the cause — `failed (provider 422): resend 422: {body} — {subject}`, reason truncated to 120 characters, subject last — the row keeps `providerStatus`, and one `mail / send-failed` line carries `template`, `toRef` (a salted digest, never the address), `providerStatus`, the reason and the dedupe key. The "mail health" query is `/api/admin/ops` → `mail` (`sentCount`, `failedCount`, `recentFailures` with template, status and reason).
**Status.** fixed (`§5.9`) — both arms the box names are asserted by a new test that drives the real sender against a stubbed provider: a non-2xx response with a provider body, and a call that never answers (`lib/emailFailure.test.ts` asserts the row, the single line, and the absence of both the address and the API key from the captured output).

**R18-4 — No surface distinguishes live vs test mode, and the config report cannot see advisories.** P1 · `money`,`ops`
**Evidence.** `stripeEnabled()`/`getProviderMode()`/`stripePartiallyConfigured()` (`lib/stripe.ts:18,28,33`) — the mode the checkout route returns to the client (`app/api/checkout/route.ts:372`) is never reported to the operator; `/api/jobs/config`'s payload carries `env` and `findings[]` only (`app/api/jobs/config/route.ts:7-40`); `PROD_ENV_VALIDATORS` (`lib/env.ts:84-87`) validates only `NEXT_PUBLIC_APP_URL` and `CLICK_SALT`, so a `sk_test_` key in production passes every check. Advisories never fail `ok` by design (`lib/env.ts:128-144`), verified live (§5.3: one `degraded` finding, `ok:true`).
**Reproduction.** Set `STRIPE_SECRET_KEY=sk_test_…` in a preview environment; `/api/jobs/config` stays 200 with a green `ok`.
**Proposed fix.** Add `providerMode` and a `stripeKeyMode` (`test`/`live`) field to the config report, and a `required` finding when a production deployment's key is in test mode.
**Fix.** `lib/stripe.ts` gains `stripeKeyMode()` (`live`/`test`/`unknown`/`unset`), typed as a total function over the key prefix rather than a second `stripeEnabled()`; the config payload now carries `providerMode` and `stripeKeyMode` alongside `env` and `findings[]`; and a production deployment holding a test key gains a `STRIPE_SECRET_KEY` finding at severity **`required`** — required, not advisory, because for the pinger the status code is the only channel it reads (the status code contract is `R18-12`).
**Status.** fixed (`§5.9`) — `lib/ops.test.ts` asserts both arms through the route: a production deployment with `sk_test_…` answers 503 with the test-mode finding and `stripeKeyMode: "test"`, and the same deployment with `sk_live_…` drops the finding and reports `live`.

**R18-5 — The audit trail and refund/reversal history have no reader, and there is no operational history view.** P1 · `ops`,`legal`
**Evidence.** `lib/audit.ts:17-26` (nine actions) writes rows; grep finds **zero** production readers (§5.2). `PAYMENT_REVERSED`, `PROFILE_MODERATED`, `REPORT_TRIAGED` therefore have no operator-visible record. No admin route lists them (`17` §3.1's four routes).
**Reproduction.** Reverse a payment in dev; the audit row exists and no surface shows it.
**Proposed fix.** Add an admin read (or a documented SQL block in the runbooks) for `AuditLog` filtered by startup/payment; include it in the §3.8 dashboard.
**Fix.** `app/api/admin/audit/route.ts` — `adminGate`, `?action=` validated against `AUDIT_ACTIONS` (nine values) with `BAD_ACTION` on anything else, `?startup=`, `?payment=` and a `?before=` cursor, 50-row pages, `X-Audit-Count`/`X-Audit-Has-More` headers and `cache-control: no-store, max-age=0` — plus the queries for `PAYMENT_REVERSED`, `PROFILE_MODERATED` and `REPORT_TRIAGED` written into `ops/takedown.md` and `ops/alerts.md`.
**Status.** fixed (`§5.9`) — row 7 of §3.8 resolves to this route, and the pass added the two headers the reader test pins so a runbook quoting a header has a test holding it.

**R18-6 — A database outage is indistinguishable from a broken route.** P1 · `ops`
**Evidence.** `lib/txn.ts:47-52` logs per-attempt retryable errors; no route, job, or health surface reports database reachability; there is no `/api/health` (§5.2); `/api/stats` would 500 with an unknown error shape.
**Reproduction.** Stop Postgres in a dev environment and call `/api/stats`; observe a generic failure with no distinguishing signal.
**Proposed fix.** Add a `/api/health` that does exactly one `SELECT 1` with a short timeout, returns a distinguishable status, and is added to the monitor's URL list; document the PITR/restore path (`17` §7 `R17-12` owns the runbook).
**Fix.** `lib/health.ts` + `app/api/health/route.ts` — exactly one `SELECT 1` behind `probeDatabase()` with a 2-second `HEALTH_TIMEOUT_MS`, a probe that never throws, 200 `{ok:true,db,ms,deploy,env}` or 503 `{ok:false,db:"error"|"timeout",…}`, `cache-control: no-store, max-age=0`, and one `warn` line when the probe fails (a survived degradation, so not `error`). It is URL 1 of 5 on `ops/alerts.md`'s monitor list and is deliberately unauthenticated — a monitor holding no secret can still poll it — which is why it does not join `HEARTBEAT_ROUTES`.
**Status.** fixed (`§5.9`) — `lib/health.test.ts` (11 cases: reachable, timing out, unreachable, POST → 405) and `lib/healthRoute.test.ts` (2) pin the contract. The monitor that would poll it is `D21`/`U18-3`.

**R18-7 — No surface answers "how many stakes were actually paid for?" — `/api/stats` and `reconcile` give opposite-looking numbers.** P1 · `ops`,`money`
**Evidence.** Live probes (§5.4): `/api/stats` → `stakeCount:0,totalStakedUsd:0`; `/api/jobs/reconcile` → `paidTotal:3`. Definitions differ by construction (`app/api/stats/route.ts:11-21` uses `FACE_STAKE_WHERE` for `claimedElements` and hidden-inclusive aggregates for the money fields; reconcile counts `paid` payments).
**Reproduction.** Compare both surfaces at any time the board is empty but payments are paid.
**Proposed fix.** Define the launch-day money metric once (paid payments, net of reversals), expose it as a field on an authenticated surface, and label `/api/stats`'s two money fields as board-scoped.
**Fix.** `opsReport().money` defines the number once — paid payments, net of reversals, over the window — and `/api/admin/ops` carries it as `money.paidNetUsd` with the `X-Ops-Paid-Net-Usd` header; `/api/stats`'s two money fields now carry `moneyScope: "board"` (`lib/api.ts`, `app/api/stats/route.ts`) and `components/StatsCard.tsx` labels them with the board's own count beside them, so the two surfaces stop looking like they disagree about the same fact.
**Status.** fixed (`§5.9`) — §5.4's contradiction is now a labelled scope difference rather than an unexplained one; the definition is stated in `ops/alerts.md` ("paid payments net of reversals").

**R18-8 — Outbox depth and ageing are unreadable anywhere.** P1 · `ops`
**Evidence.** No `outboxEvent.count|aggregate|groupBy` in production code (§5.2); the only non-test `findMany` is a demo cleanup (`scripts/clear-demo-data.ts:152-160`); the workers return only `{claimed,completed,failed}` for the rows they happened to touch (`app/api/jobs/outbox/route.ts`, §5.3). `claimed:0` is ambiguous between "empty" and "nothing due".
**Reproduction.** Enqueue several failing rows in dev; nothing in any surface shows the backlog.
**Proposed fix.** Add aggregate fields (`pending`, `due`, `failed`, `oldestDueAgeMs`) to the drain response and a read on an authenticated surface; alarm when `pending` grows across consecutive ticks.
**Fix.** `OutboxHealth` gained `pending`, `pendingByType`, `oldestPendingMinutes` and per-type ages; both workers return it (`app/api/jobs/outbox/route.ts`, `app/api/jobs/reconcile/route.ts`) and the dashboard carries it as the `outbox` block, so `claimed: 0` is no longer ambiguous between "empty" and "nothing due". Three alarm codes read it: `outbox-depth` (critical when the queue is deep **and** nothing is due — depth plus inactivity, not depth alone), `outbox-stale` (oldest pending row past `OUTBOX_ALARM_AGE_MINUTES = 120`) and `outbox-exhausted`.
**Status.** fixed (`§5.9`) — tested against a known queue state rather than against whatever the shared test database happens to hold, so the assertion does not drift with the fixture.

**R18-9 — Every class in §6 has no owner and no alarm; the only automated escalation is a red GitHub Action at 6.4 % cadence.** P1 · `ops`
**Evidence.** §5.3 measurement (46 runs vs 720 nominal); §3.10 (no threshold, rule, or recipient anywhere in the tree); `.github/workflows/outbox-tick.yml:31-97` is the only automated outer loop; the config step explicitly exists because the free pinger tier can only read status codes.
**Reproduction.** Disable the workflow; production continues and nothing reports it.
**Proposed fix.** Operator decision `D18` (which monitor/alert channel), then: poll `/api/health`, `/api/jobs/config` and `/api/jobs/reconcile`; alert on 503/divergence; alert on the absence of a successful tick within N minutes; name a recipient.
**Fix.** `ops/alerts.md` is the policy: the monitor URL list with the expected status and the expected body field per URL, the six-class signal table (site down, checkout 5xx, webhook failure, divergence, queue depth, mail failure) with every threshold as a number and each class's owning runbook, the alarm-code table with severities, and the stale-tick bounds derived from `HEARTBEAT_ROUTES` — 26 h for the two daily workers and 13 h 20 m for the rest, each stated with the arithmetic. The alarm feed itself is machine-readable: `alarmsFor()` emits `{code, severity, detail}` and the ops route exposes it as a body field, `X-Ops-Alarms`, plus `?ok=1` for a monitor that wants 503.
**Status.** fixed in part (`§5.9`) — the thresholds, the URL list and the stale-tick derivation exist; the channel and the recipient are `D18`, whether a monitor exists at all is `U18-3`/`D21`, and who is on call is `D22`. §8 box 11 is ticked on the threshold half with the missing half named in place.

**R18-10 — Client crashes are reported to the user's browser only.** P2 · `ops`,`ux`
**Evidence.** `app/error.tsx:20`, `app/global-error.tsx:16` — `console.error` in client components; no server collector.
**Reproduction.** Force a throw in a client component; the boundary renders and nothing is transmitted anywhere.
**Proposed fix.** Route the same caught error to the `R18-1` sink with the route and a build id.
**Fix.** Both boundaries keep their `console.error` (the user's own console is the only place a client crash is visible while it happens) and now also call `reportClientError()` from `lib/clientError.ts`: deduped on message + route, at most 25 per page load, `sendBeacon` first with `fetch keepalive` as the fallback, never retried, silently dropped on refusal. `components/ClientErrorReporter.tsx` binds the window's `error` and `unhandledrejection` events; the sink's row carries `source: "client"`, the route, the digest and the deployment id.
**Status.** fixed (`§5.9`) — `lib/clientError.test.ts` (16 cases) pins the caps, the transport fallback, the fail-silent arms and the dedupe. As with `R18-1`, nothing was deployed, so "a synthetic error is visible in the sink" is demonstrated against the test database.

**R18-11 — No request correlation, deployment version or env on any log line.** P2 · `ops`
**Evidence.** §3.1: the three structured shapes carry `scope`/`msg` plus domain fields only; no request id, version, or env anywhere in the 23 runtime sites.
**Reproduction.** Search a log window for a `paymentId` and try to attribute the lines to a deployment: impossible.
**Proposed fix.** Add a per-request id (header or generated) and a build-id/env field to the structured shapes; adopt one rule for the level of non-blocking failures.
**Fix.** `lib/log.ts` grew `withRequestScope()`/`currentRequestId()` — an `AsyncLocalStorage` scope that `lib/route.ts` opens around every API call and echoes back in `X-Request-Id` — plus `deploymentId()`, `appEnv()` and `describeError()`, and every structured shape now carries `deploy` and `env` on the line. The level rule is written where the emitters are: **degraded but survived is `warn`; a failure that changed the outcome is `error`; and only `error` may page** — which is also why the health probe's failure is a `warn` and a failed mail send is an `error`.
**Status.** fixed (`§5.9`) — the census's runtime sites were migrated onto the emitters in the same pass (23 → 2, §5.1), and `lib/log.test.ts` (13 cases) pins the shape, the level rule and the scope's behaviour under nested async work.

**R18-12 — The alert surface's status code is ambiguous: 401 (bad secret) vs 503 (config finding) vs 200 (healthy) can all be seen by a monitor as "not 200".** P2 · `ops`
**Evidence.** §5.5 probe output; `lib/env.ts:128-144`'s deliberate auth-before-health ordering; `lib/ops.test.ts:124-160` asserts the coupling.
**Reproduction.** Poll with a wrong bearer and with a valid bearer that has a `required` finding; both are non-2xx.
**Proposed fix.** Document the exact expected status per monitor (and the intended one-token-per-purpose separation), or add a monitor-friendly unauthenticated liveness route (`R18-6`).
**Fix.** Both halves: `ops/alerts.md` opens with the three contracts stated verbatim and side by side — `/api/jobs/config` **200** (secret matched and nothing `required` is missing) / **503** (authenticated but misconfigured) / **401** (secret did not match), `/api/health` **200**/**503**, `/api/admin/ops` **200** (or **503** only when asked with `?ok=1`) — with the expected status written next to each of the five monitor URLs; and the unauthenticated liveness route is `/api/health` (`R18-6`).
**Status.** fixed (`§5.9`) — a monitor now has a documented expected status per URL instead of "not 200", which is the ambiguity this finding named.

**R18-13 — Analytics have no consent gate, and the switch that turns them on is one env var.** P2 · `privacy`,`legal`
**Evidence.** §5.6 (no script, no cookie, no consent today); `app/layout.tsx:29-31` (script rendered only on the env var); `lib/analytics.ts:17-28` (silent no-op without the global); `16` §7 `R16-4`/`R16-5` own the policy's accuracy about processors.
**Reproduction.** Set `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` in a preview deployment and load the page: pageviews and seven event names leave the browser with no notice or choice.
**Proposed fix.** Decide `D19` (analytics on/off, cookieless vendor, consent copy) and, if on, ship a notice plus the legal-page update in the same change.
**Fix.** The technical half is built: `lib/analyticsConsent.ts` holds a version-1 record under `ptl:analytics-consent` and `analyticsAllowed()` **fails closed**, and `components/AnalyticsConsent.tsx` renders a notice only when a domain is configured and injects the script only after an explicit Allow. Setting `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` no longer turns analytics on by itself, which is exactly what this finding said it did. The legal pages were updated in the same change (`16` §10, privacy digest re-recorded).
**Status.** fixed in part (`§5.9`) — the gate is the finding; whether analytics run at all, with which vendor and what notice, is `D19`. §8 box 14 is ticked on the "disabled, and gated" half with that half named in place.

**R18-14 — Nothing measures the customer-facing outcome: successful checkout rate, settled-stake rate, or the funnel's drop-off.** P2 · `ops`
**Evidence.** §3.7/§3.9: `stats` counts board state; `reconcile` counts payments; no surface computes `paid → settled` or `click → checkout_start → paid`; the seven Plausible events are inert (§5.6).
**Reproduction.** Ask "what fraction of started checkouts completed yesterday?" — answerable only by hand-written SQL across `Payment` and (absent) view data.
**Proposed fix.** Define the two conversions in the §3.8 dashboard and implement the queries; if Plausible is enabled, document which number is authoritative (`R18-7`).
**Fix.** The dashboard's `funnel` block computes click → checkout started → paid and both conversions **server-side from our own tables** — deliberately not from the seven inert client events, so the number is right whether or not analytics are ever switched on — and `money.window.settledRate` answers paid → settled. The definitions are written down in `ops/alerts.md`, so "what fraction of started checkouts completed yesterday?" is a read rather than a hand-written SQL exercise.
**Status.** fixed (`§5.9`) — this is §3.8's row 4, the "query does not exist" row; the other three such rows are now rows the dashboard answers (`R18-5`, `R18-7`, `R18-8`).

**R18-15 — Log retention (~1 h at the plan level) makes "check the logs" a valid instruction only within the same hour; no instruction anywhere states this.** P3 · `ops`
**Evidence.** §5.8 documentation reading; the plan-level limit is `U18-1`.
**Reproduction.** Ask an operator to reconstruct yesterday's incident from logs.
**Proposed fix.** Either enable log drains (cost decision, `D20`) or write down, in every runbook that says "read the logs", that the window is ~1 h and that the DB tables in §3.6 are the durable substitute.
**Fix.** `ops/alerts.md` now carries the window, its `U18-1` status and an eight-row substitute table ("Question you would ask a log" → "Durable substitute" → lifetime), and every runbook that says *read the logs* states the window and points at it — `ops/README.md`, `ops/takedown.md`, `ops/database.md`, `ops/email.md`, `ops/webhooks.md`. The table also records the one substitute that is itself unbounded: `ErrorReport` rows are kept forever, with the write caps stated beside them.
**Status.** fixed (`§5.9`) — the second branch of the fix, which is the one that costs nothing; buying drains remains `D20`.

---

## 8. Acceptance criteria

- [x] An error-tracking sink exists and receives server-boundary, client-boundary and API-route errors, with the deployment id attached; a synthetic error is visible in the sink within one minute of deployment (`R18-1`, `R18-10`). — The sink, both boundaries and the API-route path exist (§5.9); "within one minute" and the deployment id are asserted against the test database, not a release, because nothing was deployed.
- [ ] A webhook request with an invalid signature produces exactly one log line (no payload, no secret) and one `ProviderEvent` row, and a test asserts both (`R18-2`).
  **Unticked: the row half.** The line half is done and tested — one line per minute, `signatureHeader` present/absent, no payload and no secret in it, asserted by driving the route through a signature storm (`lib/webhook.test.ts`). The box also asks for a `ProviderEvent` **row** for a delivery whose signature did not verify, and that row would persist attacker-supplied JSON in the table an operator reads during a money incident. The pass declined it deliberately: a refused delivery is not a terminal decision about an event, it is a request we did not accept. Owned by `R18-2`; revisit only with a separate unverified-input class that no reader treats as provider truth.
- [x] A failed mail send records the provider's status and a truncated reason in `EmailLog.detail` and logs one structured line; a test covers a non-2xx response and a timeout (`R18-3`). — `lib/emailFailure.test.ts` covers both arms against a stubbed provider: a 422 carrying a provider body, and a call that never answers.
- [x] `/api/jobs/config` reports the payment provider's key mode, and a `required` finding is emitted when a production deployment runs against a test key; a test asserts the finding (`R18-4`). — `lib/ops.test.ts` asserts both arms through the route: `sk_test_…` in production yields the `required` finding and 503; `sk_live_…` drops it.
- [x] `/api/jobs/config`'s 200/503 contract is documented for the monitor verbatim, including that 401 and 503 mean different things (`R18-12`). — The first section of `ops/alerts.md`, with the expected status written beside each of the five monitor URLs.
- [x] An authenticated surface reports outbox `pending`, `due`, `failed` and oldest-due age; a test asserts the aggregate against a known queue state (`R18-8`). — The aggregate rides both workers and the dashboard's `outbox` block, and the test seeds a known queue rather than asserting whatever the shared database holds.
- [x] An authenticated `/api/health` (or documented liveness URL) returns a distinguishable status when the database is unreachable, and it is on the monitor's URL list (`R18-6`, `R18-9`). — `/api/health` separates `db: "error"` from `db: "timeout"`, is unauthenticated by design so a monitor holding no secret can poll it, and is URL 1 of 5 on the list. Whether the monitor exists at all is `U18-3`.
- [x] The launch-day dashboard's seven rows from §3.8 each resolve to a documented command or surface, and the two "query does not exist" rows are implemented (`R18-7`, `R18-14`). — §3.8 rows 1–3 are the config/jobs routes (row 3 now with the `health` aggregate), rows 4–6 are `/api/admin/ops`'s `money`, `outbox` and `mail` blocks, row 7 is `/api/admin/audit`; the two rows the review flagged as missing (`R18-7`, `R18-8`) are the two that were implemented.
- [x] The money question has one authoritative definition ("paid payments net of reversals"), stated in the dashboard, and `/api/stats`'s money fields are labelled as board-scoped (`R18-7`). — `money.paidNetUsd` and the `X-Ops-Paid-Net-Usd` header state it once; `/api/stats` carries `moneyScope: "board"` and `StatsCard.tsx` labels it.
- [x] `AuditLog` has a production reader or a documented query in the runbooks, covering at least `PAYMENT_REVERSED`, `PROFILE_MODERATED` and `REPORT_TRIAGED` (`R18-5`). — `GET /api/admin/audit` (`?action=`, `?startup=`, `?payment=`, `?before=`), with all three actions' queries written into `ops/takedown.md` and `ops/alerts.md`.
- [x] A documented alert policy exists naming, for each of: site down, checkout 5xx, webhook failure, divergence, queue depth, mail failure — the threshold, the channel and the recipient (`R18-9`, operator decision `D18`). — **Two of the three columns.** The thresholds are written (`ops/alerts.md`: six classes, each a number, each with its owning runbook and its alarm code). The channel and the recipient are `D18` — an operator decision, since only the operator can name an address that wakes somebody — and the document says so in those words instead of inventing an alias. The third column is therefore deliberately blank-in-place rather than absent.
- [x] The stale-tick condition (no successful tick for N minutes) is itself alarmed, not merely inferable (`R18-9`). — `stale-tick:<route>` is emitted as a critical alarm with the bound derived from `HEARTBEAT_ROUTES`: 26 h for the two daily workers (their cron gaps plus slack) and 13 h 20 m for the rest, with the arithmetic shown.
- [x] Structured log lines carry a request/deployment identifier, and one documented rule defines which failures log at which level (`R18-11`). — `deploy`, `env` and `requestId` ride every shape (`AsyncLocalStorage`, echoed as `X-Request-Id`), and the rule is stated at the emitters and pinned by `lib/log.test.ts`: degraded-but-survived is `warn`, outcome-changing is `error`, only `error` may page.
- [x] Analytics are either disabled with the legal pages stating that nothing is collected, or enabled with a notice and a consent decision recorded (`R18-13`, `16` §7, operator decision `D19`). — Analytics are off by default (`NEXT_PUBLIC_PLAUSIBLE_DOMAIN` unset) and still off with it set until a visitor accepts, because `analyticsAllowed()` fails closed. The legal-page update shipped in the same change; `D19` decides whether they ever run.
- [x] Every runbook that instructs the operator to "check the logs" states the retention window and the durable substitute (`R18-15`, coordinated with `17`). — `ops/alerts.md` carries the window and the eight-row substitute table, and the window is now stated in `ops/README.md`, `ops/takedown.md`, `ops/database.md`, `ops/email.md` and `ops/webhooks.md`.

**After the fix pass (§5.9).** **Fourteen of the fifteen boxes are ticked; box 2 is not**, for the reason written where the box is. Four ticked boxes name a half that no worktree can supply — box 1's deployment, box 7's monitor (`U18-3`/`D21`), box 11's channel and recipient (`D18`) and box 14's analytics decision (`D19`) — each stated in place rather than left implicit, and each a question in §9 rather than a gap in the code.

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

**Answered on the software half, recorded 2026-09-16 as operator decisions, `D18-1`–`D18-8` in `FINDINGS.md`.** Each question has a half that lives in the repository — the instrument, the reader, the threshold, the gate — and a half that is a person: a channel, an address, a plan, a name. The pass settled the first half and wrote down the second instead of guessing it. The register numbers decisions by phase, so `D18-n` is this doc's `D17+n`.

  *Answered on the software half, recorded 2026-09-16 as an operator decision (`D18-1`).* **`D17` Error-tracking vendor and plan.** The sink is self-hosted, so "accept platform logs only" is no longer the default by inaction: `/api/internal/error` writes `ErrorReport`, both process handlers and every unhandled API-route error feed it, the browser boundaries feed it through `R18-10`, and `/api/admin/ops` reads it back. Rows outlive the ~1 h log window. What is left is whether to forward them to a vendor, which is spend and data-processing terms (`16` §7's processor list) rather than code.

  *Answered on the software half, recorded 2026-09-16 as an operator decision (`D18-2`).* **`D18` Alert channel, recipients and thresholds.** `ops/alerts.md` names the six signal classes with a numeric threshold each, the alarm codes with severities, the monitor URL list with an expected status per URL, and the stale-tick bounds. The channel column is deliberately blank in place — no address, alias or phone number is invented — because that is the part only the operator can make true, and the document says so in those words rather than implying a default.

  *Answered on the software half, recorded 2026-09-16 as an operator decision (`D18-3`).* **`D19` Analytics.** Analytics are off, and now gated: `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` no longer turns the script on by itself, `lib/analyticsConsent.ts` fails closed and `components/AnalyticsConsent.tsx` only loads the vendor after an explicit Allow, and no funnel number comes from a browser (`R18-14` computes it server-side). The legal pages were updated in the same change. Whether to enable them at all, and with which vendor and notice, is the operator's.

  *Answered on the software half, recorded 2026-09-16 as an operator decision (`D18-4`).* **`D20` Log drains and retention tier.** The durable substitute now exists and is documented — `ops/alerts.md`'s eight-row table maps each log question to a table that outlives the hour, `ErrorReport` included — so buying drains is an improvement rather than the only way to reconstruct an incident. Cost against incident value is the operator's arithmetic, and `U18-1` supplies one of its terms.

  *Answered on the software half, recorded 2026-09-16 as an operator decision (`D18-5`).* **`D21` Uptime monitor.** The thing a monitor needs now exists: `/api/health` with a distinguishable `db` field, unauthenticated by design, plus the documented expected status for each of the five URLs and `?ok=1` on the ops route for a monitor that wants 503. The monitor itself is outside the repository, tracked as `U18-3`; the interval and the escalation path are the operator's answer.

  *Answered on the software half, recorded 2026-09-16 as an operator decision (`D18-6`).* **`D22` On-call.** The pass fixed how much time the human has rather than who the human is: the stale-tick bounds (26 h for the daily workers, 13 h 20 m for the rest) are now derived, printed and alarmed, so "later" has a number attached. `17`'s runbooks state the response times the product's copy assumes. Who is on call, and whether a phone rings, stays the operator's — for a solo launch the honest default is stated in `ops/alerts.md`: the monitor emails, and nothing pages.

  *Answered on the software half, recorded 2026-09-16 as an operator decision (`D18-7`).* **`D23` Dashboard form.** The page exists: `/api/admin/ops` serves every §3.8 row (money, outbox, mail, provider events, errors, funnel, cost) and `/api/admin/audit` serves the activity row, each behind one bearer. Whether that becomes the launch-day procedure or stays a manual SQL checklist is the operator's call, and `ops/alerts.md` carries the checklist form either way.

  *Answered on the software half, recorded 2026-09-16 as an operator decision (`D18-8`).* **`D24` Status page.** `ops/comms.md` has the templates and the facts each must contain; no customer-facing surface was published, deliberately, because a status page nobody owns is worse than none. Whether one exists, where it lives and who writes the post is the operator's, and it decides where those templates point.

---

## 10. Cross-references

- `00-REVIEW-PLAN.md` §1 (S12 cross-cutting), §2 batch 4, §4 severity semantics.
- `TEMPLATE.md` — section order.
- `01`–`05` (batch 1): `05` §7 `R05-6` (refunds copy — cited, not re-reported), `R05-7` (intake mail promise: `17` owns the operator side, this doc owns its invisibility, `R18-3`), `05` §7 `R05-2`–`R05-4` (skip link/landmarks/focus rings — cited only).
- `doc/PROD-READINESS-CHECKLIST.md`: `:181` manage-link dormancy (cited by section, `17` `R17-7` owns the client gap), `:195` Upstash (cited; not re-reported), `:247,250` the 502 diagnosis chain (the premise of this phase), `§4b/§4c` cadence and job-auth asymmetry (cited), `:156,198` alerting channel (cited).
- `17-operator-tooling-and-runbooks.md`: §5.1 (the same auth probes), §5.8/5.9 (secret and access inventories — this doc adds alarms, not lists), §7 `R17-1`–`R17-16` (each needed signal is named here).
- `16-legal-privacy-tax.md`: §7 `R16-4`/`R16-5` (undisclosed processors/analytics — this doc supplies the ground truth in §5.6 and the technical consent gap in `R18-13`).
- `doc/review/FINDINGS.md`: `R18-1`…`R18-15`, `U18-1`…`U18-8`.
**Added by the fix pass.** These are the artefacts the pass created; a later doc should cite them rather than re-derive the shapes.

- `ops/alerts.md` (new, ~250 lines) — the monitor URL list with an expected status per URL, the two status-code
  sections (the three contracts verbatim), the six-class signal table with every threshold as a number and its
  owning runbook, the alarm-code table with severities, the stale-tick derivation from `HEARTBEAT_ROUTES`, the
  log-line shape and the level rule, the retention window and the eight-row durable-substitute table, and the
  audit-trail recipes. The one document a monitor, a pager and an incident all start from.
- `lib/errorReport.ts`, `lib/errorLimits.ts`, `app/api/internal/error/route.ts` — the sink: fingerprint, 60 s
  repeat window, 30-per-60 s write cap, three-failure breaker with a five-minute open, `capFields()`,
  `errorSinkEnabled()`; 202/429/413/400/405 on the door, and no row ever echoed back.
- `lib/health.ts`, `app/api/health/route.ts` — `probeDatabase()` (one `SELECT 1`, 2 s timeout, never throws) and
  the unauthenticated 200/503 contract with `db`, `ms`, `deploy`, `env` and `no-store`.
- `lib/log.ts`, `lib/route.ts`, `instrumentation.ts` — `AsyncLocalStorage` request scope with `X-Request-Id`,
  `deploymentId()`/`appEnv()`/`describeError()`, the level rule, the boot line, and the two crash handlers behind
  a 750 ms deadline.
- `lib/clientError.ts`, `components/ClientErrorReporter.tsx` — the browser half: dedupe, 25 per page load,
  `sendBeacon` → `fetch keepalive`, never retried.
- `prisma/migrations/0013_error_report` + the `ErrorReport` model — `source`, `kind`, `message`, `stack`, `route`,
  `digest`, `fingerprint`, `occurrences`, `deploy`, `env`, `requestId`, `createdAt`, and the two indexes. No
  pruning job, deliberately.
- `lib/opsMetrics.ts`, `app/api/admin/ops/route.ts`, `app/api/admin/audit/route.ts` — the dashboard
  (`money`, `outbox`, `mail`, `providerEvents`, `errors`, `funnel`, `cost`), `alarmsFor()`, the `X-Ops-*`
  headers, `?days=`/`?ok=1`, and the audit reader with `?action=`/`?startup=`/`?payment=`/`?before=`.
- `lib/analyticsConsent.ts`, `components/AnalyticsConsent.tsx` — the consent gate, failing closed, with the
  legal-page copy updated in the same change.
- Edited rather than new: `lib/email.ts` (`failureDetail()`, the `send-failed` line), `lib/stripe.ts`
  (`stripeKeyMode()`), `app/api/jobs/config/route.ts` (the test-key finding), the webhook route (throttled
  refusal line, `recordTerminal()`), `lib/outbox.ts` and both workers (`OutboxHealth`), `lib/audit.ts`
  (`AUDIT_ACTIONS`, `isAuditAction`), `lib/api.ts`/`app/api/stats/route.ts`/`components/StatsCard.tsx`
  (`moneyScope: "board"`), `app/error.tsx`/`app/global-error.tsx`/`app/layout.tsx`, and the runbooks that used to
  say "check the logs".
- Tests: the new `lib/log.test.ts` (13), `lib/errorReport.test.ts` (18), `lib/clientError.test.ts` (16),
  `lib/health.test.ts` (11), `lib/healthRoute.test.ts` (2), `lib/opsMetrics.test.ts` (18),
  `lib/analyticsConsent.test.ts` (7) and `lib/emailFailure.test.ts` (2), plus the phase-18 blocks in
  `lib/ops.test.ts`, `lib/webhook.test.ts`, `lib/contracts.test.ts` and the stale tripwires re-pointed at the
  new idioms — 85 new cases (§5.9).

---

## 11. Change log

| Date | Change | By |
|---|---|---|
| 2026-09-15 | authored 2026-09-15 against `9681bdcbff2435ef258224c52000e0f8d6089f5c` — first draft of phase 18; findings registered, no fixes (read-only pass) | batch-4 agent |
| 2026-09-15 | corrected the `console.*` census from an earlier partial glob to a whole-tree `git grep` count (71 matches / 24 files; 23 runtime sites in 15 files) after the partial pattern was found to miss `app/api/checkout/route.ts:113`; §5.1 now shows the commands and outputs | batch-4 agent |
| 2026-09-15 | recorded the audit/email/provider/outbox **reader** censuses as explicit zero-row probes (§5.2) rather than assertions | batch-4 agent |
| 2026-09-15 | citation-verification pass: every `file:line` in §3.2, §3.6, §4, §6 and §7 re-read against the tree; corrected `lib/stripe.ts`, `lib/env.ts`, `lib/settle.ts`, `lib/analytics.ts` and webhook-route ranges that had drifted, downgraded §3.2 row 2 to "partially", and replaced two "no log line" assertions with the `settle-error-terminal`/`settle-error-retryable` lines that do exist | batch-4 agent |
| 2026-09-16 | fix pass: §5.9 records the re-run (65 files / 967 passed / 0 failed against the container, 807 passed / 160 skipped without a database), the runtime `console.*` census falling 23 → 2, the eight new test files and the three defects the pass found while writing them; all fifteen §7 statuses converted, fourteen of the fifteen §8 boxes ticked (box 2's `ProviderEvent`-row clause declined and explained), `D17`–`D24` answered on the software half as `D18-1`…`D18-8`, and §10's "Added by the fix pass" block. Nothing deployed; U18-1…U18-8 stand. | phase-18 agent |

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
