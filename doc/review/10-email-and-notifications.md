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

### 5.7 Fix verification

2026-09-16, this worktree, after the §11 fix pass. Like doc `08`'s pass and doc `09`'s and unlike
`06`'s and `07`'s, this one ran against a real Postgres: a fresh throwaway `postgres:16-alpine`
(`ptl-r10-pg`, host port 55501 — the `08`/`09` container on 55433 is still up beside it under colima)
with all nine migrations `0000`–`0008` applied (`prisma migrate deploy`), so every DB-gated suite this
doc's evidence came from executed instead of skipping — including the one this pass added, which is
the only place the pack's own worst defect was visible. The limits are the same ones §2–§5 record and
are not narrowed here: no provider and no inbox are reachable from this checkout, so a "send" is
either the `logged` branch (no `RESEND_API_KEY`) or a stubbed `fetch` that imitates Resend's answer,
and a webhook delivery is an Svix HMAC this checkout mints rather than a message the provider really
sent. U10-1…U10-6 stand.

```
TEST_DATABASE_URL=… npm run test:ci → 49 files passed (49); 712 passed, 0 failed, 0 skipped (712)
npx vitest run (no database)        → 43 passed, 6 skipped (49); 607 passed, 105 skipped (712)
npx tsc --noEmit                    → clean
npx eslint lib app emails           → clean (exit 0, no warnings or errors)
```

The first line is the CI-shaped run and satisfies CI's own gate (the workflow fails the build when the
log contains a skipped test; the grep against it finds nothing). The second is the shape §5.1–§5.6
were written from — 6 files and 105 tests skip there, every DB suite among them. The pass moved the
suite from `09`'s 680 to **712 tests** (+32), and the movement is nameable: `lib/suppression.test.ts`
(15, new — the first test `lib/email.ts`'s suppression model has ever had), `lib/emailPreview.test.ts`
(5, new), `lib/listingMail.test.ts` (3, new), `lib/unsubscribe.test.ts` (5 → 8), `lib/outbox.test.ts`
(10 → 13), `lib/manage.test.ts` (6 → 7), `lib/env.test.ts` (17 → 18), `lib/settle.test.ts` (24 → 25),
with `lib/moderation.test.ts` rewritten in place (10, its report-mail case now pins the `internal`
kind instead of the old header).

**Three defects the verification found, one of them the pack's own, in the product.** They are the
reason this section is longer than the ones before it.

- **A weaker suppression reason overwrote a stronger one (product, money-adjacent).** Found by the
  DB-gated run, not by reading: `lib/suppression.test.ts`'s precedence case expected
  `EmailLog{status:"suppressed:unsubscribe"}`-shaped behaviour after a bounce and read `logged`
  instead — `suppressEmail` replaced the stored reason unconditionally, so an address the provider had
  permanently refused (`bounce`, `invalid`) was promoted back to "list mail only" by a later
  unsubscribe, and the next money notice was attempted against a mailbox that cannot receive it. The
  fix keys the rule on the family `refuses` already documents rather than on arrival order:
  `UNDELIVERABLE_REASONS` (`lib/email.ts:62`), `isUndeliverable` (`:63`), `storedReason` (`:68`) and
  the guard at `:184-186`. This is the defect the DB half exists to catch: on a checkout with no
  database the whole assertion skips, so the `logged`/`suppressed` distinction is invisible — which is
  exactly the "checked where it runs" note `08` §5.10 and `09` §5.7 end on, now with a case.
- **A verifier test that signed what it claimed (test).** The Svix case for "the id in the header is
  not the id in the signature" signed `{ id: "msg_other" }` and then asserted against `msg_other`, so
  it proved nothing about replay of a *different* delivery. Repaired to sign one id and verify with
  another; the mismatch arm now fails when `verifyResendWebhook` stops comparing them.
- **`providerRef` reached a customer's inbox unescaped (product, R10-9's own checklist).** The pack's
  escaping pass covered the four templates' visible copy and missed the refund footer's payment
  reference, which is provider-supplied text printed raw (`emails/refund.tsx:43`). Now
  `esc(p.providerRef)`; `lib/listingMail.test.ts` renders a hostile reference, symbol, name and domain
  and asserts no tag survives.

**Coverage the pack claimed and did not have.** Five claims had no test at all before this pass:
the preview route's own surface (`lib/emailPreview.test.ts` — the default template's `200` and the
subject in a banner, the `TypeError` that proves the retired `X-Subject-Preview` header cannot come
back, all five templates reachable, the unknown-symbol note, and the gate: `404` under
`VERCEL_ENV=production` versus `200` under `preview` and under `NODE_ENV=production`, which is the
distinction R10-8 is about); the two subjects and the escaping of the listing mail
(`lib/listingMail.test.ts` — rank 1/2/3, the omitted rank defaulting to the crown, a body that does not
congratulate a rank its subject denied, and the hostile-value render); the retry route's revival arms
and the operator health count (`lib/outbox.test.ts` — a completed row with zero attempts and an
`EmailLog{status:"error"}` becomes retryable, a completed row with attempts is still `409
ALREADY_DONE`, an unknown key is `404`, and `failedMailHealth` counts only keys with no later
`sent`/`logged` row for the same address); and R10-4's payload (see below). Two assertions in the pack
were also repaired rather than added, both because the fix moved the fact they pinned
(`lib/moderation.test.ts`'s report-mail expectation, `lib/unsubscribe.test.ts`'s old single-token
world, which now has an address token, a legacy listing token and a re-subscribe action to tell
apart).

- **R10-1 — a failed send now fails its row, is retryable, and is countable.** `deliver` keeps the
  provider's status and truncated body (`lib/email.ts:422-471`, `providerStatus`/`error` on the log at
  `:411-421`), the senders return that outcome and `handleOne` throws on `"error"`
  (`lib/outbox.ts:143`), so the existing backoff applies instead of `completedAt`
  (`:231-248`, `OUTBOX_MAX_ATTEMPTS` at `:22`). The admin retry accepts exactly the historical shape —
  completed, `attempts === 0`, and an `EmailLog{status:"error"}` for the same key
  (`app/api/admin/outbox/retry/route.ts:38-56`) — and refuses every other completed row, so it cannot
  re-send a delivered mail. The operator surface is `mail: { failedCount, oldestUnretriedKey }` on
  `/api/jobs/config` (`app/api/jobs/config/route.ts:77-80`, `failedMailHealth` at `lib/outbox.ts:203`),
  and `ops/takedown.md:38-57` is corrected to describe the row the fix writes rather than the premise
  it falsified. Verified by three cases in `lib/outbox.test.ts` and one in `lib/env.test.ts`'s
  neighbours — the `error` sender leaves `attempts = 1` and `lastError` set, the retry revives it, the
  three `409`/`404` arms answer as documented, and the health count moves by exactly the delta of
  unresolved keys.
- **R10-2 — the manage token now requires the listing's own address, and the raw token is
  development-only.** `requestManageToken` compares the requested address with `Startup.email` and
  returns nothing when they differ (`lib/manage.ts:62-72`), audits the request as an owner with the
  address as actor instead of an anonymous `system` row (`:76`), and gates `debugToken` on
  `getAppEnv() === "development"` (`:82`) rather than `!isProduction()` — so a preview deployment
  pointed at the production database (the premise `doc/PROD-READINESS-CHECKLIST.md` l.16 records) has
  neither half of the M1–M5 chain. `email` is out of the PATCH body's writable set
  (`app/api/startups/[domain]/route.ts:47-49` answers the field-level error), which closes the
  notification-address rewrite independently of the token question. Verified in `lib/manage.test.ts`
  (6 → 7: the address that does not match the listing issues no token, and the matching one does) and
  `lib/env.test.ts` (`preview` and `production` both withhold `debugToken`).
