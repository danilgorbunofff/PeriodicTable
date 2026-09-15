# 10 — Email and notifications

| Field | Value |
| --- | --- |
| Phase · batch | 10 · 2 |
| Status | draft |
| Date reviewed | 2026-09-15 |
| Commit reviewed | `9681bdcbff2435ef258224c52000e0f8d6089f5c` |
| Reviewer | review agent |

**How this doc was produced.** A scratch Postgres 16 container (`ptl-review-batch2-pg`, host port 55499) was migrated 0000–0006 and seeded, and dev servers were started from **isolated copies** of the checkout (`%TEMP%\ptl-b2\s*`, `node_modules` junctioned) on ports 3206–3214 — one copy per server, because two `next dev` processes sharing one `.next` corrupt each other's route manifest and produce phantom 404s. Every send below is one the running code really made: the messages in the inventory were produced by real payments (`lib/settle.ts:203-249`), by a real report, and by real waitlist joins, then read back from `EmailLog` and `OutboxEvent` with `psql`. The manage-link chain (`_b2doc10a.mjs`) and the preview/jobs probes (`_b2doc10b.mjs`) are dated below. Because no `.env` exists in this checkout and no `RESEND_API_KEY` is available, **every message in this doc was delivered by the `"logged"` branch of `lib/email.ts:41`** — the pipeline, the queue, the dedupe keys, the template rendering and the failure handling are the real code paths; the wire, the DNS and the spam folder are not observable from here, which is what §12 records. The two probe scripts are scratch files that sat at the repository root and were deleted after the pass; §5.4 and §5.5 date and transcribe their requests and responses.

| Probe not run | Why | Residue |
| --- | --- | --- |
| A **real** Resend delivery | No `RESEND_API_KEY` in this checkout, and sourcing one is not read-only work | None — every send took the `"logged"` branch (`lib/email.ts:41`) |
| Deliverability (SPF/DKIM/DMARC, spam placement, from-name rendering) | Needs the DNS zone and a real inbox; neither is reachable from here | None — U10-1, U10-2 |
| A **genuinely** doubled send | The one structural double-send window is a crash between `lib/outbox.ts:130` and `:131`; reproducing it means killing a process mid-fetch | None — the window is stated from the code, the observed run had `attempts = 0` on every row |
| Bounce/complaint readings | Requires the Resend dashboard (or its webhook, which does not exist — R10-7) | None — U10-4 |
| The production value of the mail variables | Production env is not readable from this checkout; `doc/PROD-READINESS-CHECKLIST.md` §5 covers provider and database variables, not `RESEND_API_KEY`/`EMAIL_FROM` beyond recording them as required | None — U10-3 |
| A production `/api/jobs/config` read | Non-production rehearsal answers without a secret; production answers `401` and needs credentials this checkout does not have | None — R10-1's "nothing reports it" is stated from the reported key set, measured live |

## 1. Scope

**Owns.** Plan §1 **S8 × L6 and L7**: every message the product sends, when it is sent, who receives it, whether it can be sent twice, whether the recipient can stop it, and whether what it says is true. Paths inspected: `lib/email.ts` whole (182 lines); `lib/outbox.ts` whole (≈200); `emails/escape.ts`, `emails/receipt.tsx`, `emails/outbid.tsx`, `emails/report.tsx`, `emails/waitlist.tsx` whole; `app/api/jobs/outbox/route.ts`; `app/api/emails/preview/route.ts`; `app/api/unsubscribe/route.ts`; `app/api/waitlist/route.ts`; `app/api/manage/request/route.ts`, `app/api/manage/verify/route.ts`, `lib/manage.ts`; `app/api/startups/[domain]/route.ts`; `app/api/admin/outbox/retry/route.ts`; `app/api/report/route.ts:40-80`; `lib/settle.ts:196-262`; `vercel.json`; `prisma/schema.prisma:258-282,365-376`; `ops/takedown.md:36-41`.

**Does not own.** The money arithmetic that decides *which* mail is owed (`08`, `09` — cited, not re-opened); the report and waitlist intake forms and their validation (`05` §7 R05-7 settled that both send, this doc verifies the chain end-to-end rather than reporting it missing); the checkout copy that collects an address (`06` — `06` §7 R06-10 records that any string containing `@` is accepted, which is the input to this doc); the job-authentication model and cron wiring as a whole (`13` — this doc records only the mail consequence); whether a marketing message to a waitlist address satisfies consent/erasure law (`16`).