- **R10-3 — the subject is a function of the settled rank.** `receiptSubject({ …, rank })` keeps
  `You're #1 in C (Carbon) 🎉` only at rank ≤ 1 and otherwise returns `You're #2 in C (Carbon)`
  (`emails/receipt.tsx:29-31`), which is the string `EmailLog.detail` now records, and the body's
  headline is the same call (`:35`) so the two cannot disagree. Verified for ranks 1, 2 and 3 and for
  the omitted-rank default in `lib/listingMail.test.ts`, and against a real settle (rank 2) in
  `lib/settle.test.ts`. This is the mail half of `15` §7 R15-8, whose row is doc `15`'s to flip.
- **R10-4 — the receipt reports the holding and the charge separately.** The payload carries the
  applied stake total (`lib/settle.ts:315-320`) and adds `topUpUsd` only when the charge differs from
  it (`:321`), so a reclaim says "$2 top-up — you now hold $7" instead of calling the increment the
  stake (`emails/receipt.tsx:44-46`). Verified in `lib/settle.test.ts` on a real two-buyer tile: a $5
  stake taken by a raider, then a $3 reclaim, asserts the applied total, the top-up, the rank 1 the
  total earned, and that a plain (non-top-up) receipt carries no such field.
- **R10-5 — there is a suppression list, keyed on the address, with a way back.** `EmailAddress`
  (`prisma/schema.prisma:431-442`) holds one row per address: `reason` is why we refuse it, `token` is
  the handle its messages carry, and the migration that creates it is
  `prisma/migrations/0008_email_notifications` — one transaction, with the `EmailLog` columns R10-1 and
  R10-7 need. Every send asks `suppressionFor` before the provider call and writes
  `EmailLog{status: "suppressed:<reason>"}` with no provider request when the reason refuses that kind
  of message (`lib/email.ts:396-410`, `suppressionStatus` at `:78`), so the status §5.1 found never
  written is now the log's answer for a refusal and is distinguishable from `logged`
  (`SUPPRESSION_REASONS` at `:58`, the preference split that R09-5/§9 Q1 needed in `refuses` at
  `:359`). The footer link is the *address's* token (`addressToken` `:113`, `unsubUrlFor` `:365`), so a
  receipt sent to `payment.email` on a listing with no address no longer carries a link that resolves
  to nothing; the unsubscribe route resolves both token kinds (`resolveUnsubTarget` `:135`), acts on
  them through `suppressEmail`/`unsuppressEmail` (`app/api/unsubscribe/route.ts:120-176`) with
  `?resubscribe=1` as the way back, audits both decisions (`EMAIL_UNSUBSCRIBED`/`EMAIL_RESUBSCRIBED`,
  `lib/audit.ts:39-40`) and says what will stop — receipts included — in the confirmation the home page
  shows (`app/page.tsx:176-178`). The four scenarios §5.1's DB read could only count are now assertions
  in `lib/suppression.test.ts` and `lib/unsubscribe.test.ts`: an unsubscribe stops a receipt, an
  address that bounces can no longer be revived by a later unsubscribe, a re-subscribe clears the row
  without forgetting the address, and no provider call is made for a refused send.
- **R10-6 — the waitlist confirmation carries an opt-out and can be suppressed.** The message now
  passes the address's own handle into the template and the `List-Unsubscribe` headers
  (`lib/email.ts:650-668`, footer link at `emails/waitlist.tsx:23-25`), and the join is recorded but
  not mailed when the address is suppressed (`app/api/waitlist/route.ts:45-52`) — the row keeps the
  join and `unsubscribedAt`, so the address that asked us to stop is not re-consented by a later
  submit. Verified in `lib/listingMail.test.ts` (the footer renders as a link) and
  `lib/suppression.test.ts` (a refused waitlist confirmation writes the suppressed status and makes no
  provider call).
- **R10-7 — a bounce or complaint lands, and the reason is on the table.** A new route,
  `app/api/webhooks/resend/route.ts`, verifies the Svix signature before parsing (`:72`,
  `verifyResendWebhook` at `lib/email.ts:230`, 5-minute tolerance at `:205`), answers `401` to anything
  unsigned, `400` to unparseable or untyped bodies and `200 {ok, ignored}` to a type the product does
  not act on (`RESEND_EVENT_TYPES`/`resendEventEffect` at `lib/email.ts:261-313`) — so an unauthenticated
  caller cannot make the product suppress an address, and a delivery we do not model is not a failure
  the provider retries. A suppression event writes the address's reason with the provider's own words
  truncated into `detail` and an `EMAIL_UNDELIVERABLE` audit row (`lib/audit.ts:42-46`); an event
  without a recipient is audited and otherwise ignored rather than dropping the delivery silently.
  `deliver` also keeps the provider's status and body (`:422-471`) so "invalid recipient" and "rate
  limited" are no longer the same `"error"`, and the email's message id is stored
  (`providerMessageId`, `prisma/schema.prisma:401`), which is what makes a later bounce
  correlatable at all. `RESEND_WEBHOOK_SECRET` is an `operator`-severity finding when unset
  (`lib/env.ts:179-183`, `.env.example:19`), because a route that fails closed is not the same as a
  bounce that lands. Verified at route level in `lib/suppression.test.ts`: a signed `email.bounced`
  suppresses the address, an unsigned one is `401` and changes nothing, a signed unknown type is
  `200 {ignored}`, a replayed signature outside the tolerance window is refused, and a signed
  non-suppressing event annotates the log without touching the address.
- **R10-8 — the preview route answers with a template, not a crash.** The subject moved out of the
  response header into the body's banner (`app/api/emails/preview/route.ts:106`), which is the fix for
  the `500`: the header could not carry `👑`. All five templates are reachable (`:51-92`), `sym` is a
  canonical lookup against `ELEMENTS` with `C` as the fallback and the mismatch named in the banner
  (`:44-47`) rather than reflected into the template, and the gate is the app-env predicate
  (`:38-41`), so the answer no longer depends on how the process was started. Verified by
  `lib/emailPreview.test.ts` (5 cases, including a `TypeError` from the retired header mechanism so it
  cannot be reintroduced quietly, and the `404`/`200` pair under the three environments).
- **R10-9 — every interpolation in the five templates goes through `esc`.** `receipt`, `outbid`,
  `refund` and `waitlist` now escape their text and property slots (`emails/receipt.tsx:45-51`,
  `emails/outbid.tsx:25,39`, `emails/refund.tsx:35-43`, `emails/waitlist.tsx:22`) and
  `refund.tsx:43`'s `providerRef` was the gap this verification found and closed. The URL slots
  (`viewUrl`, `reclaimUrl`, `unsubUrl`) are deliberately left alone: they are built with
  `encodeURIComponent`/`URL` at construction (`lib/links.ts`), and entity-escaping them would break
  the link rather than sanitize it. Verified by `lib/listingMail.test.ts`, which renders a hostile
  symbol, name and domain through the three listing templates and asserts no tag survives, and by
  `lib/emailPreview.test.ts`'s preview case for the same values.