**The one-line answer to "what can go wrong with the mail".** Three classes, all observed. A **failure is invisible and unrecoverable** (R10-1: the send is marked complete, the documented retry refuses it, nothing counts errors). A **message that can reach or rewrite something it should not** (R10-2: an unverified manage token on any non-production deployment hands over a listing). And a **message that is not true** (R10-3/R10-4: the receipt's subject asserts #1 for a rank-2 buyer, and a reclaim receipt reports the top-up as the stake).

## 2. Actors

| Actor | Applies | What this phase must check for them |
| --- | --- | --- |
| Buying customer | yes | Whether the receipt arrives, whether it is true, and whether the "unsubscribe" link it carries does what it appears to do |
| Outbid holder | yes | Whether the reclaim figure and the reclaim link in the mail match what intake will accept (arithmetic: `09` §7 R09-5; delivery: here) |
| Reported subject | partly | Whether notice of a report reaches the moderation inbox and whether it leaks anything back to the reporter (`05`) |
| Waitlist joiner | yes | Whether the confirmation arrives and whether they can stop further mail without a listing |
| Operator | yes | Whether a failed delivery can be seen, retried and quantified before a customer complains |
| Attacker | yes | Whether an unverified address can obtain control of a listing, and whether an anonymous caller can make the product send mail |
| Mail provider (Resend) | yes | Whether its errors, bounces and complaints are received and stored |
| Mail-receiving infrastructure | yes | Whether the mail authenticates (SPF/DKIM/DMARC) and lands in the inbox — U10-1 |
| Future maintainer | yes | Whether adding a template also adds it to the suppression, retry and inventory paths |

## 3. Intended behaviour

### 3.1 The message inventory

Every message the product sends, as the code sends it (`lib/outbox.ts:90-122` is the dispatcher). "Suppression" is what prevents a send to an address that asked not to receive mail.

| # | Trigger | Template (`EmailLog.template`) | Recipient | Dedupe key | Suppression |
| --- | --- | --- | --- | --- | --- |
| 1 | A payment **settles** (`lib/settle.ts:203-221`) | `receipt` — `emails/receipt.tsx`, subject `receiptSubject` | `Payment.email` if present, else the listing's `Startup.email`; skipped entirely when both are null (`lib/settle.ts:206-207`) | `receipt-${paymentId}` (`lib/settle.ts:210`) | **None.** The token in the footer is `payer.unsubToken` (`:212`), i.e. the *listing's* token, not necessarily the address that received the mail |
| 2 | A settle **dethrones** a leader that has an address (`lib/settle.ts:221-238`) | `outbid` — `emails/outbid.tsx`, subject `outbidSubject` | `victim.email` — the listing that lost #1 | `outbid-${paymentId}` (`lib/settle.ts:227`) | **None**, but the mail carries the victim's own `unsubToken` (`:231`) and RFC 8058 headers, and nulling `Startup.email` does stop future outbid mail (`lib/settle.ts:223`) |
| 3 | A **report** is filed (`app/api/report/route.ts:60-80`) | `report` — `emails/report.tsx` | the moderation inbox from env | `report-mail:${report.id}` (`app/api/report/route.ts:72`) | Not applicable — one-off operational copy to the operator, no `List-Unsubscribe` by design (`lib/email.ts:140-141`) |
| 4 | A **waitlist join** (`app/api/waitlist/route.ts:56,59-70`) | `waitlist` — `emails/waitlist.tsx` | the address that joined | `waitlist-mail:${email}:${hour}` (`app/api/waitlist/route.ts:61`) | **None, and none possible**: no token is passed (`lib/email.ts:170`), so the message carries no `List-Unsubscribe` (`:47-54`), and the unsubscribe route cannot resolve a waitlist address at all (`app/api/unsubscribe/route.ts:33-38`) |
| 5 | Every settle (`lib/settle.ts:239-245`) | — (`PREVIEW_GENERATE`) | nobody — a Microlink screenshot job | `preview-${payer.id}` (`lib/settle.ts:242`) | n/a |
| 6 | Every settle (`lib/settle.ts:246-256`) | — (`STAKE_ANALYTICS`) | nobody; `lib/outbox.ts:115-118` completes the row with the comment "Marking complete = recorded" | `analytics-${paymentId}` (`lib/settle.ts:247`) | n/a |

Notes that matter to a support agent. Rows 1 and 2 are the only messages a customer receives, and **both fire from settlement, not from the checkout return** — a buyer who closes the tab before the redirect still gets the receipt if the payment settles (`lib/settle.ts:203-221`), and a buyer whose payment fails gets nothing. `EmailLog.detail` holds the *subject* for every one of these (`lib/email.ts:131,155,174`), so the operator's mail log reads like an inbox, not like a delivery report (R10-11). The receipt template accepts a `domain` prop (`emails/receipt.tsx:12`) that it never renders.

### 3.2 The delivery path and what "delivered" means

1. A trigger enqueues an `OutboxEvent` inside the same transaction as the money write (`lib/settle.ts:203-256`, `enqueueOutbox(tx, …)`) or outside any transaction for the non-money triggers (`app/api/waitlist/route.ts:61`, `app/api/report/route.ts:64-76`). `enqueueOutbox` **upserts on `dedupeKey`** (`lib/outbox.ts:64-70`; unique index `prisma/schema.prisma:273`, `prisma/migrations/0001_phase1_ownership/migration.sql:196`), so a replayed webhook cannot enqueue a second receipt: the second write is a no-op update of the same row. This is the mechanism that makes §3.1's "can it send twice" answer "not from a duplicate event".
2. Delivery is attempted twice-shaped: inline right after the trigger (`drainDueWithin`, `app/api/waitlist/route.ts:64`; the settle path calls its own bounded drain) and by a worker that claims due rows with `UPDATE … FOR UPDATE SKIP LOCKED` under a 5-minute lease (`lib/outbox.ts:154-171`, SQL at `:166-169`), reachable as `POST`/`GET /api/jobs/outbox` (`app/api/jobs/outbox/route.ts`) and scheduled daily at 04:00 UTC (`vercel.json`).
3. `processOutboxRowById` **skips** a row that is complete or has spent its 5 attempts (`lib/outbox.ts:128`), calls the type's sender (`:130`), and only then writes `completedAt` (`:131`). A **thrown** error increments `attempts`, sets `lastError` and schedules a backoff (`:133-144`, `backoffMs` `:73-75`, cap 1 h). A row that reaches 5 attempts is terminal and keeps `lastError` — which is what `ops/takedown.md:36-41` tells the operator to retry through `POST /api/admin/outbox/retry` (`app/api/admin/outbox/retry/route.ts:27-30`).
4. `deliver` (`lib/email.ts:35-71`) returns a status and **never throws**: `"logged"` when `RESEND_API_KEY` is absent (`:41`), `"sent"` on a 2xx (`:69`), `"error"` on a non-2xx **or** any exception, including its own 10-second timeout (`:58, :68, :70-72`). The senders log that status into `EmailLog` and return nothing (`:123-131`, `:148-155`, `:170-174`).

The consequence of step 4 meeting step 3 is R10-1, and it is the single most important thing in this doc: **the retry machinery can only be reached by an exception, but the mail path never raises one.**

### 3.3 What the recipient can do about it

`GET /api/unsubscribe?token=…` renders a confirmation form and **never mutates** (`app/api/unsubscribe/route.ts:18-29`); `POST` with the same token does the work — JSON body (`:44-51`) or form-encoded with the token in the query string for RFC 8058 one-click (`:53-70`), then redirects to `/?unsub=done`. An unknown or empty token returns the same `"unknown"` answer as a real one (`:31-38`), so the endpoint is not an address oracle. The mechanism is `Startup.email = null` — there is no suppression list, no `suppressed` status, no per-address preference and no self-service way back (R10-5).

## 4. The path, walked

A $5 join on a fresh element, as the messages see it.

1. `POST /api/checkout` writes a `PENDING` payment carrying the buyer's address (`app/api/checkout/route.ts`; the intake and its rejections are `06`).
2. `POST /api/dev/pay` (dev provider) settles it: `settlePayment` applies the stake, then enqueues four outbox rows in the same `MONEY_TX` (`lib/settle.ts:203-256`) with `receiptTo = payment.email ?? payer.email ?? null` (`:206`).
3. The bounded drain that follows the settle claims the receipt row and calls `sendReceiptEmail` (`lib/outbox.ts:130` → `lib/email.ts:113`). With no `RESEND_API_KEY`, `deliver` returns `"logged"` immediately (`:41`) and `logEmail` writes `EmailLog{template:"receipt", status:"logged", detail: subject}` (`:124-131`).
4. `completedAt` is stamped (`lib/outbox.ts:131`). The row and the log line are now the whole story: `OutboxEvent.dedupeKey = receipt-<paymentId>`, `EmailLog` with the same amount.
5. The outbid mail follows the same path when the settle dethroned someone with an address (`lib/settle.ts:221-238`), and only then — a dethroned holder who never supplied an address is never told (that path is `09` §7 R09-7; this doc records only that the mail is not even enqueued).

Walked live, end to end, with the row read back (observation `D`): join `Cl` at $5 → `EmailLog` `d1@d9-d.dev | receipt | Cl | 5 | logged | You're #1 in Cl (Chlorine) 🎉`. The claim was true: `d1` was rank 1.

## 5. Live evidence

### 5.1 The queue and the log at the end of the probe run (DB read, 2026-09-15)

| Read | Result |
| --- | --- |
| `EmailLog` by template/status | `outbid` 8 `logged`; `receipt` 30 `logged` **+ 1 `error`**; `report` 1 `logged`; `waitlist` 11 `logged` |
| `OutboxEvent` by type/state | `OUTBID_EMAIL` 8 done; `RECEIPT_EMAIL` 28 done; `WAITLIST_EMAIL` 11 done; `PREVIEW_GENERATE` 20 pending / 2 done; `STAKE_ANALYTICS` 28 pending / 1 done |
| Rows with `attempts > 0` | **zero** |
| Rows with `lastError` set | **zero** |
| `Payment` by status/provider | `paid` dev 26; `pending` dev 24, stripe 7, whop 1; `refunded` dev 4; `failed` dev 1 |

The two zeroes are the tell: across 39 email rows and 50 receipts' worth of enqueues, the retry path was never once exercised — including for the one delivery that failed.

### 5.2 The failed receipt (the finding that matters)

`EmailLog` has exactly one `error` row in the whole run:

```
probe3212@example.com | receipt | Fr | 5 | error | You're #1 in Fr (Francium) 🎉 | 2026-09-15 09:30:43.803
```

Its outbox row — `dedupeKey receipt-probe_prod_free_1` — reads **`completedAt` set, `attempts = 0`, `lastError` null**. So a delivery that failed is indistinguishable, to the queue and to any operator tooling, from one that succeeded. The documented repair path agrees with the wrong answer (probe, 2026-09-15):

```
POST /api/admin/outbox/retry {"dedupeKey":"receipt-probe_prod_free_1"}
 -> 409 {"error":"Already delivered.","code":"ALREADY_DONE"}
POST /api/admin/outbox/retry {"dedupeKey":"outbid-nonexistent-key"}
 -> 404 {"error":"Outbox event not found.","code":"NOT_FOUND"}
POST /api/admin/outbox/retry (no Authorization header)
 -> 403 {"error":"forbidden"}
```

`app/api/admin/outbox/retry/route.ts:27` refuses any row with `completedAt`, and `ops/takedown.md:36-41` documents that endpoint as *the* recovery for failed deliveries on the premise that "Terminal outbox failures keep `lastError` on the row". For this failure class that premise is false, and there is no second path: `app/api/jobs/config` reports only environment findings — measured live, its payload keys are exactly `ok, env, findings` (probe 2026-09-15, `503` with the `required` findings for `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL`, `TURNSTILE_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM` and the Upstash `degraded` finding) — so nothing counts failed mail or unretried rows.

### 5.3 The messages, read back (DB read)

| Mail | `EmailLog` row | True at the time? |
| --- | --- | --- |
| `d1@d9-d.dev` receipt `Cl` $5 | `You're #1 in Cl (Chlorine) 🎉` | Yes — `d1` was rank 1 |
| `x@d9-x.dev` receipt `Po` $5 (then unwound by `_b2rev.ts` in `09`) | `You're #1 in Po (Polonium) 🎉` | Yes when sent; the stake was later reversed and no message told the buyer (`08` §7 R08-2) |
| `z@d9-z.dev` receipt `Rn` **$2** `reclaim` | `You're #1 in Rn (Radon) 🎉` | **No** — the address's stake row held **$7** after the top-up (DB: `paid 2 / stake_total 7`), and the body reads "Your $2 stake puts you #… on Rn" (R10-4) |
| `e2@d9-e.dev` receipt `Er` **$6** | `You're #1 in Er (Erbium) 🎉` | **No** — the stale take landed at **rank 2** (`09` §7 R09-2, run `W`); the subject says #1, the body's `#${rank}` says otherwise (R10-3) |
| `e3@d9-e.dev` receipt `Er` **$7** | `You're #1 in Er (Erbium) 🎉` | Yes — the overtaking leader got the identical subject |
| `v1@d9-v.dev` / `v2@d9-v.dev` receipts `Ho` $5 each | both `You're #1 in Ho (Holmium) 🎉` | Both settled a tie at rank 1 and rank 2 (`09` §7 R09-3, run `V`) — the second is false |
| `e1@d9-e.dev` outbid `Er`, reclaim $3 | `You were knocked off Er 👑` | Yes as a statement; the $3 figure is the reclaim quote from `lib/links.ts:17-23`, whose floor/expiry gap is `09` §7 R09-5 |

The receipt's rank-only-in-the-body design means **the mail contradicts itself** whenever `rank !== 1`, and `lib/settle.ts:220` passes the true rank to the template — the subject simply does not read it (`lib/email.ts:114`, `emails/receipt.tsx:16-18`).

### 5.4 The manage-link chain (`_b2doc10a.mjs`, 2026-09-15T10:25:30.711Z → 10:25:35.686Z)

Run against 3206 (dev provider mode, `PAYMENTS_LIVE=true`, scratch database, `Startup.ladder-b.dev` a normal seeded listing).

| Step | Request | Result |
| --- | --- | --- |
| M1 | `POST /api/manage/request {"domain":"does-not-exist.dev","email":"attacker@d10.dev"}` | `200 {"ok":true,"note":"Listing management is not enabled — your listing is set at checkout and is final."}` — no token (no oracle) |
| M2 | `POST /api/manage/request {"domain":"ladder-b.dev","email":"attacker@d10.dev"}` | `200 {"ok":true,"note":"…same note…","debugToken":"7d8ef7da…(64 hex)"}` — a token for a domain the caller does not control, issued to an address that is not the listing's |
| M3 | `POST /api/manage/verify {"token":"7d8ef7da…"}` | `200 {"ok":true,"domain":"ladder-b.dev"}`, `Set-Cookie: ptl_manage=…` |
| M4 | `PATCH /api/startups/ladder-b.dev` with that cookie, body `{"title":"Taken over by d10 probe","url":"https://attacker.d10.dev","email":"attacker@d10.dev", …}` | `200 {"ok":true,"domain":"ladder-b.dev"}` |
| M5 | DB read | `Startup ladder-b.dev` — `title = "Taken over by d10 probe"`, `email = "attacker@d10.dev"`, `url = "https://attacker.d10.dev/"`; `AuditLog` `MANAGE_LINK_REQUESTED | system | attacker@d10.dev | 10:25:34.632` then `PROFILE_UPDATED | owner | title,pitch,url,linkType,email | 10:25:35.686`; `ManageToken` count 3 |

Nothing in this chain touched an inbox: the token came back in the response body, not in mail. The audit trail reads as legitimate owner activity (`actorType: "owner"`, `lib/manage.ts:88` and `app/api/startups/[domain]/route.ts:62`), which is why the takeover is quiet.

### 5.5 The preview route and the job endpoints (`_b2doc10b.mjs`, 10:28:27.193Z → 10:28:27.332Z)

| Request | Result |
| --- | --- |
| `GET /api/emails/preview` (no params — the documented default template is `outbid`) | **`500`**, `x-subject-preview: null`, **empty body** |
| `GET /api/emails/preview?template=receipt&sym=C` | `200`, 1,179 bytes, contains `<h1>` |
| `GET /api/emails/preview?template=receipt&sym=<img src=x onerror=alert(1)>` | **`200` with the tag reflected raw** |
| `GET /api/emails/preview?template=outbid&sym=<b>x</b>` | **`500`** (same crash as the default) |
| `GET /api/jobs/outbox` with **no** `Authorization` and **no** secret | `200 {"ok":true,"claimed":5,"completed":5,"failed":0}` |
| `GET /api/jobs/config` with no secret | `503` + findings (`ok, env, findings` — §5.2) |

The 500 is not the template: it is the response *header*. `app/api/emails/preview/route.ts:44` sets `X-Subject-Preview` to the subject string, and `outbidSubject` contains `👑` (`emails/outbid.tsx:14-15`) — a header value that cannot be encoded, so the whole response dies before the body is written. The `receipt` subject carries `🎉` and would crash the same way if the route sent it as a header; it does not (`:44` is inside the `outbid` branch).

### 5.6 The waitlist and unsubscribe surfaces, verified rather than assumed

`POST /api/waitlist` stores one row per address (`upsert` on the unique `email`, `app/api/waitlist/route.ts:52-58`, refreshing `consentAt`), audits `WAITLIST_JOINED` with a hashed IP (`:55`), enqueues `WAITLIST_EMAIL` (`:61`), drains it inline within 3 s (`:64`) and swallows any failure so that intake cannot fail because a confirmation could not be sent (`:66-69`). 11 rows exist, all `logged`. The message carries no `List-Unsubscribe` (`lib/email.ts:170` passes no token) and the unsubscribe route cannot resolve a waitlist address (`app/api/unsubscribe/route.ts:33-38`), which is R10-6.

`GET /api/unsubscribe?token=…` renders a form and changes nothing; only `POST` acts. With no token the answer is the same `"unknown"` as with a wrong token. `05` §7 R05-7 settled that the report and waitlist intakes send mail, and this run confirms the chain end to end rather than reporting it missing: a filed report produced one `report` row and a drained `REPORT_EMAIL`; the moderation copy goes to the operator inbox with no unsubscribe header by design (`lib/email.ts:140-141`).

## 6. Failure and edge matrix

| Situation | What happens | Evidence |
| --- | --- | --- |
| Provider returns a non-2xx | `deliver` returns `"error"`; `EmailLog.status = "error"`; the outbox row is marked **complete**; no retry, no alert | `lib/email.ts:68,123-131`; `lib/outbox.ts:130-131`; §5.2 |
| Provider times out (10 s) | Same as above — the catch returns `"error"` rather than throwing | `lib/email.ts:58,70-72` |
| Sender throws (unknown outbox type) | `attempts + 1`, `lastError`, backoff up to 1 h, terminal at 5 attempts, retryable via the admin route | `lib/outbox.ts:119-120,133-144`; `:15` |
| Worker dies between send and `completedAt` | The row is still unclaimed-complete; a worker claims it after the 5-minute lease and **sends again**. Structural, never observed (all `attempts = 0`) | `lib/outbox.ts:130-131,166-169` |
| Duplicate webhook for one payment | No second receipt: the unique `dedupeKey` turns the second enqueue into a no-op | `lib/settle.ts:210`; `prisma/schema.prisma:273`; `08` §7 R08-1's replay |
| Same payment re-settled after a reversal | A second `receipt-<paymentId>` cannot be enqueued, so the buyer is told nothing about the reversal at all | `08` §7 R08-2 (`lib/settle.ts:389-392`) |
| Buyer gives no address | No receipt is enqueued at all (not a failed send) | `lib/settle.ts:206-207` |
| Buyer's address differs from the listing's | The receipt goes to the buyer, but the footer token is the **listing's** (`payer.unsubToken`) | `lib/settle.ts:212` |
| Buyer unsubscribes from a receipt | The *listing's* `Startup.email` is nulled; the receipt address itself keeps receiving, because the receipt reads `payment.email` first | `app/api/unsubscribe/route.ts:36`; `lib/settle.ts:206`; R10-5 |
| Outbid victim has no address | No mail, no other notice | `lib/settle.ts:222-223` (`09` §7 R09-7) |
| Waitlist address re-submits within the hour | Single mail (hour-bucketed key) | `app/api/waitlist/route.ts:61` |
| Waitlist address re-submits an hour later | **A second confirmation** — deliberate, per the comment "a genuinely later re-join still gets its own message" | `app/api/waitlist/route.ts:59-62` |
| Waitlist address wants to stop | Nothing in the product can stop it: no token, no suppression, no route | R10-6 |
| Address hard-bounces | The provider's reason is discarded; `EmailLog` keeps only `"error"`; nothing marks the address bad; it keeps receiving | `lib/email.ts:68`; R10-7 |
| Operator retries a failed receipt | `409 ALREADY_DONE` — the documented recovery refuses exactly this case | §5.2; `app/api/admin/outbox/retry/route.ts:27` |
| Anonymous caller drains the queue | Mail is delivered on demand wherever the job secret is not enforced | §5.5; R10-10 (`13` owns the model) |
| An attacker asks for a manage link to someone else's listing | A working token is returned in the response body wherever `isProduction()` is false | §5.4; R10-2 |
| A non-leader buys | Receipt subject asserts #1 while the body prints the true rank | §5.3; R10-3 |
| A reclaim settles | Receipt reports the top-up amount as "your stake" | §5.3; R10-4 |

## 7. Findings

### R10-1 — A failed delivery is marked delivered, and the documented retry refuses it

- **Severity.** P1
- **Category.** correctness
- **Evidence.** `lib/email.ts:68` (`if (!res.ok) return "error"`) and `:70-72` (`catch { return "error" }`) mean `deliver` never throws; `:123-131` logs that status and returns nothing; `lib/outbox.ts:130-131` stamps `completedAt` on any non-throwing return, while the retry machinery at `:133-144` is reachable only from a throw. Live: `EmailLog` `probe3212@example.com | receipt | Fr | 5 | error | 09:30:43.803` with its row `receipt-probe_prod_free_1` **completed, `attempts = 0`, `lastError` null**; `POST /api/admin/outbox/retry` on that key → **`409 ALREADY_DONE`** (2026-09-15). `ops/takedown.md:36-41` documents that endpoint as the recovery path and asserts the premise ("Terminal outbox failures keep `lastError` on the row") that this row falsifies. `app/api/jobs/config` reports only `ok, env, findings` (live payload), so no surface counts unretried failures. Checked for the whole run: **zero** rows with `attempts > 0` or `lastError`.
- **Reproduction.** Send a receipt to an address the provider rejects (`RESEND_API_KEY` set, invalid recipient), then read `OutboxEvent.lastError` (null) and call the retry route with its `dedupeKey` (`409`).
- **Proposed fix.** Let a failed send reach the retry path: have the senders return `deliver`'s status (`lib/email.ts:123-131`, `:148-155`, `:170-174`) and have `handleOne` throw on `"error"`, so `lib/outbox.ts:133-144` applies the existing backoff; make `app/api/admin/outbox/retry/route.ts:27` treat `completedAt && attempts === 0 && EmailLog.status === "error"` as retryable instead of `ALREADY_DONE`; add a failed-mail count (and the oldest unretried key) to the `/api/jobs/config` payload so the operator has a surface for it; correct `ops/takedown.md:36-41`. Test: `lib/outbox.test.ts` — a sender returning `"error"` must leave `attempts = 1` and `lastError` set, and the admin retry must accept that row.
- **Status.** open

### R10-2 — An unverified manage token takes over any listing on a non-production deployment

- **Severity.** P0
- **Category.** security
- **Evidence.** `lib/manage.ts:46-61` mints a token for **whatever address the caller supplies** — it is never compared with `Startup.email` — then `:64` returns it in the response body whenever `!isProduction()`, and `lib/env.ts:31-33` defines `isProduction()` as the app-env string, so a preview deployment is "not production". That deployment class points at the production database per `doc/PROD-READINESS-CHECKLIST.md` l.16 (`DATABASE_URL` scoped Production, Preview). The write side is `app/api/startups/[domain]/route.ts:22-24` (a manage cookie for the same domain) and `:53-56` (the `email` field, i.e. the notification address, is writable by the session holder). Live chain `M1`–`M5` (§5.4): a stranger obtained a 64-hex token for `ladder-b.dev`, exchanged it for a session, and rewrote title/url/email in one `PATCH` (`200`), with `AuditLog` rows reading `MANAGE_LINK_REQUESTED | system | attacker@d10.dev` then `PROFILE_UPDATED | owner`. The module's own header (`:1-18`) states the intent — "BACKEND ONLY: NOT SHIPPED IN v1 … production never emails the link" and "Raw tokens are returned … ONLY outside production (dev convenience)" — so the code matches the letter of its note while the reachable class is wider than the note's intent.
- **Reproduction.** On any deployment whose app env is not `production` and whose `DATABASE_URL` is the production one: `POST /api/manage/request` with a listed domain and an address you control, take `debugToken` from the JSON, `POST /api/manage/verify`, then `PATCH /api/startups/<domain>` with the cookie.
- **Proposed fix.** Do not return the raw token from anything that can be reached with a production database: gate `debugToken` on an explicit development check (`getAppEnv() === "development"`, not `!isProduction()`), and either delete the module until v2 or make the request path require the caller to control the listing's address and deliver the link by mail rather than in the response. Drop `email` from the PATCH body's writable set (`app/api/startups/[domain]/route.ts:53-56`) until `16`/`17` decide the notification-address model, and record an audit actor that distinguishes "token holder" from "verified owner" (`lib/manage.ts:88`, `app/api/startups/[domain]/route.ts:62`). Test: an integration test asserting that `requestManageToken` returns no `debugToken` when `getAppEnv()` is `preview` or `production`, and that a request from an address other than `Startup.email` issues nothing.
- **Status.** open

### R10-3 — The receipt subject says "#1" to buyers who are not #1

- **Severity.** P2
- **Category.** content
- **Evidence.** `emails/receipt.tsx:16-18` builds the subject from the symbol and element name only; `lib/email.ts:114` calls it without `rank`, although `:121` passes the true `rank` into the body, which prints `#${p.rank}` (`emails/receipt.tsx:27`) and the `#1` heading at `:25`. Live: `e2@d9-e.dev` paid $6 on `Er` and settled at **rank 2**, and its `EmailLog` row — whose `detail` *is* the subject (`lib/email.ts:131`) — reads `You're #1 in Er (Erbium) 🎉` (`09` §7 R09-2, run `W`); `v2@d9-v.dev` settled the second half of a tie at rank 2 with the same subject (`09` §7 R09-3, run `V`).
- **Reproduction.** Land a take that a newer leader overtakes before it settles, then read the buyer's mail: the subject claims the crown, the body prints `#2`.
- **Proposed fix.** Make the subject a function of the rank: `receiptSubject({elementSymbol, elementName, rank})` → `"You're #1 …"` only at rank 1, and an honest line otherwise (e.g. `"Your $X stake on C is live — you're #3"`); pass `rank` at `lib/email.ts:114`. Test: a unit test over the subject builder for rank 1, 2 and 3, plus a settle test asserting the enqueued payload's `rank` matches the row that settles.
- **Status.** open

### R10-4 — A reclaim receipt reports the top-up as the stake

- **Severity.** P2
- **Category.** content
- **Evidence.** `lib/settle.ts:218` passes `payment.amountUsd` — the amount of *this* payment — into the receipt; `emails/receipt.tsx:27` renders it as "Your $X stake puts you #N on <sym>". For a `reclaim` path the payment is only the increment. Live DB read: `z@d9-z.dev | Rn | paid 2 | stake_total 7 | path reclaim`, so the buyer holds $7 (the figure the rank was computed from and the figure an outbid/refund acts on, `lib/pricing.ts:14-17`) while the mail says "$2 stake". The same row also makes the subject false: rank 2 was reported as #1.
- **Reproduction.** Outbid a $5 holder on `Rn` with $6, then reclaim as that holder for the $2 the mail quotes, and read the receipt against `Stake.amountUsd`.
- **Proposed fix.** Send the resulting holding, not the increment — pass the applied stake's `amountUsd` (`result.stake.amountUsd`, already in scope at `lib/settle.ts:195-201`) and, when it differs from what was charged, say both ("$2 top-up — you now hold $7 on Rn"). Test: a settle test for the `reclaim` path asserting the receipt payload carries the post-apply total and the charged amount as separate fields.
- **Status.** open

### R10-5 — No suppression list: unsubscribe is irreversible, partial, and invisible

- **Severity.** P2
- **Category.** ops
- **Evidence.** `lib/email.ts:4` claims "Suppression + EmailLog always"; nothing in the repository implements suppression — `unsubscribedAt`, `suppress`, `isUnsubscribed` and `clearEmail` appear only in `app/api/unsubscribe/route.ts:31,50,66`. The implemented mechanism is one column: `Startup.email = null` (`:36`). Consequences, each measured or read from the code: (a) a receipt continues to reach a person who unsubscribed, because its recipient is `payment.email ?? payer.email` and the footer token it carries is the *listing's* (`lib/settle.ts:206-212`); (b) outbid mail stops **permanently and silently** for that listing (`lib/settle.ts:222-223` `if (victim?.email)`), so "I lost #1" is suppressed as a side effect of a preference about marketing; (c) `EmailLog.status = "suppressed"` is never written (schema `prisma/schema.prisma:365-376`; DB read: zero rows); (d) there is no way back: re-subscribing requires a manage session (`app/api/startups/[domain]/route.ts:53-56`), i.e. a magic link production never sends (R10-2, `lib/manage.ts:16-18`), and the unsubscribe page ends with a redirect and no confirmation of what will stop (`app/api/unsubscribe/route.ts:53-70`).
- **Reproduction.** Take a receipt's unsubscribe link, complete the POST, then buy again with the same address: the receipt arrives, and the outbid mail for that listing never does.
- **Proposed fix.** A real suppression list keyed by address (with a `suppressed` `EmailLog` status and the reason), consulted before every send, plus a self-service re-subscribe; and an explicit decision on transactional mail (see §9 Q1) instead of the current accident where a marketing preference disables the "you lost #1" notice. Test: a send to a suppressed address writes `EmailLog{status:"suppressed"}` and no provider call, and a re-subscribe clears it.
- **Status.** open

### R10-6 — The waitlist confirmation has no opt-out and cannot be suppressed

- **Severity.** P2
- **Category.** ops
- **Evidence.** `lib/email.ts:170` calls `deliver(to, subject, html)` with no `unsubToken`, so no `List-Unsubscribe` header is set (`:47-54`); `app/api/unsubscribe/route.ts:33-38` resolves tokens only through `Startup.unsubToken`, while a waitlist address lives in `WaitlistEntry` (`prisma/schema.prisma:258-265`), so a recipient has no route to stop the mail and the operator has no column to set. The message is the only confirmation the paused-checkout path promises (`app/api/waitlist/route.ts:59-62`), and its dedupe key is per address per hour (`:61`), so a repeat join an hour later sends again by design. Live: 11 `waitlist` rows, all `logged`. The report copy to the moderation inbox has the same absence and *should* (`lib/email.ts:140-141`): it is a one-off operational message, not a list — the difference between the two is a product decision currently made by omission for the waitlist.
- **Reproduction.** Join the waitlist, then look for any way to stop mail from that address without a listing (there is none), and inspect the message headers for `List-Unsubscribe` (absent).
- **Proposed fix.** Give waitlist entries their own opaque unsubscribe token (or resolve a signed address) and route them through the same suppression check as everything else; keep the hour-bucketed dedupe for loop protection but record the lifetime send count per address so a repeat join is a decision rather than an accident. Test: a waitlist mail must carry `List-Unsubscribe` and its token must null/flag the `WaitlistEntry`.
- **Status.** open

### R10-7 — A bounce or complaint has nowhere to land

- **Severity.** P2
- **Category.** ops
- **Evidence.** There is no provider webhook: the only reference to the provider's API in the repository is the send call (`lib/email.ts:46`), and `app/api` contains no Resend endpoint. `deliver` reads only `res.ok` (`:68`), discarding the provider's status code and body, so "invalid recipient" and "rate limited" are the same `"error"` with no reason. `EmailLog` is insert-only — `logEmail` creates and nothing in the repository ever updates it (`:15-33`) — so a later bounce cannot be recorded, and `EmailLog` has no field for a provider message id to correlate one (`prisma/schema.prisma:365-376`). Live: the single failed row kept no reason, and zero rows carry `lastError` (§5.1). Consequence: an address that hard-bounces keeps receiving until somebody reads the provider dashboard, which this checkout cannot reach.
- **Reproduction.** Send to an address the provider rejects at the receiving MX (not at send time) and look for any record of the bounce in the database or any alert.
- **Proposed fix.** Preserve the provider's status and body in `EmailLog.detail` (or a new `error` column) and store the provider message id, then add a bounce/complaint webhook that marks the address suppressed (depends on R10-5). Test: a non-2xx send records the provider status and body; a simulated bounce webhook flips the address to suppressed.
- **Status.** open

### R10-8 — The email preview route 500s on its own default template

- **Severity.** P3
- **Category.** correctness
- **Evidence.** `app/api/emails/preview/route.ts:44` puts the subject string into the `X-Subject-Preview` response header; the default template is `outbid`, whose subject contains `👑` (`emails/outbid.tsx:14-15`), which cannot be encoded into a header, so the response dies before its body is written — live `500`, `x-subject-preview: null`, empty body, while `?template=receipt` (a `🎉` subject that the route does not put in a header) answers `200` with 1,179 bytes (§5.5). The route's gate is `process.env.NODE_ENV === "production"` (`:7-9`), not the app-env check the sibling preview surfaces use, so the behaviour is decided by how the process was started rather than where it points: a production-flagged `next dev` on 3212 answered `500` rather than the `404` the gate implies.
- **Reproduction.** `curl -sS -D - "http://<host>/api/emails/preview"` → `500` with no `X-Subject-Preview`; `?template=receipt&sym=C` → `200`.
- **Proposed fix.** Drop the header or strip it to ASCII (`subject.replace(/[^\x20-\x7E]/g, "")`), and gate the route on the same app-env predicate as `app/pay/[paymentId]/page.tsx` (`05` §7 R05-8 settled the provider-mode gate) so the whole family answers `404` in production rather than depending on `NODE_ENV`. Test: a route test asserting `200` for the default template and `404` under the production app env.
- **Status.** open

### R10-9 — Two templates interpolate unescaped, and the preview route reflects

- **Severity.** P3
- **Category.** security
- **Evidence.** `emails/escape.ts:8` exists and is used by `report.tsx` (`:34`, `:37`) and `waitlist.tsx` (`:19`), but `receipt.tsx:25,27,30,33` and `outbid.tsx:23,25,26,28,31` interpolate `${…}` values raw. Live: `GET /api/emails/preview?template=receipt&sym=<img src=x onerror=alert(1)>` → `200` with the tag reflected into the HTML (§5.5). Reachability of a *hostile* value into the real senders is currently narrow: the symbol is a database identifier chosen by the settler, and the domain reaches `viewUrl`/`reclaimUrl` through `encodeURIComponent` (`lib/email.ts:118`, `lib/links.ts:17-23`). But the pattern is one user-controlled field away from sending arbitrary markup to a customer's client, and the preview route demonstrates that no layer removes it.
- **Reproduction.** The preview request above; for the real templates, grep the props for any non-canonical source.
- **Proposed fix.** Route every interpolation in all four templates through `emails/escape.ts`, including `elementSymbol`, `elementName` and any future domain/reason field; keep the preview route's `sym` as a canonical-symbol lookup rather than free text. Test: a template test asserting a `<`-bearing prop cannot produce a tag, mirroring the existing report/waitlist escaping tests.
- **Status.** open

### R10-10 — Anyone can drain the mail queue where the job secret is not enforced

- **Severity.** P3
- **Category.** ops
- **Evidence.** Live: `GET /api/jobs/outbox` with no `Authorization` header and no secret → `200 {"ok":true,"claimed":5,"completed":5,"failed":0}` (§5.5) — the route's `GET` is the POST handler and `jobAuth` rehearses outside production (`lib/jobs.ts`; the same rehearsal is recorded in `doc/PROD-READINESS-CHECKLIST.md` l.158 for a secret-carrying call). Mail consequence: an anonymous caller can cause real mail to be delivered on demand — the buyer's receipt and the outbid notice — by driving `processOutboxRowById` (`lib/outbox.ts:126-146`) against whatever database the process points at. The drain itself is bounded (1–25 rows, 20 s deadline) and cannot double-send a completed row.
- **Reproduction.** `curl -sS "http://<host>/api/jobs/outbox"` on a non-production process.
- **Proposed fix.** Owned by `13` as an authentication decision (the job family should fail closed regardless of environment, or be bound to a loopback/host check); this doc's requirement is only that no unauthenticated caller can make the product send mail. Test: an unauthenticated `GET`/`POST` answers `401` in every environment.
- **Status.** open

### R10-11 — `EmailLog` cannot say which payment a message belonged to

- **Severity.** P3
- **Category.** data
- **Evidence.** `prisma/schema.prisma:365-376`: `EmailLog` has `to`, `template`, `elementSymbol`, `amountUsd`, `status`, `detail`, `createdAt` — no `paymentId`, no provider message id, no `updatedAt`, and `to` is stored in the clear with no retention note. `detail` is set to the subject by all four senders (`lib/email.ts:114,131,155,174`), so the only free-text column duplicates the subject (this is why §5.3's false subjects are also the operator's record). The `template` comment enumerates `outbid | receipt` while the senders write four templates (`report`, `waitlist`). Live: 50 rows, answers to "which payment was this?" only derivable by matching amount + symbol + timestamp by hand.
- **Reproduction.** Ask the log "which payment produced this receipt" for the `Er` rows and answer it without joining `Payment` on time and amount.
- **Proposed fix.** Store the outbox `dedupeKey` (which contains the payment id — `receipt-${paymentId}`) or a `paymentId` column, the provider message id (R10-7), and a documented retention window for addresses; correct the schema comment. Test: a send writes the dedupe key into `EmailLog`.
- **Status.** open

## 8. Acceptance criteria

- [x] Every message the product can send appears in §3.1 with trigger, template, recipient, dedupe key and suppression rule, each cited.
- [x] The delivery path (`enqueue` → `claim` → `send` → `complete`) is walked with line references and one live end-to-end send read back from the database.
- [x] Duplicate-event behaviour is stated and evidenced: a replayed settle cannot enqueue a second receipt (unique dedupe key, `08` §7 R08-1's replay).
- [x] The one structural double-send window (crash between send and `completedAt`) is named, with the observed `attempts = 0` showing it was never exercised.
- [x] The failed-delivery path was provoked for real, and the operator's documented recovery was called against it and answered `409`.
- [x] Each of the four templates was rendered (three observed via preview/DB rows, one by the preview route) and each claim it makes was checked against the row that produced it.
- [x] The unsubscribe mechanism is stated as implemented, with its two measured limits (receipt addresses, outbid mail) and its missing status.
- [x] `POST /api/manage/request` → `verify` → `PATCH` was exercised end to end on a seeded listing, with the database state and audit rows read back.
- [x] Deliverability is *not* claimed: §12 records it as UNKNOWN with the exact DNS and inbox steps that would settle it.
- [ ] A retry of a failed delivery actually re-sending (`R10-1`'s fix), and a suppression list actually stopping a send (`R10-5`) — both need the fix pass.

## 9. Open questions

1. **Is a receipt transactional or marketing?** Today the unsubscribe link in a receipt is the same mechanism as the outbid notice, so a click designed to stop "you lost #1" mail also fails to stop receipts (R10-5). The operator has to decide which messages are exempt from a suppression list, and the answer changes the copy in the footer of every mail.
2. **Should the manage module exist in this tree at all?** `lib/manage.ts:1-18` says it is dormant by design, and R10-2 shows that "dormant" depends on a deployment name. Deleting the module and its routes until the pages and delivery exist would remove the class outright; keeper-or-delete is an operator call, and it affects `17` (tooling) as well.
3. **Is the waitlist confirmation a marketing message?** It carries no opt-out because none exists (R10-6); whether the address needs a consent record beyond `WaitlistEntry.consentAt` (`app/api/waitlist/route.ts:52-57`) and a lawful erasure path belongs to `16`.
4. **Who watches failed mail?** R10-1's fix adds a count to the job config; whether that becomes an alert (mail, or the operator's existing channel) is a runbook decision for `13`/`17`.
5. **Should the outbid notice be a first-class notice rather than an email?** It is the only signal a dethroned holder gets, and it is optional-by-address (`09` §7 R09-7). If the product wants the reclaim behaviour the mail advertises, the notice may need to be on-site rather than in a template.

## 10. Cross-references

- `00-REVIEW-PLAN.md` §2 batch 2: this doc's spec (message inventory, double-send, unsubscribed addresses, untrue statements, UNKNOWN for deliverability).
- `05` §7 R05-7 — the report and waitlist intakes send mail; **verified here**, not reported missing. `05` §7 R05-8 — `/pay/[paymentId]`'s provider-mode gate, cited for R10-8's gate recommendation.
- `06` §7 R06-10 — any string containing `@` is accepted as a receipt address: the input to §3.1 row 1. `06` §7 R06-7 — a provider failure leaves an unreachable payment row and the buyer gets no mail at all.
- `08` §7 R08-1 (replay overwrites the applied record — the mechanism that makes dedupe necessary), R08-2 (a reversal sends the buyer nothing; `lib/settle.ts:389-392` states it is deliberate), R08-3 (nothing is scheduled for reconciliation; the same absence applies to mail health), R08-4 (dead and missing modules).
- `09` §7 R09-2 (the stale take that produced R10-3's false subject), R09-3 (the settled tie that produced the second false subject), R09-5 (the reclaim quote's floor/expiry, whose delivery is inventory row 2), R09-7 (a holder with no address is never told).
- `doc/PROD-READINESS-CHECKLIST.md` §5 (provider and mail variables as required), l.16 (`DATABASE_URL` scoped Production, Preview — the premise of R10-2), l.158 (job-secret rehearsal, cited for R10-10).
- `ops/takedown.md:36-41` — the failed-delivery runbook step that R10-1 corrects.
- `13` (job auth, cron cadence), `14` (the manage surface as an authentication story), `16` (consent, erasure, retention of `EmailLog.to`), `17` (operator surfaces for mail health).

## 11. Change log

- 2026-09-15 — authored 2026-09-15 against 9681bdcbff2435ef258224c52000e0f8d6089f5c. First pass: 12 sections, 11 findings (1 P0, 1 P1, 5 P2, 4 P3), 6 UNKNOWN rows. Evidence: two live probe scripts (`_b2doc10a.mjs`, `_b2doc10b.mjs`), `EmailLog`/`OutboxEvent`/`Payment` reads from the scratch database, the `/api/jobs/config` payload key set, and code reads across `lib/email.ts`, `lib/outbox.ts`, the four templates, `lib/manage.ts` and the mail-adjacent routes.

## 12. UNKNOWN log

| Id | Category | Unknown | What settles it |
| --- | --- | --- | --- |
| U10-1 | ops | Whether mail from `periodictable.lol` authenticates: SPF, DKIM (provider key), DMARC policy, and whether the provider's sending domain is verified. Nothing in this checkout can read the zone. | `dig +short TXT periodictable.lol`, `dig +short TXT <selector>._domainkey.periodictable.lol`, `dig +short TXT _dmarc.periodictable.lol`, plus the provider console's domain-verification status. Any of these showing no record is a deliverability defect regardless of the provider's own reporting. |
| U10-2 | ops | Whether a receipt, an outbid notice and a waitlist confirmation actually arrive, in which folder, and how the from-name and footer render. Needs a real inbox and a send that is not the `"logged"` branch. | Set `RESEND_API_KEY`/`EMAIL_FROM` on a non-production deployment, trigger one settle and one waitlist join against a real mailbox, then read the delivered message's source for `Authentication-Results` (SPF/DKIM/DMARC verdicts) and check the spam folder. The `EmailLog` rows for those sends give the provider-side status. |
| U10-3 | ops | Whether the production `EMAIL_FROM` is the default (`lib/email.ts:60`, `periodictable.lol <hi@periodictable.lol>`) or an explicit value, and whether `RESEND_API_KEY` is set at all — the difference between mail leaving the building and every send taking the `"logged"` branch (`:41`). The production environment is not readable from this checkout. | Read the production deployment's environment (`RESEND_API_KEY`, `EMAIL_FROM`) and the `required` findings of its `/api/jobs/config`; then send one message and confirm a provider message id exists. |
| U10-4 | ops | Whether any address hard-bounces or marks a message as spam today, and whether any production `EmailLog` row is already `error`. Without a bounce webhook (R10-7) the only source is the provider console or the production log table. | Provider console → the sending domain's bounce/complaint counts; and a production read of `SELECT status, count(*) FROM "EmailLog" GROUP BY 1` plus the rows where `status = 'error'`. |
| U10-5 | ops | Whether the manage-link disclosure (R10-2) has ever been used against a listing: any production `ManageToken`/`ManageSession` row, any `PROFILE_UPDATED` audit row whose actor was a token holder, and any unexplained customer-facing listing change. The scratch database cannot answer it. | Production reads: `SELECT count(*) FROM "ManageToken"`, `SELECT count(*) FROM "ManageSession"`, `SELECT * FROM "AuditLog" WHERE action IN ('MANAGE_LINK_REQUESTED','MANAGE_LINK_CONSUMED','PROFILE_UPDATED') ORDER BY "createdAt"`, cross-checked against owner reports of edited copy. |
| U10-6 | content | Whether the receipt's "watch 🟢 clicks delivered climb on your profile" (`emails/receipt.tsx:29`) is true as rendered: the profile page serves `200` and exposes `clicks` (`/s/ladder-b.dev`), but the label, the green dot and whether the number moves after a `/go` click were not verified this pass. | Buy a stake, click its tile once, and read `/s/<domain>` before and after: the counter must read one higher and carry the label the mail describes. |