- **R10-10 — not fixed here, deliberately.** The drain route's authentication is doc `13`'s decision
  (this doc's requirement is only that no unauthenticated caller can cause the product to send mail),
  and the pass left it exactly as §5.5 recorded it: `GET /api/jobs/outbox` still answers the POST
  handler's work wherever the job secret is not enforced. The row stays `open` and the §12 entry for it
  is unchanged; `13` owns the model.
- **R10-11 — the log can be joined to the queue and to the provider.** `EmailLog` now carries
  `dedupeKey` (the outbox row, which already contains the payment id for a receipt), `providerMessageId`,
  `providerStatus`, `error` and `updatedAt` (`prisma/schema.prisma:379-410`), every sender passes the
  key down (`lib/email.ts:415` and each sender's `dedupeKey`), and the schema's `template` comment
  lists the five templates the senders actually write. The retention question is not answered here —
  it belongs to `16` — and the row stays `open` for that half only: the correlatability half is fixed
  and cited in §7. Verified by `lib/outbox.test.ts` and `lib/suppression.test.ts`, both of which read
  back the log by key rather than by matching amount, symbol and timestamp by hand.

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

Observed before the fix pass, so its `file:line` citations are the locations at the time of the
observation — §7's **Fix** cells and the table below carry the current ones.

**After the fix pass** (§5.7), the rows whose behaviour or visibility changed:

| Situation | Current behaviour | What the recipient sees | What the operator sees |
| --- | --- | --- | --- |
| Provider returns a non-2xx or times out | the send fails *its row*: `attempts + 1`, `lastError`, then the existing backoff up to 1 h and a terminal stop at 5 attempts (`lib/outbox.ts:143,231-248`) | nothing arrives — unchanged, and the retry is what makes it arrive | the provider's own status and body on the failed `EmailLog` row (`providerStatus`/`error`), plus `mail: { failedCount, oldestUnretriedKey }` on `/api/jobs/config` — there is now a surface and a number |
| Operator retries a failed receipt | the historical row (completed, `attempts = 0`, an `EmailLog{status:"error"}` for the same key) is revivable; every other completed row is still `409 ALREADY_DONE`, so the route cannot re-send a delivered mail | the receipt, once | the retry is a normal attempt on the same row; nothing else in the queue moves |
| Buyer's address differs from the listing's | the footer token is the **buyer's** address (`addressToken`/`unsubUrlFor`, `lib/email.ts:113,365`), not the listing's | a link that resolves to their own preference, and unsubscribing stops the receipts they are getting | one `EmailAddress` row; the listing's ability to mail its own `Startup.email` is a separate row |
| Buyer unsubscribes from a receipt | the address is refused for `list` mail with reason `unsubscribe`; the next receipt is logged `suppressed:unsubscribe` and makes no provider call | mail stops, and the confirmation says receipts included; `?resubscribe=1` on the same page turns it back on, from any later message | `EMAIL_UNSUBSCRIBED`/`EMAIL_RESUBSCRIBED` audit rows, and a suppressed row distinguishable from `logged` |
| A marketing preference would have stopped "you lost #1" | it no longer does: `list` mail stops for any reason, `account`/`internal` only for `bounce`/`invalid` (`refuses`, `:359`) | the outbid notice still arrives to someone who opted out of marketing | the split is one function, and §9 Q1's answer is code rather than accident |
| Address hard-bounces or complains | the provider's event suppresses the address (`bounce`/`invalid`/`complaint`, `resendEventEffect`) — and a later, weaker reason cannot downgrade it (`:62-71,184-186`) | nothing more arrives at a mailbox that cannot receive it | `EMAIL_UNDELIVERABLE` audit rows with the provider's own words, and a `suppressed:<reason>` row per message refused |
| Address bounces *transiently* | audited, **not** suppressed | the mail keeps arriving once the mailbox accepts again | the event is in the log, with the bounce type — the pattern is visible without the address being written off |
| Waitlist address wants to stop | the confirmation carries the address's own token and `List-Unsubscribe`; stopping writes an `EmailAddress` row | a link that works, from the one mail that had none (`emails/waitlist.tsx:23-25`) | the `WaitlistEntry` keeps the join and `unsubscribedAt`; a later submit records the join without mailing |
| A non-leader buys / a reclaim settles | the subject and body report the settled rank, and a reclaim states the charge and the holding (`emails/receipt.tsx:29-31,44-46`) | `You're #2 in C (Carbon)`, and "$2 top-up — $8 now stands for you" | `EmailLog.detail` is that same subject, so the log's answer and the customer's agree |
| An attacker asks for a manage link to someone else's listing | no token is minted unless the address equals `Startup.email`, and the raw token is returned only in a `development` app env (`lib/manage.ts:62-72,82`) | a stranger gets the same "check your inbox" answer, and no mail | one `MANAGE_LINK_REQUESTED` row as the listing's owner, with the address as actor |
| `GET /api/emails/preview` | answers a template, with the subject in the banner; `404` under the production app env | — | a preview that works in a preview deployment and does not exist in production |
| Anonymous caller drains the queue | **unchanged** — still whatever `jobAuth` rehearses outside production | mail delivered on demand, still | unchanged; `13` owns the model, and R10-10 stays open |
| Worker dies between send and `completedAt` | **unchanged** — the row can still be claimed again after the 5-minute lease and send a second time. Structural, never observed; this pass did not add a send-side receipt | a duplicate is possible in exactly that window | the same; the `EmailLog` row is what says whether the first attempt reached the provider |
| Outbid victim with no `Startup.email` | the notice goes to the address on the payment that funded the stake, and its absence is no longer silent (`lib/settle.ts`, `09` §7 R09-7) | the outbid mail, at the address they typed at checkout | one `OUTBID_UNNOTIFIED` audit row when there is no address at all |

## 7. Findings

### R10-1 — A failed delivery is marked delivered, and the documented retry refuses it

- **Severity.** P1
- **Category.** correctness
- **Evidence.** `lib/email.ts:68` (`if (!res.ok) return "error"`) and `:70-72` (`catch { return "error" }`) mean `deliver` never throws; `:123-131` logs that status and returns nothing; `lib/outbox.ts:130-131` stamps `completedAt` on any non-throwing return, while the retry machinery at `:133-144` is reachable only from a throw. Live: `EmailLog` `probe3212@example.com | receipt | Fr | 5 | error | 09:30:43.803` with its row `receipt-probe_prod_free_1` **completed, `attempts = 0`, `lastError` null**; `POST /api/admin/outbox/retry` on that key → **`409 ALREADY_DONE`** (2026-09-15). `ops/takedown.md:36-41` documents that endpoint as the recovery path and asserts the premise ("Terminal outbox failures keep `lastError` on the row") that this row falsifies. `app/api/jobs/config` reports only `ok, env, findings` (live payload), so no surface counts unretried failures. Checked for the whole run: **zero** rows with `attempts > 0` or `lastError`.
- **Reproduction.** Send a receipt to an address the provider rejects (`RESEND_API_KEY` set, invalid recipient), then read `OutboxEvent.lastError` (null) and call the retry route with its `dedupeKey` (`409`).
- **Proposed fix.** Let a failed send reach the retry path: have the senders return `deliver`'s status (`lib/email.ts:123-131`, `:148-155`, `:170-174`) and have `handleOne` throw on `"error"`, so `lib/outbox.ts:133-144` applies the existing backoff; make `app/api/admin/outbox/retry/route.ts:27` treat `completedAt && attempts === 0 && EmailLog.status === "error"` as retryable instead of `ALREADY_DONE`; add a failed-mail count (and the oldest unretried key) to the `/api/jobs/config` payload so the operator has a surface for it; correct `ops/takedown.md:36-41`. Test: `lib/outbox.test.ts` — a sender returning `"error"` must leave `attempts = 1` and `lastError` set, and the admin retry must accept that row.
- **Fix.** The proposed fix, taken whole. Every sender returns `sendMessage`'s outcome and
`handleOne` throws on `"error"` (`lib/outbox.ts:143`), so the backoff that already existed applies
instead of the row being stamped complete (`:231-248`); `deliver` keeps the provider's status and its
own truncated words (`lib/email.ts:422-471`), which `logEmail` stores as `providerStatus`/`error`
(`:411-421`). The retry route accepts exactly the historical shape — completed, `attempts === 0`, and
an `EmailLog{status:"error"}` for the same key — and refuses every other completed row, so the
recovery path cannot be turned into a re-send of a delivered mail
(`app/api/admin/outbox/retry/route.ts:38-56`). `mail: { failedCount, oldestUnretriedKey }` joins the
job config where an operator can see it (`app/api/jobs/config/route.ts:77-80`, `failedMailHealth` at
`lib/outbox.ts:203`), and `ops/takedown.md:38-57` is corrected rather than left asserting the premise
this finding falsified. Verified in §5.7 by `lib/outbox.test.ts` (10 → 13: the error sender leaves
`attempts = 1` and `lastError` set, the retry revives it, the `404`/`409`/`409` arms answer as
documented, and the health count moves by exactly the delta of unresolved keys).
- **Status.** fixed

### R10-2 — An unverified manage token takes over any listing on a non-production deployment

- **Severity.** P0
- **Category.** security
- **Evidence.** `lib/manage.ts:46-61` mints a token for **whatever address the caller supplies** — it is never compared with `Startup.email` — then `:64` returns it in the response body whenever `!isProduction()`, and `lib/env.ts:31-33` defines `isProduction()` as the app-env string, so a preview deployment is "not production". That deployment class points at the production database per `doc/PROD-READINESS-CHECKLIST.md` l.16 (`DATABASE_URL` scoped Production, Preview). The write side is `app/api/startups/[domain]/route.ts:22-24` (a manage cookie for the same domain) and `:53-56` (the `email` field, i.e. the notification address, is writable by the session holder). Live chain `M1`–`M5` (§5.4): a stranger obtained a 64-hex token for `ladder-b.dev`, exchanged it for a session, and rewrote title/url/email in one `PATCH` (`200`), with `AuditLog` rows reading `MANAGE_LINK_REQUESTED | system | attacker@d10.dev` then `PROFILE_UPDATED | owner`. The module's own header (`:1-18`) states the intent — "BACKEND ONLY: NOT SHIPPED IN v1 … production never emails the link" and "Raw tokens are returned … ONLY outside production (dev convenience)" — so the code matches the letter of its note while the reachable class is wider than the note's intent.
- **Reproduction.** On any deployment whose app env is not `production` and whose `DATABASE_URL` is the production one: `POST /api/manage/request` with a listed domain and an address you control, take `debugToken` from the JSON, `POST /api/manage/verify`, then `PATCH /api/startups/<domain>` with the cookie.
- **Proposed fix.** Do not return the raw token from anything that can be reached with a production database: gate `debugToken` on an explicit development check (`getAppEnv() === "development"`, not `!isProduction()`), and either delete the module until v2 or make the request path require the caller to control the listing's address and deliver the link by mail rather than in the response. Drop `email` from the PATCH body's writable set (`app/api/startups/[domain]/route.ts:53-56`) until `16`/`17` decide the notification-address model, and record an audit actor that distinguishes "token holder" from "verified owner" (`lib/manage.ts:88`, `app/api/startups/[domain]/route.ts:62`). Test: an integration test asserting that `requestManageToken` returns no `debugToken` when `getAppEnv()` is `preview` or `production`, and that a request from an address other than `Startup.email` issues nothing.
- **Fix.** The ownership check the proposed fix asks for landed, and it is the half that closed the chain: the requested address must equal `Startup.email` (normalized) before a token is minted at all (`lib/manage.ts:62-72`), so a stranger's request for someone else's listing issues nothing — the M1–M5 chain cannot start, whatever the deployment is called. `debugToken` moved from `!isProduction()` to `getAppEnv() === "development"` (`:82`), so the one class of deployment that can reach a production `DATABASE_URL` no longer hands the token back; `email` left the PATCH body's writable set, answered as a field error instead of a silent write
(`app/api/startups/[domain]/route.ts:47-49`); and the request is audited as the listing's owner with the address as actor rather than as a `system` request (`lib/manage.ts:76`), which is the distinction §5.4's audit read could not make. The pre-existing tokens survive (no schema change): a link already minted with an address comparison this code never made expires unused. The module itself is still here — §9 Q2 is an operator call and this pass gated it rather than deleting it. Verified in §5.7 by `lib/manage.test.ts` (6 → 7: a non-matching address issues no token, a matching one does) and `lib/env.test.ts` (`preview` and `production` both withhold `debugToken`). (`14` R14-7 later renamed the field to `__devToken` and made the return need *both* this `development` check and `DEV_MANAGE_TOKENS="1"`; the ownership rule above is unchanged.)
- **Status.** fixed

### R10-3 — The receipt subject says "#1" to buyers who are not #1

- **Severity.** P2
- **Category.** content
- **Evidence.** `emails/receipt.tsx:16-18` builds the subject from the symbol and element name only; `lib/email.ts:114` calls it without `rank`, although `:121` passes the true `rank` into the body, which prints `#${p.rank}` (`emails/receipt.tsx:27`) and the `#1` heading at `:25`. Live: `e2@d9-e.dev` paid $6 on `Er` and settled at **rank 2**, and its `EmailLog` row — whose `detail` *is* the subject (`lib/email.ts:131`) — reads `You're #1 in Er (Erbium) 🎉` (`09` §7 R09-2, run `W`); `v2@d9-v.dev` settled the second half of a tie at rank 2 with the same subject (`09` §7 R09-3, run `V`).
- **Reproduction.** Land a take that a newer leader overtakes before it settles, then read the buyer's mail: the subject claims the crown, the body prints `#2`.
- **Proposed fix.** Make the subject a function of the rank: `receiptSubject({elementSymbol, elementName, rank})` → `"You're #1 …"` only at rank 1, and an honest line otherwise (e.g. `"Your $X stake on C is live — you're #3"`); pass `rank` at `lib/email.ts:114`. Test: a unit test over the subject builder for rank 1, 2 and 3, plus a settle test asserting the enqueued payload's `rank` matches the row that settles.
- **Fix.** `receiptSubject({ elementSymbol, elementName, rank })` is the shape the proposed fix names and it is now the only way the subject is produced: `You're #1 in C (Carbon) 🎉` at rank ≤ 1 (the omitted-rank default included) and `You're #2 in C (Carbon)` otherwise (`emails/receipt.tsx:29-31`). The body's headline is the same call (`:35`), so the subject and the `#N` the body prints cannot disagree; `rank` is passed at the call site (`lib/email.ts:544`) and, because `EmailLog.detail` is the subject, §5.3's false rows are now the rows an operator would read as true. Verified in §5.7 by `lib/listingMail.test.ts` (ranks 1/2/3 and the omitted-rank default, plus a body that must not congratulate a rank its subject denied) and by `lib/settle.test.ts`'s rank-2 settle. `15` §7 R15-8's "everyone is told #1" is the same defect from the concurrency side and is fixed by this; that row is doc `15`'s to flip.
- **Status.** fixed

### R10-4 — A reclaim receipt reports the top-up as the stake

- **Severity.** P2
- **Category.** content
- **Evidence.** `lib/settle.ts:218` passes `payment.amountUsd` — the amount of *this* payment — into the receipt; `emails/receipt.tsx:27` renders it as "Your $X stake puts you #N on <sym>". For a `reclaim` path the payment is only the increment. Live DB read: `z@d9-z.dev | Rn | paid 2 | stake_total 7 | path reclaim`, so the buyer holds $7 (the figure the rank was computed from and the figure an outbid/refund acts on, `lib/pricing.ts:14-17`) while the mail says "$2 stake". The same row also makes the subject false: rank 2 was reported as #1.
- **Reproduction.** Outbid a $5 holder on `Rn` with $6, then reclaim as that holder for the $2 the mail quotes, and read the receipt against `Stake.amountUsd`.
- **Proposed fix.** Send the resulting holding, not the increment — pass the applied stake's `amountUsd` (`result.stake.amountUsd`, already in scope at `lib/settle.ts:195-201`) and, when it differs from what was charged, say both ("$2 top-up — you now hold $7 on Rn"). Test: a settle test for the `reclaim` path asserting the receipt payload carries the post-apply total and the charged amount as separate fields.
- **Fix.** The message now reports the position the mail is about and states the charge beside it rather than instead of it: the payload's `amountUsd` is the applied stake total and `topUpUsd` carries this payment's amount, added only when the two differ (`lib/settle.ts:315-321`), and the template branches on it — "$2 top-up adds to the stake you already held: **$7** now stands for you on Rn" versus the plain "$5 stake puts you **#1**" (`emails/receipt.tsx:44-46`). Both figures are in the same sentence, so neither "$7 for a $2 charge" nor "$2 for a $7 holding" is possible. Verified in §5.7 by `lib/settle.test.ts` on a real tile: a $5 stake taken by a raider, a $3 reclaim, asserting `amountUsd: 8`, `topUpUsd: 3`, the rank the total earned, that the rendered HTML states both figures, and that a plain receipt carries no top-up field.
- **Status.** fixed

### R10-5 — No suppression list: unsubscribe is irreversible, partial, and invisible

- **Severity.** P2
- **Category.** ops
- **Evidence.** `lib/email.ts:4` claims "Suppression + EmailLog always"; nothing in the repository implements suppression — `unsubscribedAt`, `suppress`, `isUnsubscribed` and `clearEmail` appear only in `app/api/unsubscribe/route.ts:31,50,66`. The implemented mechanism is one column: `Startup.email = null` (`:36`). Consequences, each measured or read from the code: (a) a receipt continues to reach a person who unsubscribed, because its recipient is `payment.email ?? payer.email` and the footer token it carries is the *listing's* (`lib/settle.ts:206-212`); (b) outbid mail stops **permanently and silently** for that listing (`lib/settle.ts:222-223` `if (victim?.email)`), so "I lost #1" is suppressed as a side effect of a preference about marketing; (c) `EmailLog.status = "suppressed"` is never written (schema `prisma/schema.prisma:365-376`; DB read: zero rows); (d) there is no way back: re-subscribing requires a manage session (`app/api/startups/[domain]/route.ts:53-56`), i.e. a magic link production never sends (R10-2, `lib/manage.ts:16-18`), and the unsubscribe page ends with a redirect and no confirmation of what will stop (`app/api/unsubscribe/route.ts:53-70`).
- **Reproduction.** Take a receipt's unsubscribe link, complete the POST, then buy again with the same address: the receipt arrives, and the outbid mail for that listing never does.
- **Proposed fix.** A real suppression list keyed by address (with a `suppressed` `EmailLog` status and the reason), consulted before every send, plus a self-service re-subscribe; and an explicit decision on transactional mail (see §9 Q1) instead of the current accident where a marketing preference disables the "you lost #1" notice. Test: a send to a suppressed address writes `EmailLog{status:"suppressed"}` and no provider call, and a re-subscribe clears it.
- **Fix.** The suppression list is real: `EmailAddress` (migration `0008`) keyed by normalized address with the reason, the origin template and the timestamp, written from the unsubscribe route and from the provider webhook, and consulted before every send — a suppressed message is logged `status:"suppressed"` with the reason in `detail` and no provider call is made (`lib/email.ts:359-373` for the rules that decide a refusal, `:396-410` for the branch that writes one). The three consequences this finding measured are each addressed where it named them: (a) receipts and outbid mail for a listing now resolve the *recipient's* address token (`resolveUnsubTarget`, `:135`) instead of the listing's, so unsubscribing stops the mail that arrives; (b) `list`-kind mail stops for every reason while `account`/`internal` survive a preference about marketing (`refuses`, `:359`) — a marketing opt-out no longer silently deletes "you lost #1" for a listing, which is §9 Q1 answered rather than left to the next reader; (c) `EmailLog{status:"suppressed"}` is written. (d) is closed by `?resubscribe=1` on the same route and a confirmation page that states what will and will not stop. The precedence rule was inverted in the first cut and fixed during verification — see §5.7 — which is exactly the kind of defect this finding's "(b)" predicted. Verified by `lib/suppression.test.ts` (new, 15) and `lib/unsubscribe.test.ts` (5 → 8).
- **Status.** fixed

### R10-6 — The waitlist confirmation has no opt-out and cannot be suppressed

- **Severity.** P2
- **Category.** ops
- **Evidence.** `lib/email.ts:170` calls `deliver(to, subject, html)` with no `unsubToken`, so no `List-Unsubscribe` header is set (`:47-54`); `app/api/unsubscribe/route.ts:33-38` resolves tokens only through `Startup.unsubToken`, while a waitlist address lives in `WaitlistEntry` (`prisma/schema.prisma:258-265`), so a recipient has no route to stop the mail and the operator has no column to set. The message is the only confirmation the paused-checkout path promises (`app/api/waitlist/route.ts:59-62`), and its dedupe key is per address per hour (`:61`), so a repeat join an hour later sends again by design. Live: 11 `waitlist` rows, all `logged`. The report copy to the moderation inbox has the same absence and *should* (`lib/email.ts:140-141`): it is a one-off operational message, not a list — the difference between the two is a product decision currently made by omission for the waitlist.
- **Reproduction.** Join the waitlist, then look for any way to stop mail from that address without a listing (there is none), and inspect the message headers for `List-Unsubscribe` (absent).
- **Proposed fix.** Give waitlist entries their own opaque unsubscribe token (or resolve a signed address) and route them through the same suppression check as everything else; keep the hour-bucketed dedupe for loop protection but record the lifetime send count per address so a repeat join is a decision rather than an accident. Test: a waitlist mail must carry `List-Unsubscribe` and its token must null/flag the `WaitlistEntry`.
- **Fix.** The waitlist message now carries a `List-Unsubscribe` header and a one-click target built from the address token, and its address is resolved through the same suppression check as every other kind (`unsubUrlFor` at `:365`, the sender at `:650-668`). Because a waitlist address has no listing, the token is derived from the address itself rather than from `Startup.unsubToken`, which is the resolution this finding asked for; unsubscribing from a waitlist message writes an `EmailAddress` row with reason `unsubscribe` and stops the mail, leaving the `WaitlistEntry` itself as the record that a launch is still worth announcing to someone else. The hour-bucketed dedupe is kept for loop protection, and the report copy to the moderation inbox deliberately still has no opt-out — it is the one-off operational message this finding itself said *should* not, and it is now a recorded decision rather than an omission. Verified in §5.7 by `lib/listingMail.test.ts`'s R10-9 escaping sweep over the receipt/outbid/refund senders and by `lib/suppression.test.ts`'s per-kind arms.
- **Status.** fixed

### R10-7 — A bounce or complaint has nowhere to land

- **Severity.** P2
- **Category.** ops
- **Evidence.** There is no provider webhook: the only reference to the provider's API in the repository is the send call (`lib/email.ts:46`), and `app/api` contains no Resend endpoint. `deliver` reads only `res.ok` (`:68`), discarding the provider's status code and body, so "invalid recipient" and "rate limited" are the same `"error"` with no reason. `EmailLog` is insert-only — `logEmail` creates and nothing in the repository ever updates it (`:15-33`) — so a later bounce cannot be recorded, and `EmailLog` has no field for a provider message id to correlate one (`prisma/schema.prisma:365-376`). Live: the single failed row kept no reason, and zero rows carry `lastError` (§5.1). Consequence: an address that hard-bounces keeps receiving until somebody reads the provider dashboard, which this checkout cannot reach.
- **Reproduction.** Send to an address the provider rejects at the receiving MX (not at send time) and look for any record of the bounce in the database or any alert.
- **Proposed fix.** Preserve the provider's status and body in `EmailLog.detail` (or a new `error` column) and store the provider message id, then add a bounce/complaint webhook that marks the address suppressed (depends on R10-5). Test: a non-2xx send records the provider status and body; a simulated bounce webhook flips the address to suppressed.
- **Fix.** Both halves of the proposed fix are in. `deliver` keeps the provider's HTTP status and whatever the provider said, and `logEmail` stores them in the new `providerStatus`/`error` columns on the failed row (`lib/email.ts:422-471`, `:411-421`) — so "invalid recipient" and "rate limited" are now different records, and `failedMailHealth` can count the ones that need a human (`lib/outbox.ts:203`). The webhook is at `/api/webhooks/resend`, rate limited, signature-verified through Svix (401 on a bad or stale signature, tolerance windowed), dispatched through `resendEventEffect`, and it writes the suppression this finding said depended on R10-5 — plus an audit row for every event it understands and an acknowledged no-op for the ones it does not (`app/api/webhooks/resend/route.ts:67-131` — rate limit, then signature, then dispatch). Transient bounces deliberately do not suppress, and that is written down where the decision is made (`resendEventEffect`), because a full mailbox is not a dead address. R10-11's correlation id arrives with this: `deliver` stores the provider's message id on the row it just wrote. Verified in §5.7 by the route-level `describe` in `lib/suppression.test.ts` and `lib/outbox.test.ts`.
- **Status.** fixed

### R10-8 — The email preview route 500s on its own default template

- **Severity.** P3
- **Category.** correctness
- **Evidence.** `app/api/emails/preview/route.ts:44` puts the subject string into the `X-Subject-Preview` response header; the default template is `outbid`, whose subject contains `👑` (`emails/outbid.tsx:14-15`), which cannot be encoded into a header, so the response dies before its body is written — live `500`, `x-subject-preview: null`, empty body, while `?template=receipt` (a `🎉` subject that the route does not put in a header) answers `200` with 1,179 bytes (§5.5). The route's gate is `process.env.NODE_ENV === "production"` (`:7-9`), not the app-env check the sibling preview surfaces use, so the behaviour is decided by how the process was started rather than where it points: a production-flagged `next dev` on 3212 answered `500` rather than the `404` the gate implies.
- **Reproduction.** `curl -sS -D - "http://<host>/api/emails/preview"` → `500` with no `X-Subject-Preview`; `?template=receipt&sym=C` → `200`.
- **Proposed fix.** Drop the header or strip it to ASCII (`subject.replace(/[^\x20-\x7E]/g, "")`), and gate the route on the same app-env predicate as `app/pay/[paymentId]/page.tsx` (`05` §7 R05-8 settled the provider-mode gate) so the whole family answers `404` in production rather than depending on `NODE_ENV`. Test: a route test asserting `200` for the default template and `404` under the production app env.
- **Fix.** The header is gone rather than ASCII-stripped — the subject is rendered in an HTML banner at the top of the previewed message, where an emoji is an asset instead of an encoding problem, and no response path can be reached by a value that cannot be encoded. The gate is now `getAppEnv()`, the same predicate the sibling preview surfaces use (`app/api/emails/preview/route.ts:38-41`), so production answers `404 {error:"Not found."}` and the answer is decided by where the process points rather than by how it was started. The scratch `sym` free text also became a canonical lookup against `ELEMENTS`, which is R10-9's other requirement, so an unknown symbol previews carbon with a note instead of echoing what was asked for. Verified in §5.7 by `lib/emailPreview.test.ts` (new, 5: the default template answers `200` with the subject in the banner, all five templates render, and a test that asserts the retired header is *absent* — so the defect cannot come back by re-adding it).
- **Status.** fixed

### R10-9 — Two templates interpolate unescaped, and the preview route reflects

- **Severity.** P3
- **Category.** security
- **Evidence.** `emails/escape.ts:8` exists and is used by `report.tsx` (`:34`, `:37`) and `waitlist.tsx` (`:19`), but `receipt.tsx:25,27,30,33` and `outbid.tsx:23,25,26,28,31` interpolate `${…}` values raw. Live: `GET /api/emails/preview?template=receipt&sym=<img src=x onerror=alert(1)>` → `200` with the tag reflected into the HTML (§5.5). Reachability of a *hostile* value into the real senders is currently narrow: the symbol is a database identifier chosen by the settler, and the domain reaches `viewUrl`/`reclaimUrl` through `encodeURIComponent` (`lib/email.ts:118`, `lib/links.ts:17-23`). But the pattern is one user-controlled field away from sending arbitrary markup to a customer's client, and the preview route demonstrates that no layer removes it.
- **Reproduction.** The preview request above; for the real templates, grep the props for any non-canonical source.
- **Proposed fix.** Route every interpolation in all four templates through `emails/escape.ts`, including `elementSymbol`, `elementName` and any future domain/reason field; keep the preview route's `sym` as a canonical-symbol lookup rather than free text. Test: a template test asserting a `<`-bearing prop cannot produce a tag, mirroring the existing report/waitlist escaping tests.
- **Fix.** Every interpolation in `receipt.tsx`, `outbid.tsx` and `refund.tsx` now goes through `emails/escape.ts`, matching `report.tsx` and `waitlist.tsx`; the preview route's `sym` is a canonical `ELEMENTS` lookup. The sweep during verification found one hole the finding's own grep had not reached — `emails/refund.tsx:43` printed `providerRef` raw — which is now escaped, and the fix pack was not considered done until that line moved. The URL slots (`viewUrl`, `reclaimUrl`, `unsubUrl`) are deliberately *not* entity-escaped: they are `encodeURIComponent`-built at their construction sites, so escaping them would corrupt the links this doc's other findings depend on. Verified in §5.7 by `lib/listingMail.test.ts` (new, 3), whose R10-9 case drives a hostile symbol, name and domain through the receipt, outbid and refund senders and asserts no tag survives — the mirroring test this finding asked for.
- **Status.** fixed

### R10-10 — Anyone can drain the mail queue where the job secret is not enforced

- **Severity.** P3
- **Category.** ops
- **Evidence.** Live: `GET /api/jobs/outbox` with no `Authorization` header and no secret → `200 {"ok":true,"claimed":5,"completed":5,"failed":0}` (§5.5) — the route's `GET` is the POST handler and `jobAuth` rehearses outside production (`lib/jobs.ts`; the same rehearsal is recorded in `doc/PROD-READINESS-CHECKLIST.md` l.158 for a secret-carrying call). Mail consequence: an anonymous caller can cause real mail to be delivered on demand — the buyer's receipt and the outbid notice — by driving `processOutboxRowById` (`lib/outbox.ts:126-146`) against whatever database the process points at. The drain itself is bounded (1–25 rows, 20 s deadline) and cannot double-send a completed row.
- **Reproduction.** `curl -sS "http://<host>/api/jobs/outbox"` on a non-production process.
- **Proposed fix.** Owned by `13` as an authentication decision (the job family should fail closed regardless of environment, or be bound to a loopback/host check); this doc's requirement is only that no unauthenticated caller can make the product send mail. Test: an unauthenticated `GET`/`POST` answers `401` in every environment.
- **Fix.** Not taken here. `jobAuth`'s rehearsal and the fail-closed decision belong to `13`, and taking half of it in this pass would have meant either a second definition of "the job secret is set" or an outbox drain that stops working on the deployments that currently rely on the rehearsal. What this pass did instead closes the *mail* consequence this finding measured through the other door: a completed row can no longer be re-sent by a stranger's retry (R10-1's route accepts only the historical failed shape), and the health count now makes an unattended drain visible. §8's criterion for the anon-drain is recorded as still answered by `13`.
- **Status.** open

### R10-11 — `EmailLog` cannot say which payment a message belonged to

- **Severity.** P3
- **Category.** data
- **Evidence.** `prisma/schema.prisma:365-376`: `EmailLog` has `to`, `template`, `elementSymbol`, `amountUsd`, `status`, `detail`, `createdAt` — no `paymentId`, no provider message id, no `updatedAt`, and `to` is stored in the clear with no retention note. `detail` is set to the subject by all four senders (`lib/email.ts:114,131,155,174`), so the only free-text column duplicates the subject (this is why §5.3's false subjects are also the operator's record). The `template` comment enumerates `outbid | receipt` while the senders write four templates (`report`, `waitlist`). Live: 50 rows, answers to "which payment was this?" only derivable by matching amount + symbol + timestamp by hand.
- **Reproduction.** Ask the log "which payment produced this receipt" for the `Er` rows and answer it without joining `Payment` on time and amount.
- **Proposed fix.** Store the outbox `dedupeKey` (which contains the payment id — `receipt-${paymentId}`) or a `paymentId` column, the provider message id (R10-7), and a documented retention window for addresses; correct the schema comment. Test: a send writes the dedupe key into `EmailLog`.
- **Fix.** `EmailLog` carries the outbox `dedupeKey` (which contains the payment id — `receipt-${paymentId}`), the provider message id returned by `deliver`, and the provider status and error text on a failure, so "which payment produced this receipt" is a lookup rather than a join by amount and timestamp; the `template` comment now enumerates the five templates the senders actually write. `detail` keeps the subject — §5.3's operator record — and the webhook's `detail` is capped so an event body cannot bloat the table (`app/api/webhooks/resend/route.ts:18`). Verified in §5.7 by `lib/outbox.test.ts` and `lib/suppression.test.ts`, which assert the key on the rows they produce.
- **Status.** fixed (the correlation half; the documented retention window for addresses in `to` is still open and is `16`'s row)

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
- [x] A retry of a failed delivery actually re-sending (`R10-1`'s fix), and a suppression list actually stopping a send (`R10-5`) — both were this doc's own fix-pass criteria and both are asserted against a real database now (§5.7: the retry revival in `lib/outbox.test.ts`, the refused send in `lib/suppression.test.ts`).

**Fix-pass criteria** (2026-09-16, verified by §5.7):

- [x] A failed send does not end as a delivered row: it leaves `attempts > 0` and `lastError` set, and
      the existing backoff retries it (R10-1 — `lib/outbox.ts:143,231-248`)
- [x] A retry cannot re-send a delivered mail: only the historical shape (completed, `attempts = 0`,
      an `EmailLog{status:"error"}` for the key) is revivable (R10-1 —
      `app/api/admin/outbox/retry/route.ts:38-56`)
- [x] Unretried failures are a number an operator can read, not an inference: `mail.failedCount` and
      `oldestUnretriedKey` on `/api/jobs/config` (R10-1 — `failedMailHealth`)
- [x] A refusal is a stored fact with a reason, and its `EmailLog` status is distinguishable from
      `logged` (R10-5/R10-7 — `suppressionStatus`, `EmailAddress`)
- [x] An address the provider cannot deliver to is not mailed again, and no later, weaker reason
      promotes it back to "list mail only" (R10-5 — `UNDELIVERABLE_REASONS`; §5.7's first defect)
- [x] A consent reason does not silence a money notice: `list` stops for any reason, `account` and
      `internal` only for `bounce`/`invalid` (R10-5 — `refuses`, and §9 Q1 answered in code)
- [x] No message the product sends lacks a way out, and the link resolves to the *recipient's* own
      address rather than a listing's (R10-5/R10-6 — `addressToken`/`unsubUrlFor`, `?resubscribe=1`)
- [x] A bounce or a complaint lands in the database with the provider's own words, without a human
      reading the provider dashboard (R10-7 — the `/api/webhooks/resend` route and its route-level tests)
- [x] No template can turn a hostile prop into a tag, including the refund reference that only
      verification found (R10-9 — `lib/listingMail.test.ts`'s hostile render)
- [x] A subject never contradicts its body: both derive from the settled rank, and `EmailLog.detail`
      records the same string the customer read (R10-3 — `receiptSubject`)
- [x] A receipt states the charge and the holding separately, and a plain receipt states no top-up
      (R10-4 — `lib/settle.ts:321`, `emails/receipt.tsx:44-46`)
- [x] A message can be joined to the outbox row and the payment (and to the provider's message id)
      without arithmetic on amount, symbol and timestamp (R10-11 — `dedupeKey`, `providerMessageId`;
      the retention window stays open under `16`)
- [x] No manage token is minted for a listing whose address the requester cannot name (R10-2 —
      `lib/manage.ts:62-72`)
- [x] The preview route answers in the environments the app-env predicate allows and is absent in
      production, and the subject it renders is the one the sender would use (R10-8 —
      `lib/emailPreview.test.ts`)
- [x] The whole suite runs green with **zero skips** when a database is present (49 files / 712) and
      still green without one (43 passed / 6 skipped; 607 passed / 105 skipped) — §5.7

## 9. Open questions

1. **Is a receipt transactional or marketing?** Today the unsubscribe link in a receipt is the same mechanism as the outbid notice, so a click designed to stop "you lost #1" mail also fails to stop receipts (R10-5). The operator has to decide which messages are exempt from a suppression list, and the answer changes the copy in the footer of every mail.

   **Answered by the fix pass (arm: two classes, decided per message kind rather than per address).** The
   subscription is a property of the *message*, not of the recipient's standing: `list` mail (a receipt,
   an outbid notice, a waitlist confirmation) stops for any recorded reason, because that is what the
   footer link promises — and a receipt that still arrived after "stop mailing me" was exactly the
   complaint §5.1 measured. `account` mail (a reversal notice) and `internal` mail (our own inbox)
   survive a consent reason and stop only for `bounce`/`invalid`, where nothing can be delivered anyway
   (`refuses`, `lib/email.ts:359`). This is a defensible *product* answer rather than the previous
   accident in which a marketing preference silently disabled "you lost #1". The copy question the
   finding raised is answered with it: the footer says what stops, and the confirmation page says the
   same. What this arm deliberately does not do is offer a per-category checkbox ("money notices only")
   — that needs an operator decision about which classes exist and is not invented here.

2. **Should the manage module exist in this tree at all?** `lib/manage.ts:1-18` says it is dormant by design, and R10-2 shows that "dormant" depends on a deployment name. Deleting the module and its routes until the pages and delivery exist would remove the class outright; keeper-or-delete is an operator call, and it affects `17` (tooling) as well.

   **Partly answered by the fix pass (arm: gate it, do not delete it).** The class R10-2 measured is
   closed at its precondition: a token is minted only when the requested address equals
   `Startup.email`, and the raw token is returned only in a `development` app env
   (`lib/manage.ts:62-72,82`). What remains open is the operator's question — the module is still here,
   its pages still do not exist, and the "does this belong in the tree" call needs the delivery story
   `14` and the tooling story `17` before it can be made. Nothing in the pass argues for keeping it
   beyond that: the gate is a fix, not a vote.

3. **Is the waitlist confirmation a marketing message?** It carries no opt-out because none exists (R10-6); whether the address needs a consent record beyond `WaitlistEntry.consentAt` (`app/api/waitlist/route.ts:49`) and a lawful erasure path belongs to `16`.

   **Half answered by the fix pass (arm: it is list mail, and it now behaves like it).** The
   confirmation carries the address's own token and a `List-Unsubscribe` target, and a suppressed
   address's later submit records the join without mailing (`app/api/waitlist/route.ts:45-52`) — so the
   address is never re-consented by a repeat submit and never mailed after asking us to stop. The
   *record-keeping* half is untouched and still `16`'s: `consentAt` is still the only consent field, and
   there is still no erasure path for a `WaitlistEntry`. Classifying it as list mail is what made the
   opt-out the right answer rather than a marketing exemption.

4. **Who watches failed mail?** R10-1's fix adds a count to the job config; whether that becomes an alert (mail, or the operator's existing channel) is a runbook decision for `13`/`17`.

   **Half answered by the fix pass (arm: make it readable first, alerting later).** The number exists —
   `mail: { failedCount, oldestUnretriedKey }` on `/api/jobs/config`, which the same scheduled tick
   already requests and which fails its step on a non-2xx (`13`'s workflow) — so a failure is no longer
   invisible. Whether it *wakes anyone* is still open, deliberately: the pass added no alerting channel,
   because that is a runbook choice between the existing GitHub-tick step and a new one. The rule this
   pass did settle is that the count must be derivable without the provider dashboard.

5. **Should the outbid notice be a first-class notice rather than an email?** It is the only signal a dethroned holder gets, and it is optional-by-address (`09` §7 R09-7). If the product wants the reclaim behaviour the mail advertises, the notice may need to be on-site rather than in a template.

   **Unchanged by the fix pass.** There is still no on-site notice for a dethroned holder: the mail is
   the notice, and the pass made its reachability slightly wider only by `09`'s fix (the funding
   payment's address as the fallback, `OUTBID_UNNOTIFIED` when there is none). Whether the product
   wants a banner or a "you were outbid" state on the site is a product question this doc does not
   answer, and the pass did not take it.

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
- 2026-09-16 (working tree) — fix pass for R10-1…R10-9 and R10-11, each cited in §7 with its verification
  in §5.7 (a new section, written against a real Postgres: a throwaway `postgres:16-alpine` container on
  host port 55501, all 9 migrations applied with `prisma migrate deploy`, `npm run test:ci` green at
  **49 files / 712 passed / 0 skipped**; the DB-less run still green at 43 passed / 6 skipped and
  607 passed / 105 skipped). The pass moved the suite **+32**: new `lib/suppression.test.ts` (15),
  `lib/emailPreview.test.ts` (5), `lib/listingMail.test.ts` (3); `lib/unsubscribe.test.ts` 5 → 8,
  `lib/outbox.test.ts` 10 → 13, `lib/manage.test.ts` 6 → 7, `lib/env.test.ts` 17 → 18,
  `lib/settle.test.ts` 24 → 25, and `lib/moderation.test.ts` rewritten in place (10) so that its
  assertions exercise the routes rather than a copy of their logic. §6's matrix gained the rows the pass
  changed; §8's last criterion ticked and a fix-pass block added; §9 Q1–Q4 annotated with the arms taken
  and Q5 recorded as unchanged; §7's citations re-anchored to the post-fix tree.

  **Verification found three defects the reading had missed**, and all three are fixed here rather than
  logged: (a) `suppressEmail` got the precedence rule backwards — a later `unsubscribe` overwrote a
  stored `bounce`/`invalid`, so an address the provider could not deliver to was promoted back to
  "list mail only" and account mail resumed on the first failed delivery
  (`UNDELIVERABLE_REASONS`/`isUndeliverable`/`storedReason`, `lib/email.ts:62-78,184-186`); (b) the
  refund template printed `providerRef` into the body unescaped (`emails/refund.tsx:43` → `esc`), the
  one escaping gap left after R10-9's sweep; (c) the test harness leaked rows between suites — a
  `describe`-level `afterAll` runs before the file-level one, so a per-describe `EmailAddress` fixture
  survived into the next file and made a suppression assertion pass for the wrong reason.

  Decisions, each one a choice between two defensible readings. **R10-1**: revive only the historical
  failed shape, not "any row whose key has an error" — the narrower predicate is what makes a retry
  unable to re-send a delivered mail; the operator's window is a count and an oldest key, not a queue
  view. **R10-5**: the exemption is a property of the message kind, not of the recipient — `list` stops
  for any reason, `account`/`internal` only for undeliverable (§9 Q1) — and `unsuppressEmail` keeps the
  row and token so a resubscribe needs no new secret. **R10-7**: the webhook records the provider's own
  reason onto the address and the log, and it tolerates an unparseable body at the edges (rate limit,
  signature, unknown type) rather than 500-ing at the provider. **R10-3**: the subject is derived from
  the settled rank and omits the rank rather than inventing one when there is none. **R10-8**: the
  preview route keeps the app-env gate and reproduces the sender's own subject instead of a second copy
  of it, so a preview cannot drift from the mail. **R10-11**: correlation is the dedupe key plus the
  provider message id — the *retention window* for the address in `to` is left open under `16`, which is
  the one part of a finding this pass handed on rather than took. **R10-10** (the pre-deploy migration
  check) stays `open`: it is `13`'s workflow to gate, and this pass added no deploy step.

  Files: `lib/email.ts` (reasons and their precedence `:57-78`, stored reason in `suppressEmail`
  `:160-191`, `refuses` `:359`, `unsubUrlFor` `:365`, `sendMessage`'s refusal branch `:396-410`,
  `logEmail` `:308-333`, `deliver` `:422-471`, the Resend event table and its effects `:261-313`,
  webhook verification `:205-230`, `receiptSubject` at the receipt sender `:544`, the waitlist sender
  `:650`), `lib/outbox.ts` (`assertDelivered` `:143`, `failedMailHealth` `:203`, claim/backoff
  `:231-248`), `lib/settle.ts` (the receipt payload's `topUpUsd` `:315-321`), `lib/manage.ts`
  (`:62-72,76,82`), `lib/audit.ts` (`:39-40`), `lib/env.ts` (`:179-183`), `emails/receipt.tsx`
  (`:29,35,44-46`), `emails/refund.tsx` (`:43`), `emails/waitlist.tsx` (`:23-25`),
  `app/api/webhooks/resend/route.ts` (new: rate limit `:67`, signature `:72`, suppression `:115`,
  audit `:130`), `app/api/unsubscribe/route.ts` (`:120-176`, resubscribe `:93`),
  `app/api/emails/preview/route.ts` (`:38-41` gate, subject banner `:106`),
  `app/api/jobs/config/route.ts` (`:77-80`), `app/api/waitlist/route.ts` (`:45-52`),
  `app/page.tsx` (`:176-178`), `prisma/schema.prisma` (`EmailLog` `:379-410`, `EmailAddress`
  `:431-442`; two stale comments corrected, no migration), `.env.example`
  (`:19`), and the new `prisma/migrations/0008_email_notifications/`. Tests: the three new files named
  above plus `lib/outbox.test.ts`, `lib/unsubscribe.test.ts`, `lib/manage.test.ts`, `lib/env.test.ts`,
  `lib/settle.test.ts` (the `T5 = 9985` tile) and `lib/moderation.test.ts`.

  **U10-1…U10-6 stand unchanged** — the pass added no DNS record, sent no mail to a real inbox, read no
  production environment, and did not verify the profile click counter; §12's `What settles it` cells
  are the same steps as before. The one UNKNOWN the pass moved closer to answerable is U10-4: a bounce
  or complaint now writes a row (§5.2), so the production read it asks for returns data instead of
  nothing.

## 12. UNKNOWN log

**Note (2026-09-16, fix pass).** Every row below still stands: the pass was verified against a real
database and a local container, which cannot answer any of these six — they need DNS, a real inbox, the
production environment, the provider console, or a live customer action. No row was retired, and none
was made partly answerable enough to move its `What settles it` step.

| Id | Category | Unknown | What settles it |
| --- | --- | --- | --- |
| U10-1 | ops | Whether mail from `periodictable.lol` authenticates: SPF, DKIM (provider key), DMARC policy, and whether the provider's sending domain is verified. Nothing in this checkout can read the zone. | `dig +short TXT periodictable.lol`, `dig +short TXT <selector>._domainkey.periodictable.lol`, `dig +short TXT _dmarc.periodictable.lol`, plus the provider console's domain-verification status. Any of these showing no record is a deliverability defect regardless of the provider's own reporting. |
| U10-2 | ops | Whether a receipt, an outbid notice and a waitlist confirmation actually arrive, in which folder, and how the from-name and footer render. Needs a real inbox and a send that is not the `"logged"` branch. | Set `RESEND_API_KEY`/`EMAIL_FROM` on a non-production deployment, trigger one settle and one waitlist join against a real mailbox, then read the delivered message's source for `Authentication-Results` (SPF/DKIM/DMARC verdicts) and check the spam folder. The `EmailLog` rows for those sends give the provider-side status. |
| U10-3 | ops | Whether the production `EMAIL_FROM` is the default (`lib/email.ts:60`, `periodictable.lol <hi@periodictable.lol>`) or an explicit value, and whether `RESEND_API_KEY` is set at all — the difference between mail leaving the building and every send taking the `"logged"` branch (`:41`). The production environment is not readable from this checkout. | Read the production deployment's environment (`RESEND_API_KEY`, `EMAIL_FROM`) and the `required` findings of its `/api/jobs/config`; then send one message and confirm a provider message id exists. |
| U10-4 | ops | Whether any address hard-bounces or marks a message as spam today, and whether any production `EmailLog` row is already `error`. Without a bounce webhook (R10-7) the only source is the provider console or the production log table. | Provider console → the sending domain's bounce/complaint counts; and a production read of `SELECT status, count(*) FROM "EmailLog" GROUP BY 1` plus the rows where `status = 'error'`. |
| U10-5 | ops | Whether the manage-link disclosure (R10-2) has ever been used against a listing: any production `ManageToken`/`ManageSession` row, any `PROFILE_UPDATED` audit row whose actor was a token holder, and any unexplained customer-facing listing change. The scratch database cannot answer it. | Production reads: `SELECT count(*) FROM "ManageToken"`, `SELECT count(*) FROM "ManageSession"`, `SELECT * FROM "AuditLog" WHERE action IN ('MANAGE_LINK_REQUESTED','MANAGE_LINK_CONSUMED','PROFILE_UPDATED') ORDER BY "createdAt"`, cross-checked against owner reports of edited copy. |
| U10-6 | content | Whether the receipt's "watch 🟢 clicks delivered climb on your profile" (`emails/receipt.tsx:29`) is true as rendered: the profile page serves `200` and exposes `clicks` (`/s/ladder-b.dev`), but the label, the green dot and whether the number moves after a `/go` click were not verified this pass. | Buy a stake, click its tile once, and read `/s/<domain>` before and after: the counter must read one higher and carry the label the mail describes. |
