# 11 — API contracts

| Field | Value |
| --- | --- |
| Phase · batch | 11 — API contracts · 3 |
| Status | draft — 26 of 26 routes observed on a local production-mode build; no fixes (read-only batch) |
| Date reviewed | 2026-09-15 |
| Commit reviewed | `9681bdc` |
| Reviewer | review agent |

| Probe not run | Why | Residue |
| --- | --- | --- |
| Live-host route matrix | This doc's questions are shape questions (`?limit` edges, bare 405s, dev-only gates, dependency-failure bodies) that the live deployment answers from the same code with different env values; a local production-mode build answers all of them, and `01`-`05` already recorded the live read-API headers | U11-3 |
| Authenticated `/api/admin/*` success responses | No `ADMIN_TOKEN` in this checkout and none may be invented; the 403 path and the `14` inventory are what could be observed | U11-1 |
| A real Resend send or Stripe call | No provider credentials; the failure branches were exercised instead (a missing `RESEND_API_KEY` is a real, reachable state — §5.10) | U11-2 |
| Neon-backed latency and cold start | Scratch Postgres on this host (`15` owns the cost model) | U11-4 |

## 1. Scope

Owns L2/L3 for S1 in every phase: the HTTP contract of `app/api/**` — method, auth model, inputs, validation, status codes, error shape, rate limit, caching, and whether a failure is distinguishable from a legitimate empty state.

Not owned here: the money *rules* behind the codes (`06`, `08`), the management and mail flows as product surfaces (`10`), the job schedules (`13`), the exploitability of any of it (`14`), and latency (`15`). Cross-references are given per finding rather than repeated.

Inspected: all 26 `app/api/**/route.ts` (26 at authoring; **35 today**, see §5.1's amended count); `lib/api.ts`, `lib/route.ts` (`apiJson`, `apiError`, `READ_CACHE`, request id), `lib/contracts.test.ts`, `lib/rateStore.ts`, `lib/rateLimit.ts`, `lib/ip.ts`, `lib/jobs.ts`, `lib/manage.ts`, `lib/flags.ts`, `lib/env.ts`, `lib/abuse.ts`, `lib/validate.ts`, `lib/email.ts` (`deliver`), `next.config.mjs:1-44`, `vercel.json`.

Route inventory: `Get-ChildItem -Recurse -Filter route.ts app\api` → 26 files. §2 of the plan (line 124) names 26 paths, and the two lists are identical name for name, so the "27" in the batch brief is a miscount of the same list — no route is unreviewed (§5.1). **Amended 2026-09-16 (PR `26` audit):** 35 route files today — the nine that landed after authoring arrived with the later fix packs (`abandoned-checkouts`, `daily`, the admin and manage additions) and the wave-4 sweep walked them; the count is folded into F-010.

## 2. Actors

| Actor | Effect |
| --- | --- |
| Visitor | reads only; every read route is unauthenticated, unthrottled and served from the same Postgres (`lib/prisma.ts`) |
| Bidder | `POST /api/checkout` is the only public write that costs money; its rejections are the one contract a customer can see (`06` owns the UI text) |
| Holder | `ptl_manage` cookie → `GET /api/manage/session`, `PATCH /api/startups/[domain]`; the cookie is the whole authorisation model (`lib/manage.ts:29,110-121`) |
| Operator | `Authorization: Bearer` (`ADMIN_TOKEN`, or a named operator token) → `/api/admin/*`; 403 when unset **or** mismatched, in every environment (`lib/jobs.ts:34-41` at authoring; `:88-98` today) |
| Scheduler · pinger | Vercel cron (`vercel.json`) and an external pinger call `/api/jobs/*` with `Authorization: Bearer` (`CRON_SECRET`) or a matching body secret; the query-string form this row originally recorded was deleted by `14` R14-8 (§5.2, `13`) |
| Attacker | unauthenticated everything except admin/jobs; the four routes worth attacking are ranked in `14` |
| Provider | Stripe signs the only inbound webhook; Resend and Neon are outbound dependencies whose failure shape matters here (§5.10) |
| Crawler | `/api/*` is disallowed in `app/robots.ts` (`01` owns it) |

## 3. Intended behaviour

1. Two error grammars share the tree. `apiJson(data, init)` returns `{ ...data, reqId }` with `x-request-id` (`lib/route.ts:35-39`); `apiError(message, { status, code })` returns `{ error, code }` with the same header (`lib/route.ts:41-46`). 11 of 26 routes imported one of them at authoring; **21 of 35** do today, the other 14 hand-build `NextResponse.json` and emit neither `code` nor `x-request-id` (§5.4; the §5.15 production evidence below was measured over the 26 of 2026-09-15). The split is confirmed end-to-end in production, not only in source: `GET /api/stats` (a helper route) carries `X-Request-Id: c961651b-33e9-43c7-ad5e-f2e340fa369b`, while `POST /api/checkout` 400 (a raw route) and `GET /` (a document) carry no such header at all (§5.15).
2. Every route that answers JSON from a handler sets `export const dynamic = "force-dynamic"` — 24 of 26 did at authoring (`emails/preview`, `jobs/config` and `jobs/reconcile` did not, which was correct for the first (dev-only) and harmless for the other two, `13`); **all 35 today** — `config` and `reconcile` gained it in the fix passes and the six later routes were written with it.
3. Only the two element routes are CDN-cacheable, via `READ_CACHE` → `Cache-Control: public, max-age=5, s-maxage=10, stale-while-revalidate=30` (`lib/route.ts:47-50`); every other read route recomputes per request.
4. Rate limits exist on ten route files plus the job/admin gates, keyed per-IP (`scope:${ip}`) and per-caller (`callerKey`, `lib/jobs.ts:183-191`): `lib/rateStore.ts` keeps an in-process map unless Upstash is configured, and a missing store still means "allowed" **by default** (`14` prices that; R20-8's acceptance). The four senders whose limiter *is* the abuse control — waitlist (both limiters), checkout, report — pass `onStoreError: "closed"` (R14-2); the job/admin throughput throttle is fail-open by design (`lib/jobs.ts:202-203`) and the auth-denied meter is closed (`:297-305`). At authoring five call sites answered 429 and `/api/report` answered 200 with a note; R11-5 fixed report to refuse (§5.6, R11-5).
5. Auth is never inferred from the body except where the docstrings say so: `jobAuth` accepts `Authorization: Bearer` (`CRON_SECRET`) or a matching body secret — the query-string form the original sentence carried was deleted by `14` R14-8; `adminAuth` accepts `Authorization: Bearer` (`ADMIN_TOKEN`, or a named operator token) only; management routes accept `ptl_manage` only (`lib/jobs.ts:53-71,88-98` today; `:19-31,34-41` at authoring, `lib/manage.ts:110-120`).
6. The plan's five specific demands, as stated: no route may return a success-shaped body when its dependency failed; no public route may leak an email (`/api/startups/[domain]` is the one to check hardest); every `/api/admin/*` route is authenticated **and audited**; `/api/dev/pay` and `/api/emails/preview` are dead in production. Observed answers are §5.9-§5.11 and R11-1, R11-3, R11-4.

## 4. The path walked

1. Enumerate the tree and diff it against the plan's list (§5.1); extract methods, `maxDuration`, and which primitives each route imports (§5.2).
2. Walk every route in `next dev` with a uniform matrix — correct method, wrong method, `OPTIONS`, and the documented edge inputs — recording status, `x-request-id`, cache headers and body (§5.3-§5.7).
3. Re-run the gate-sensitive routes on a production-mode build (`next start`) where `NODE_ENV=production` and each dev-only branch differs (§5.8-§5.10).
4. Failure injection: stop the database and re-walk the read routes and `/api/checkout`; restart and confirm recovery (§5.11). This is the only way to answer "no success-shaped response when a dependency failed" honestly.
5. Walk `POST /api/checkout`'s validation order in a script and record which rejection each input produces (§5.12); read `lib/contracts.test.ts` for the fields the suite pins.

## 5. Live evidence

2026-09-15, this host. Two servers: `npx next dev -p 3215` and `npx next start -p 3211` after `npx next build` — both against a local Postgres 16 that replays migrations `0000`-`0006` and both seeds (§12 of `07`/`12`), and both mine for this batch (a sibling session held `:3212`, which no figure here uses). Probe scripts live in the session directory, not the repo: `routes.mjs`, `route-matrix.mjs`, `checkout-flow.mjs`, `limits-and-headers.mjs`, `prod-mode.mjs`.

**5.1 Inventory.** `app/api/**/route.ts` → 26 files. The plan's list (line 124) is the same 26 names in the same order. **Amended 2026-09-16 (PR `26` audit):** 35 files today; §5.2's flag matrix below is the at-authoring abridgement and has not been re-walked column by column — the wave-4 sweep re-verified the routes it samples, and F-010's refresh covers the counts and cites, not the full matrix. `routes.mjs` reports per file: exported methods, `maxDuration`, and the set of contract primitives imported.

**5.2 Flag matrix** (`routes.mjs` output, abridged to the distinguishing flags).

| Route | Methods | `maxDuration` | Auth | `rateLimitAsync` | Envelope | Cache |
| --- | --- | --- | --- | --- | --- | --- |
| `activity` | GET | — | — | — | `apiJson` | — |
| `admin/outbox/retry` | POST | — | `adminAuth` | — | `apiJson`+`apiError` | — |
| `admin/reports` | GET | — | `adminAuth` | — | `apiJson` | — |
| `admin/reports/[id]` | PATCH | — | `adminAuth` | — | `apiJson`+`apiError` | — |
| `admin/startups/[domain]/moderate` | POST, GET | — | `adminAuth` | — | `apiJson`+`apiError` | — |
| `board` | GET | — | — | — | `apiJson`+`apiError` | — |
| `checkout` | POST | 60 | — | yes (5/h) | raw (19 sites) | — |
| `dev/pay` | POST | — | provider mode only | — | raw (10) | — |
| `elements` | GET | — | — | — | `apiJson` | `READ_CACHE` |
| `elements/[sym]` | GET | — | — | — | `apiJson`+`apiError` | `READ_CACHE` |
| `emails/preview` | GET | — | `NODE_ENV` gate | — | raw (1) | — |
| `jobs/config` | GET, POST | — | `jobAuth` | — | raw (1) | — |
| `jobs/outbox` | POST, GET | 30 | `jobAuth` | — | raw (1) | — |
| `jobs/reconcile` | GET, POST | — | `jobAuth` | — | raw (1) | — |
| `jobs/screenshot` | POST, GET | 30 | `jobAuth` | — | raw (1) | — |
| `manage/request` | POST | — | — | yes (10/h) | raw (5) | — |
| `manage/session` | GET | — | `ptl_manage` | — | raw (2) | — |
| `manage/verify` | POST | — | — | yes (20/h) | raw (5) | — |
| `report` | POST | — | — | yes (10/h) | raw (3) | — |
| `search` | GET | — | — | yes (60/min) | `apiJson`+`apiError` | — |
| `startups/[domain]` | PATCH | — | `ptl_manage` | yes (30/h) | raw (5) | — |
| `stats` | GET | — | — | — | `apiJson` | in-process 30 s |
| `table-order` | GET | — | — | — | `apiJson` | — |
| `unsubscribe` | GET, POST | — | — | — | raw (1) | — |
| `waitlist` | POST | — | — | yes (10/h) | raw (4) | — |
| `webhooks/stripe` | POST | 60 | HMAC signature | — | raw (16) | — |

Consequences visible in the matrix alone: the four `/api/jobs/*` routes and both money routes (`checkout`, `webhooks/stripe`) are the only ones given a `maxDuration`; the cache is on two routes; the throttle is on seven.

**5.3 Observed status matrix** (`route-matrix.mjs`, dev `:3215`; every request also checked for `x-request-id`).

| Request | Status | Body, distinguishing part |
| --- | --- | --- |
| `GET /api/activity?limit=3` | 200 | `{"activity":[…]}` + reqId |
| `GET /api/board` · `?tab=crowns` | 200 | grouped crowns + reqId |
| `GET /api/board?tab=nope` | 400 | `{"error":"Unknown board tab.","code":"BAD_TAB"}` + reqId (`board/route.ts:87`) |
| `GET /api/elements` | 200 | 122 rows, `s-maxage=10, stale-while-revalidate=30` |
| `GET /api/elements/Ts` · `/ts` | 200 | canonical symbol; same cache header |
| `GET /api/elements/Xx` | 404 | `{"error":"Element not found","code":"NOT_FOUND"}` + reqId |
| `GET /api/stats` | 200 | `{"elementsTotal":122,"claimedElements":26,"unclaimedElements":96,"stakeCount":34,"totalStakedUsd":720}` |
| `GET /api/table-order` | 200 | 10 rails |
| `GET /api/search?q=stripe` · `q=` | 200 | 442 B hit list · `{"results":[]}` |
| `GET /api/unsubscribe?token=…` | 200 | HTML confirm form, **no reqId** |
| `GET /api/manage/session` (no cookie) | 401 | `{"error":"No management session."}`, no reqId |
| `GET /api/emails/preview` | 500 | **empty body, no reqId** (R11-1) |
| `POST /api/dev/pay` with GET | 405 | empty body, no `Allow` |
| `GET /api/report` · `/api/waitlist` · `/api/manage/request` · `/api/manage/verify` · `/api/checkout` · `/api/webhooks/stripe` | 405 | empty body, no `Allow` |
| `GET /api/startups/stripe.com` | 405 | empty body, no `Allow`, no `content-type` |
| `GET /api/admin/reports` · `?status=nope` | 403 | `{"error":"forbidden"}` (no `ADMIN_TOKEN` in env) |
| `GET /api/admin/reports/<id>` | 405 | PATCH-only route |
| `GET /api/admin/startups/stripe.com/moderate` | 403 | same admin gate |
| `POST|GET /api/jobs/outbox` | 200 | `{"ok":true,"claimed":0,"completed":0,"failed":0}` — **unauthenticated** (R13-2) |
| `POST|GET /api/jobs/screenshot` | 200 | `{"ok":true,"checked":0,"updated":0,"failed":0}` — unauthenticated (R13-2) |
| `POST|GET /api/jobs/reconcile` | 200 | `{"ok":true,"paidTotal":7,"divergent":{…},"unverified":{…}}` — unauthenticated (R13-2) |
| `GET /api/jobs/config` | 503 | `{"ok":false,"env":"development","findings":[…]}` — unauthenticated, and *not* 401 (`13`) |
| `POST /api/board`, `PUT`, `DELETE` | 405 | empty body, no `Allow`; `OPTIONS` → 204 `Allow: GET, HEAD, OPTIONS` |
| `POST /api/checkout`, `PUT` | 405 | empty body; `OPTIONS` → 204 `Allow: OPTIONS, POST` |
| `HEAD /api/board` | 200 | Next answers HEAD from the GET handler |

**5.4 Error shape is two contracts, not one.** 11 routes import `apiError`/`apiJson` and emit `{ error, code }` plus `x-request-id`; the other 15 emit neither. The failure is visible in a single request: `GET /api/board?tab=nope` answers with a machine-readable `code`, while `GET /api/manage/session` answers `{"error":"No management session."}` with no code and no request id, and every framework-generated 405/handler-level 500 answers with a **zero-length body**. `lib/contracts.test.ts` pins the field names of the `apiJson` family (`reqId` presence, error shape) but not the raw family, so nothing fails when a raw route drifts.

**5.5 Caching.** Only `elements` and `elements/[sym]` carry `READ_CACHE`; observed `cache-control: s-maxage=10, stale-while-revalidate=30` on both, absent everywhere else. `/api/stats` instead memoises in module scope for 30 s (`stats/route.ts:8-9`), which is per serverless instance and invisible to the edge (`15` notes the consequence: N instances × 1 query/30 s).

**5.6 Rate limits** (from the call sites, then observed at the boundary with `limits-and-headers.mjs`).

| Key | Limit | Window | Answer at the boundary |
| --- | --- | --- | --- |
| `checkout:${ip}` (`checkout/route.ts:117`) | 5 | 1 h | 429 |
| `search:${ip}` (`search/route.ts:19`) | 60 | 1 min | 429 `{"error":…,"code":"RATE_LIMITED"}` |
| `report:${ip}` (`report/route.ts:13`) | 10 | 1 h | **200** `{"ok":true,"note":"rate-limited"}` (R11-5) |
| `waitlist:${ip}` (`waitlist/route.ts:20`) | 10 | 1 h | 429 |
| `manage:${ip}` (`manage/request/route.ts:18`) | 10 | 1 h | 429 |
| `manage-verify:${ip}` (`manage/verify/route.ts:11`) | 20 | 1 h | 429 |
| `profile:${ip}` (`startups/[domain]/route.ts:18`) | 30 | 1 h | 429 |
| — | — | — | **no limiter at all** on `/api/admin/*`, `/api/jobs/*`, `/api/dev/pay`, `/api/unsubscribe`, `/api/emails/preview`, `/api/webhooks/stripe`, and the five read routes (R11-4) |

The key is `${scope}:${ip}` where `ip` comes from `lib/ip.ts:20` — a client-settable header (`14` shows the header and prices the bypass). The store is `lib/rateStore.ts`; with no Upstash configured the limiter is an in-process `Map`, so the counts are per instance and reset on deploy.

**5.7 Input edges.** `/api/activity?limit=` → `-1` returns the **whole feed** (122 rows) because the clamp is `Math.min(parseInt(v) || 6, 20)` with no lower bound (`activity/route.ts:16`); `0` silently becomes 6; `abc` becomes 6; `1e9` becomes 20. All four answer 200 (R11-2). `GET /api/emails/preview?sym=<b>` and `?sym=<script>…` answer 500 before any body is written, so the unescaped interpolation in `emails/outbid.tsx:23` is currently unreachable (§5.8).

**5.8 `/api/emails/preview` is broken on every non-`receipt` path** (`emails/preview/route.ts:36`). Six variants requested:

```
(none)             -> 500 len=0   ?template=receipt       -> 200 len=1179
?template=outbid   -> 500 len=0   ?template=receipt&sym=Fe-> 200 len=1181
?sym=C             -> 500 len=0   ?template=nope          -> 500 len=0
?sym=Ts            -> 500 len=0
?sym=<script>alert(1)</script> -> 500 len=0
```

Server log, verbatim: `⨯ TypeError: Cannot convert argument to a ByteString because the character at index 23 has a value of 55357 which is greater than 255.` with the frame `at GET (webpack-internal:///(rsc)/./app/api/emails/preview/route.ts:44:12)`. The route puts the **subject line** into a response header (`X-Subject-Preview`), and the subject is `` `You were knocked off ${sym} 👑` `` (`emails/outbid.tsx:14-15`) — U+1F451 is not a ByteString. Index 23 tracks the payload length (`Ts` → 24, the 26-character script payload → 47), so the throw is unconditional on this branch. The transpiled line number is 44; the source line is 36. R11-1.

**5.9 `/api/admin/*`.** All four admin surfaces are `adminAuth`-gated, fail closed when the token is absent (403 in dev *and* production, `lib/jobs.ts:34-41`), and three of the four write an `AuditLog` row: `PATCH /api/admin/reports/[id]` → `REPORT_TRIAGED` (`admin/reports/[id]/route.ts:35-41`), `POST /api/admin/startups/[domain]/moderate` → `PROFILE_MODERATED` (`…/moderate/route.ts:20-51`, the `POST` handler; the row itself is written by the shared `applyModeration` at `lib/moderation.ts:98-104`, called at `route.ts:43-48`), and the third, `POST /api/admin/outbox/retry`, writes **none** — it resets the outbox row's `attempts` and `nextAttemptAt` for a redelivery and touches no `AuditLog` (`admin/outbox/retry/route.ts:26-29`) → R14-9. Read side: `GET /api/admin/reports?status=<anything>` passes the string straight into the `where` clause (`admin/reports/route.ts:12`), so an unknown status is a silent empty list rather than a 400 (R11-6); the list is capped at 50 with no cursor, so a busier queue is unpageable.

**5.10 Production-mode gates** (`next start -p 3211`, `NODE_ENV=production`, no Stripe keys, no `RESEND_API_KEY`).

- `GET /api/emails/preview` → **404 `{"error":"Not found."}`** (`route.ts:9-10`) — dead in production as claimed, and the gate is `NODE_ENV`, so the only environment where the R11-1 bug can be hit is a dev build.
- `POST /api/dev/pay {"paymentId":"probe-prod-pending-0001"}` → **200 `{"ok":true,"status":"paid","terminal":true,"elementSymbol":"F"}`** for a `PENDING` dev payment, with a real `Stake`, `Payment.status=paid`, a `ProviderEvent(dev.simulated-payment, applied)`, a completed `RECEIPT_EMAIL` outbox row and a `STAKE_ANALYTICS` row. The gate is `getProviderMode() !== "dev"` (`dev/pay/route.ts:15-16`), and `getProviderMode()` returns `"dev"` whenever either Stripe key is absent (`lib/stripe.ts:28`) — it never consults `NODE_ENV`. The route's own docstring (`dev/pay/route.ts:9-13`) states it "can never grant stakes for free in production": false as written (R14-1 owns the analysis and the reachability chain).
- `POST /api/dev/pay` with an empty body → **500**, empty body (`await req.json()` is uncaught at `route.ts:17`): a request-shape error answered as a server fault.
- `POST /api/checkout {}` → **403 `{"error":"Payments are paused — join the waitlist.","waitlist":true}`**: the flag gate fires before validation, so in an unconfigured production deployment the contract a bidder sees is "paused", never "misconfigured" (`06` owns the UI text).

**5.11 Dependency-failure honesty** — database stopped, then restarted (`docker stop`/`start` on the scratch container; §12).

| Request while the DB was down | Answer |
| --- | --- |
| `/api/stats`, `/api/board`, `/api/elements`, `/api/elements/C`, `/api/activity`, `/api/search?q=au`, `/api/table-order` | **500, zero-length body, no `content-type`, no `x-request-id`** |
| `/` | **200 HTML, 151,414 B** — the shell is served and the board degrades client-side (`03` §6 owns the states) |
| `POST /api/checkout {}` | 403 "paused" — the flag reads env only, so a database outage is reported as a pricing decision |

After restart: `/api/stats` and `/api/elements/C` answer 200 with `x-request-id` again, same figures (122/26/34/720). So: no route invents a success-shaped body when Postgres is gone — but the failure is *also* not the documented envelope: a caller cannot tell "dependency failed" from "route crashed", and the request id that support would ask for is absent exactly when it is needed (R11-3). Emptiness is separately distinguishable: an element with no stakes answers 200 with `stakes: []` while an unknown symbol answers 404 `NOT_FOUND` (`elements/[sym]/route.ts`, §5.3), and an empty activity feed is a 200 with `activity: []`.

**5.12 Outbound dependency failure is a success shape.** `deliver()` returns `"logged"` when `RESEND_API_KEY` is unset (`lib/email.ts:36`) — not an error. In this environment every queued message therefore completed: the 60-row drain reported `claimed 20/20/20/0, completed 20/20/20/0, failed 0`, and `EmailLog` holds **32 rows, all `status='logged'`** (7 receipt, 14 report, 11 waitlist). Nothing in `/api/jobs/outbox`'s response distinguishes "60 emails delivered" from "60 emails written to the log and dropped" (R13-1 owns the queue semantics and R13-3 the operations reading; the contract reading is here: the job's success body is not evidence of the dependency's work).

**5.13 Checkout validation order** (`checkout-flow.mjs`, dev `:3215`, plus a read of `checkout/route.ts:100-300`): flag 403 → partial-Stripe warning → rate limit 429 → JSON parse 400 → honeypot 400 → attest 400 → Turnstile 400 → `elementSym` 400 → `idempotencyKey` ≥ 8 chars 400 → `amountUsd` integer ≥ 1 400 → email capture → `validateCheckoutInput` (title 2-32, pitch 2-140) 400 → domain canonicalisation → element 404 → advisory lock → `classifyAndValidate` 409 (`{error, code, takeLead}`) → reservation conflict 409 `RESERVATION_CONFLICT` → provider down 502 → 200 `{paymentId, checkoutUrl, provider, reservation?}`. Idempotent replay is looked up **before** the element check, so a replay answers even if the party has since been hidden (`08` owns the rule); a key reused with a different fingerprint is 409 `IDEMPOTENCY_CONFLICT`. Every one of these codes is in the raw family — `checkout` doesn't import `apiError`, so the money route's refusals carry no `code` for most branches… (it does return `code` fields in the JSON it builds by hand — see R11-3 for the header/`reqId` half only).

**5.14 Contract tests.** `lib/contracts.test.ts` asserts the `apiJson`/`apiError` envelope (shape, `reqId`, `x-request-id`) and the read-route field names; no test asserts that a raw route returns `reqId`, which is why R11-3's 15 routes can drift silently. `npx vitest run lib/contracts.test.ts` passes on `9681bdc`.

**5.15 Production observations** (`https://www.periodictable.lol`, 2026-09-15, from this host). The deployed commit is `9681bdc` — the same sha this batch reviewed: `gh api repos/danilgorbunofff/PeriodicTable/commits/main` → `9681bdcbff24…` @ `2026-09-15T07:02:17Z`, and the newest Production deployment carries `9681bdcbff24` @ `07:03:42Z`. Four readings, all `curl.exe`:

- `POST /api/dev/pay {"paymentId":"00000000-0000-4000-8000-000000000000"}` → **403 `{"error":"Disabled when Stripe is enabled."}`** (44 B). The free-stake route is closed *today*, and the closed door is `getProviderMode() === "stripe"` (`lib/stripe.ts:28`) — so this single response is behavioural proof that **both** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are present in the production environment (values never read or printed). It is **not** evidence that the route is environment-gated: §5.10 shows the same production binary answering 200 for the same request when either key is absent (R14-1).
- `POST /api/checkout {}` → **400 `{"error":"Please confirm you own or may promote this URL.","field":"attest"}`**. Payments are live in production (the `paymentsLiveServer()` gate passed — `lib/flags.ts:10-19`; `06` owns the flow), the validator is reached, and the raw family does put `field` on the wire — but there is still no `code` and no `x-request-id` (R11-3; header absence re-measured last below).
- `GET /api/stats` → **`{"elementsTotal":122,"claimedElements":0,"unclaimedElements":122,"stakeCount":0,"totalStakedUsd":0}`**. Launch has no stakes at all: every adversarial negative in `14` was measured against an application holding no customer rows, and the rate limits of §5.6 are unexercised under production traffic (U11-4).
- `GET /api/elements` → `cache-control: s-maxage=10, stale-while-revalidate=30` on the wire, matching §5.5; `GET /api/board` answers `x-vercel-cache: MISS` with no `s-maxage`. The board page `/` is served `public, max-age=0, must-revalidate` with `x-vercel-cache: HIT` — the local `s-maxage=31536000` does not survive Vercel's normalisation (`15` §5 owns that reading).
- Request-id provenance, measured across the two families on the same host and minute: `GET /api/stats` → `X-Request-Id: c961651b-33e9-43c7-ad5e-f2e340fa369b` (the handler calls `apiJson`, `lib/route.ts:35-39`); `POST /api/checkout {}` → 400 `{"error":"Please confirm you own or may promote this URL.","field":"attest"}` with **no `X-Request-Id`** (`app/api/checkout/route.ts` hand-builds `NextResponse.json`); `GET /` → no `X-Request-Id` either (page routes are not part of the helper family). So the header is application-emitted by 11 routes, not platform-added for all responses — a support engineer reading production sees a traceable id exactly on the routes whose contract is already complete, and none on the 15 that are not (R11-3).

### 5.16 Fix verification

2026-09-16, this worktree, after the §11 fix pass. Like the `08`, `09` and `10` passes and unlike
`06`'s and `07`'s, this one ran against a real Postgres: the same `postgres:16-alpine` the `08`/`09`
passes used (`ptl-fix08-pg`, port `55433`, the port `.github/workflows/ci.yml` uses), with all nine
migrations `0000`–`0008` applied, so every DB-gated suite this doc's evidence came from executed
instead of skipping — including the three cases this pass added under `report`'s limiter and the
admin queue. The limits §2–§5 record are unchanged and are not narrowed here: no Stripe key, no
Resend key and no operator secret from production is reachable from this checkout, so a "settle" is a
`Payment` row this environment writes and a "send" is the `logged` branch, and no production request
was made. U11-1…U11-5 stand.

```
TEST_DATABASE_URL=… npm run test:ci → 49 files passed (49); 731 passed, 0 failed, 0 skipped (731)
npx vitest run (no database)        → 43 passed, 6 skipped (49); 622 passed, 109 skipped (731)
npx tsc --noEmit                    → clean
npx eslint app lib                  → clean (exit 0, no warnings or errors)
```

The first line is the CI-shaped run and satisfies CI's own gate (the workflow fails the build when the
log contains a skipped test; the grep against it finds nothing). The second is the shape §5.1–§5.15
were written from — 6 files and 109 tests skip there, every DB suite among them, and the honest bound
on what a checkout with no database proves: the boundary that answers a dead pool with a `503` is
exactly the code a database-less run cannot exercise. The pass moved the suite from `10`'s 712 to
**731 tests** (+19), and the movement is nameable: `lib/contracts.test.ts` (18 → 29: 9 boundary cases
and 2 wiring guards), `lib/ops.test.ts` (15 → 19, the metered gates), `lib/moderation.test.ts`
(10 → 13, the limiter and the queue), `lib/routes.test.ts` (1 case, the clamp). Four existing
assertions were repaired rather than added, all because the fix moved the fact they had pinned —
`lib/checkoutIntake.test.ts`'s slice of the idempotent replay, `lib/phase8.test.ts`'s two "the file
exports `GET`/`POST`" shapes and its `jobAuth` mention, `lib/readCache.test.ts`'s list-route export,
and `lib/emailPreview.test.ts`'s production `404` body, which now carries the boundary's `code`.

**The census moved, and the count in §1 is the at-authoring one.** This doc walked 26 files; the tree
holds **28** today, because two packs since then added a route each — `08` (`6e4eca7`) added
`app/api/jobs/abandoned-checkouts/route.ts` and `10` (`6dcd955`) added `app/api/webhooks/resend/route.ts`. Both are
covered by the boundary and by the guard, and the guard is why the number is safe to have drifted: it
reads whatever `app/api` contains rather than a list written into a test, so a 29th route that skips
`apiRoute` fails the suite instead of quietly joining the family. §5.1's inventory and §8's first
criterion keep their `26` as the record of what was walked; a future census should say `28` and name
these two.

Three things the verification itself found, in the order they matter.

- **The envelope reached a body a test pinned exactly (product, intended — recorded because it is
  the kind of change that looks like a regression).** The DB-less run failed
  `lib/emailPreview.test.ts` on `{error:"Not found."}` versus `{error:"Not found.", code:"NOT_FOUND"}`:
  the production `404` is now the boundary's answer, so it gained the code every non-2xx gets. That is
  R11-3 working, and the assertion was rewritten to pin the code *and* say why. Nothing else in
  either run moved: no 2xx body changed (the replay byte-equality case still passes), and no route's
  own message was replaced by a status message.
- **The cursor needed a tiebreak that the reading did not have (product).** `?before=` alone is not
  a stable page boundary when two reports share a `createdAt` millisecond — Prisma's cursor walks by
  the ordering, so a tie can repeat or skip a row at the seam. The fix makes `id` the secondary
  `orderBy` *and* the cursor (`admin/reports/route.ts:30-31`), and
  `lib/moderation.test.ts` asserts the seam: the `?before=` page starts at the row after the cursor,
  repeats nothing at or above it, composes with `?status=`, and answers an empty page — not a `500` —
  for a cursor id that does not exist.
- **A first draft of that case asserted the wrong invariant (test).** It claimed the two pages would
  be disjoint, which is false the moment the cursor is the first row of page one: the second page
  legitimately continues with rows the first already showed. Rewritten to assert what a cursor
  promises — nothing at or above the cursor repeats — which is the property that fails if the
  ordering loses its tiebreak.

What the pass deliberately did not take is worth as much as what it did.

- **`/api/unsubscribe` has no limiter, on purpose.** A mail client prefetches `List-Unsubscribe`
  links and a scanner finishes them; a limiter turns a prefetch into a failed unsubscribe, which is a
  worse outcome than the abuse it prevents (§9 Q5). The route validates its token, writes one row and
  redirects; the residual risk is recorded rather than gated.
- **`/api/dev/pay` is throttled at 30/hour per IP, not checkout's 5/hour.** The route exists to be
  called repeatedly during a rehearsal, and the 5-concurrent-settle probe of `15` was run through it
  deliberately; a limit that blocks the rehearsal is a limit someone removes. The limiter sits after
  the provider-mode gate so a closed route stays closed without touching the store (`phase7`'s
  ordering assertions still pass), and an unparsable body is now a `400 BAD_JSON` instead of an
  uncaught throw.
- **Job authentication is still fail-open outside production** — unchanged, and deliberately not half
  fixed here: R13-2 owns the decision, and the metering this pass added is orthogonal to it (a
  refused anonymous caller is not what the budget measures). R11-4 is fixed as a *limiter* finding;
  `13`'s row stands.
- **`/api/emails/preview`'s 500 is fixed by `10`, not here** (`10` §5.7 — the header that could not be
  encoded is gone and the route gates on the app env). This pass only re-read it and repaired the
  assertion the new envelope touched.

## 6. Failure and edge matrix

| Trigger | Answer — distinguishable from emptiness? |
| --- | --- |
| Unknown element symbol | 404 `NOT_FOUND` + reqId — yes |
| Element exists, no stakes | 200 `{stakes: [], pool: 0, count: 0}` — yes |
| Unknown board tab | 400 `BAD_TAB` + reqId — yes |
| Unparsable JSON on a write route | `checkout`/`admin/reports/[id]`/`moderate` answer 400 with a message; `dev/pay` answers **500** (uncaught `req.json()`) — no |
| Wrong method | 405 with **no body and no `Allow` header** — a client cannot discover the method (R11-3) |
| Rate limit on `checkout`/`search`/`waitlist`/`manage*` | 429 — yes. On `report`: 200 `{ok:true,note:"rate-limited"}` — no (R11-5) |
| Postgres unreachable | 500 empty body, no reqId; the HTML shell still 200s — no (R11-3, §5.11) |
| Resend key missing | Outbox reports completed; `EmailLog.status='logged'` — no (§5.12) |
| Stripe key missing | `/api/checkout` 403 "Payments are paused" — truthful to a bidder, wrong about the cause |
| Admin token missing/mismatched | 403 `{"error":"forbidden"}` in every environment — yes (fail closed) |
| `CRON_SECRET` missing in production | 401 on every job route (`lib/jobs.ts:24-26`) — yes; **off** production it is a 200 (§5.3, R13-2) |
| Empty body on `/api/dev/pay` | 500 — no (§5.10) |
| `?limit=-1` | Unbounded rows (R11-2) — no |
| Unknown `?status=` on `admin/reports` | 200 with an empty list (R11-6) — no |

Observed before the fix pass, so its citations are the behaviour of the day; §5.16 is the pass, and
the table below is the same questions asked of the current tree.

**After the fix pass** (§5.16), the rows whose behaviour changed:

| Trigger | Current answer |
| --- | --- |
| Wrong method | **405** `{error:"Method not allowed. Allowed: GET, HEAD, OPTIONS.", code:"METHOD_NOT_ALLOWED"}` with an `Allow` header and `x-request-id`; `OPTIONS` answers **204** with the same list. Every route file exports all six verbs through `apiRoute()`, so there is no route left where the framework answers instead |
| Unparsable JSON | A route that parses a body answers `400 BAD_REQUEST` (or its own message); `/api/dev/pay` answers **400 `BAD_JSON`** where it used to throw an uncaught `req.json()` into a 500 with no body |
| Rate limit on `/api/report` | **429** `{error, code:"RATE_LIMITED"}` — a client can no longer read "dropped" as "filed" (§5.16's first case) |
| Rate limit on `/api/admin/*` | **429** after authentication: 60 calls per minute per *credential* (hashed before it becomes a store key), per route. A probe with the wrong token is refused by the auth half and spends no budget, so one operator's typo cannot lock anyone out |
| Rate limit on `/api/jobs/*` | **429** after authentication: 30 per minute per credential, per route — an order of magnitude above the workflow's `*/10` tick, and below the stuck-retry loop `14` describes |
| Rate limit on `/api/dev/pay` | **429** at 30/hour per IP, after the provider-mode gate (§5.16, and §9 Q5 for why it is not checkout's 5/hour) |
| Any 2xx | Body unchanged, byte for byte; `x-request-id` is now always present, and an id that arrived in the request is reused rather than replaced |
| An error body that already had a `code` | Unchanged; one that had only `error` (or no body at all) gains the code for its status |
| A non-JSON error page | Left as it came back — a proxy's HTML or plain-text error is not ours to rewrite — but it now carries `x-request-id` |
| A route throws | **500** `{error:"Internal error.", code:"INTERNAL"}` with `x-request-id`, and the log line carries the same id |
| Postgres unreachable | **503** `{error:"Service unavailable.", code:"DB_UNAVAILABLE"}` with the same id in header and log — the seven routes that answered a zero-length 500 with no id (§5.11) are the reason the two are distinguished; the HTML shell still 200s |
| `?limit=-1` | Clamped to 1 at the floor and 20 at the ceiling; `?limit=abc` and no parameter both mean 6 |
| Unknown `?status=` on `admin/reports` | **400** `{error:"Unknown report status.", code:"BAD_STATUS"}`; `?status=OPEN` still works and the queue pages with `?before=<id>` on a stable `createdAt, id` order |
| `?before=` with an id that does not exist | 200 with `[]` — an empty page is the answer to an unknown position, not a fault |
| Anonymous job call outside production | **Unchanged** — still 200 where the secret is not enforced. `13` §7 R13-2 owns that decision; this pass's job work is the limiter behind the auth |
| `/api/unsubscribe` | **Unchanged** and deliberately so: no limiter (§9 Q5) |
| Resend key missing | **Unchanged** — the outbox still reports completed on the `logged` branch (§5.12) |

## 7. Findings

### R11-1 — The dev email preview 500s on every path but one

- **Severity.** P3 · **Category.** correctness
- **Evidence.** §5.8. `app/api/emails/preview/route.ts:36` sets `X-Subject-Preview` to `outbidSubject({ elementSymbol: sym })`; the subject is `` `You were knocked off ${sym} 👑` `` (`emails/outbid.tsx:14-15`), and a crown emoji is not a legal HTTP header value, so `undici` throws before the response exists. Observed: `500`, zero-length body, no `x-request-id`, for `(none)`, `?template=outbid`, `?sym=C`, `?sym=Ts`, `?sym=<script>…`, `?template=nope`; `?template=receipt` is 200 because it sets no such header. Server log: `TypeError: Cannot convert argument to a ByteString … value of 55357` with the frame `webpack-internal:///(rsc)/./app/api/emails/preview/route.ts:44:12` (transpiled; source line 36).
- **Reproduction.** `curl -i http://localhost:3215/api/emails/preview` on a dev build.
- **Proposed fix.** Strip or percent-encode non-Latin-1 characters for the preview header (e.g. `encodeURIComponent`), or return the subject in the body instead of a header. Note the latent second defect at the same site: `sym` reaches `outbidHtml` unescaped (`emails/outbid.tsx:23`), currently masked because the throw happens first — whoever fixes the header must escape or filter `sym` in the same change.
- **Fix.** The header is gone rather than encoded, which is the arm this row preferred: `10` §5.7 took the code half (the subject renders in an HTML banner, the route gates on `getAppEnv()` instead of `NODE_ENV`, and `?sym=` resolves through the canonical `ELEMENTS` lookup) and `lib/emailPreview.test.ts` asserts the retired header is *absent*, so the throw cannot come back by re-adding a header. This pass changed nothing in the route — it re-read it under the new boundary (§5.16) and repaired the one assertion the envelope moved. What the row contributes is the mechanism, and the mechanism is why "put the subject in a header" is not available again.
- **Status.** fixed — production was unaffected by the original defect (the route 404s there) and is unaffected now; `10` §7 R10-8 records the same route from the mail side.

### R11-2 — `/api/activity`'s limit is clamped at the top only

- **Severity.** P3 · **Category.** correctness
- **Evidence.** §5.7. `app/api/activity/route.ts:16` — `Math.min(parseInt(v) || 6, 20)`; no lower bound. `?limit=-1` → 200 with **122 rows** (the whole feed) instead of 6; `?limit=0` → 6; `?limit=abc` → 6; `?limit=1e9` → 20.
- **Reproduction.** `curl 'http://localhost:3215/api/activity?limit=-1' | jq '.activity | length'`.
- **Proposed fix.** `Math.max(1, Math.min(parseInt(v) || 6, 20))`, and treat a non-numeric value as 400 or as the default explicitly.
- **Fix.** Both ends, in one expression — `parseInt(…, 10)`, then `Number.isNaN(requested) ? 6 : Math.min(Math.max(requested, 1), 20)` (`app/api/activity/route.ts:21-22`). The non-numeric arm is the **default**, not a 400: the parameter is a display hint on a public read route, and a 400 would break a shared link or a client that sends `?limit=` empty, while the clamp is the contract that matters. `lib/routes.test.ts:410` asserts all four shapes against a real database: `-1` → 1 row, `1000000` → at most 20, `abc` → at most the default 6, `2` → exactly 2.
- **Status.** fixed — the amplification the row noted (a caller pulling the whole feed with one character) is gone; the feed is live-database-read only and the bound is now explicit at both ends.

### R11-3 — Two error envelopes, and the failure envelope is empty

- **Severity.** P3 · **Category.** contracts
- **Evidence.** §5.3, §5.4, §5.11, §5.15. 11 routes emit `{error, code}` + `x-request-id`; the other 15 emit neither. Framework 405s (six routes) and database-down 500s (seven routes) come back with a **zero-length body and no `x-request-id`**. Production reproduces the split on the wire: `/api/stats` 200 carries `X-Request-Id`, `/api/checkout` 400 does not. `lib/contracts.test.ts` pins the modern envelope only.
- **Reproduction.** `curl -i -X GET http://localhost:3211/api/report` (405, empty); stop Postgres and `curl -i http://localhost:3211/api/stats` (500, empty, no reqId).
- **Proposed fix.** Wrap the raw family in `apiError`/`apiJson` (or at least emit `code` + `reqId`), and add a route-level catch that answers a JSON 500 with the request id. Add a contracts test that asserts `x-request-id` on every `app/api/**` response, which is the cheapest guard against the split reopening.
- **Fix.** One boundary, adopted by all 28 route files, and the envelope is deliberately **header-first**. `apiRoute()` (`lib/route.ts:248`) returns all six verbs from one call — `export const { GET, POST, … } = apiRoute({ GET: listBoard })` — wrapping each in `withContract` (`:196`), which reuses an inbound `x-request-id` or mints one (`:137`), and answers an uncaught throw as JSON: **503 `DB_UNAVAILABLE`** when the throw is the pool being unreachable, **500 `INTERNAL`** otherwise, both with the id in the header *and* in the log line (`:167-215`). Unimplemented verbs answer `405 {error, code}` + `Allow` and `OPTIONS` answers 204 with the same list (`:217-234`) — the framework no longer speaks for any route. On the way out, `enforceContract` adds a `code` only to a refusal that lacks one and leaves a non-JSON error page alone; **2xx bodies are untouched byte for byte**, which is why checkout's idempotent replay still compares equal to its first response (`lib/routes.test.ts:230`) and why the split is closed without a round-trip through every consumer. The guard the row asked for is two cases in `lib/contracts.test.ts:149-170`: every `app/api/**/route.ts` must call `apiRoute(` and must not export a bare verb handler, and every `admin/`/`jobs/` file must go through its gate — the second half is what stops R11-4's loop from reopening. `lib/jobs.ts`'s `jobAuth`/`adminAuth` refusals answer through `apiError` too, so a refused operator gets the same envelope as everyone else.
- **Status.** fixed — the absent request id the row called the expensive half is now present on every response in the family, and the route-level guard means the 15-file split cannot recur without a test failing. What is *not* claimed: the 2xx bodies of the routes that hand-build `NextResponse.json` still carry no `reqId` field, because adding one would change bodies consumers already parse; the header is the contract, and §5.16 records that choice.

### R11-4 — The operator, job and money routes have no limiter

- **Severity.** P2 · **Category.** security
- **Evidence.** §5.2, §5.6. `/api/admin/*` (4 routes), `/api/jobs/*` (4), `/api/dev/pay`, `/api/unsubscribe`, `/api/emails/preview`, `/api/webhooks/stripe` and the five read routes call no limiter. `/api/admin/outbox/retry` will drain the queue on every call from anyone holding the token; `/api/dev/pay` settles a payment per call in dev mode with no throttle (the 5-concurrent-settle probe in `15` shows what it does to one element).
- **Reproduction.** `for i in $(seq 1 50); do curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $ADMIN_TOKEN" …/api/admin/outbox/retry; done` — every call is 200.
- **Proposed fix.** Throttle the admin and job surfaces per token as well as per IP (`lib/rateStore.ts` already supports arbitrary keys), and give `/api/dev/pay` the same IP limiter as checkout — a dev-mode endpoint is still a production surface when the provider mode falls back to dev (`14`).
- **Fix.** Metered gates beside the auth helpers, per **credential** rather than per IP because the cron workflow and an operator's shell both present that token from many addresses: `adminGate` (60/min) and `jobGate` (30/min) in `lib/jobs.ts:68-121`, each checking the credential **first** and only then spending a budget, so a wrong token is refused without consuming one. The key is `sha256(credential:salt).slice(0,16)` scoped per route (`callerKey`, `:81`) — a secret never lands in a store key, and one busy route cannot exhaust another. All nine admin and job route files now call a gate instead of the raw helper; §5.16's wiring case asserts none can go back. On the money route, `/api/dev/pay` takes a per-IP limiter at **30/hour** (`app/api/dev/pay/route.ts:45-46`), placed after the provider-mode gate so the closed-by-default path never touches the store, and an unparsable body is a `400 BAD_JSON` rather than an uncaught throw. `/api/unsubscribe` is left unthrottled on purpose and `/api/webhooks/stripe` keeps its signature-plus-idempotency defence — both argued in §9 Q5. The store is fail-open by design: a metering outage is not a reason to refuse the operator the one tool that drains a stuck queue, and §5.16 records that.
- **Status.** fixed — the limiter half, which is what this row registers. The unauthorised half is unchanged and stays where it was filed: `14` §7 R14-1 (dev-pay reachability) and `13` §7 R13-2 (job auth fails open outside production). The 50-call loop above now stops at the 61st call in a minute on an admin route and the 31st on a job route.

### R11-5 — `/api/report` answers a limiter rejection as success

- **Severity.** P3 · **Category.** contracts
- **Evidence.** §5.6. `app/api/report/route.ts:13-15` returns `{ok:true,note:"rate-limited"}` with 200 when the 10/hour key is exhausted. Observed at the boundary with `limits-and-headers.mjs`. Every other limited route answers 429.
- **Reproduction.** Eleven `POST /api/report` calls in one hour; the eleventh is a 200.
- **Proposed fix.** 429 with `{ok:false,code:"RATE_LIMITED"}` and keep the operator-facing "we may still have your report" wording in the form, not in the contract.
- **Fix.** `429` through the same envelope every other limited route uses — `apiError("Too many requests. Try again later.", {status:429, code:"RATE_LIMITED"})` (`app/api/report/route.ts:23`), with the route's docstring rewritten to state the contract rather than the old shape. The operator-facing assurance the row wanted kept lives in the form (`06`/`10` own that copy), not in the response. The anti-oracle arm was weighed and **not** taken: every other limited route in the product already answers 429, so refusing here reveals nothing an attacker cannot read off `/api/checkout`, while an indistinguishable success leaves a client unable to tell "reported" from "dropped" — the shape the plan's §2 forbids. `ReportResponse` in `lib/api.ts:193` narrows to `{ok:true}`, so the type no longer describes a `note` no caller can receive. `lib/moderation.test.ts` spends the whole hourly budget and asserts the eleventh call is `429 RATE_LIMITED` with an `x-request-id`, `error` text, and **no stored report**.
- **Status.** fixed — the 429 is now the whole answer; a caller that wants to know whether a report was filed has to read it from the response, which is the point.

### R11-6 — `?status=` on the admin report list is an unvalidated cast

- **Severity.** P3 · **Category.** correctness
- **Evidence.** `app/api/admin/reports/route.ts:12` — `status ? { status: status as never } : undefined`. Observed: `?status=nope` → 200 with an empty list (Prisma casts the string, matches nothing). The triage route validates the same vocabulary properly (`admin/reports/[id]/route.ts:20-22` → 400 `BAD_STATUS`).
- **Reproduction.** `curl -H "Authorization: Bearer $ADMIN_TOKEN" 'https://…/api/admin/reports?status=nope'` → 200 `{"reports":[]}`.
- **Proposed fix.** Validate against the same `STATUSES` array and answer 400 `BAD_STATUS`; also add a `?before=` cursor, since the list is capped at 50 (`admin/reports/route.ts:14-18`).
- **Fix.** The vocabulary is now one shared value rather than a route-local guess: `REPORT_STATUSES` / `ReportStatus` / `isReportStatus` live in `lib/api.ts:200-203`, and both admin report routes import them — the list validating `?status=` and answering `400 BAD_STATUS` (`app/api/admin/reports/route.ts:20`), the triage route validating its body against the same predicate. The `as never` cast that turned a typo into an empty list is gone, so the failure mode is a 400 that names the field instead of a 200 that quietly shows nothing. Paging is additive: `?before=<id>` (`:27-31`) becomes a Prisma `cursor` with `skip:1` and `orderBy:[{createdAt:"desc"},{id:"desc"}]`. The secondary `id` sort is the load-bearing part — reports filed in one bot burst share a `createdAt`, and without it a page boundary repeats or skips rows. A cursor id whose report has since been deleted answers `200` with an empty page, not a 500: a stale operator bookmark is not a server error. Both halves are pinned in `lib/moderation.test.ts`: `?status=nope` and `?status=open` → 400 `BAD_STATUS` against `?status=OPEN` and no parameter → 200, then a cursor walk that asserts no row at or above the cursor ever repeats.
- **Status.** fixed — the filter is validated against one shared list and the queue is walkable past 50; the reproduction above now returns `400 BAD_STATUS`.

## 8. Acceptance criteria

- [x] All 26 routes under `app/api/` walked; the plan's list and the tree agree (`§5.1`)
- [x] Method, auth, inputs, validation, status, error shape, rate limit and caching recorded per route (`§5.2`-`§5.7`)
- [x] Observed response captured for every route (`§5.3`)
- [x] No email leaked by `/api/startups/[domain]`: PATCH-only, `ptl_manage`-gated, answers `{ok:true,domain}` and a `changed` list; no email field in any branch (`§5.9`, `startups/[domain]/route.ts`)
- [x] Every `/api/admin/*` route authenticated (fail-closed 403, all environments) — audited: 2 of 3 mutations yes, retry no (`14` R14-9)
- [x] `/api/emails/preview` dead in production (404, `§5.10`) — and broken in dev (R11-1)
- [ ] `/api/dev/pay` dead in production — **false**: 200 and a real stake (§5.10, R14-1); the fix pass added the missing limiter but left reachability to `14`
- [x] Failure vs emptiness answered for every route (`§6`), including the database-down case (`§5.11`)
- [ ] Live-host spot-check of the 405/500 bodies — U11-3
- [ ] Authenticated admin success bodies — U11-1

Budget: every read route ≤ 200 ms warm locally and ≤ 20 KB (measured in `15`); the *contract* budget — one envelope, one request id, a `code` on every refusal — is met as of the fix pass: every route in the family is now built by `apiRoute`, and `lib/contracts.test.ts` fails if one is not.

**Fix-pass criteria** (2026-09-16, verified by §5.16):

- [x] One boundary: all 28 route files are declared through `apiRoute` and set `x-request-id` on every branch, including the ones they hand-build — asserted per file by the wiring case (`lib/contracts.test.ts:149-170`), not by inspection
- [x] Every refusal carries a `code`, and an uncaught throw becomes a `500 INTERNAL` / `503 DB_UNAVAILABLE` with the request id that was already on the wire (`lib/contracts.test.ts`, 9 boundary cases)
- [x] The 2xx bodies this doc sampled are byte-identical to §5.3 — the envelope is a header plus error-only additions, and the checkout replay equality in `lib/routes.test.ts:230` proves it for the money path
- [x] `/api/activity`'s `?limit=` is clamped at both ends (`lib/routes.test.ts:410`)
- [x] `/api/report` answers `429 RATE_LIMITED` at the limit and stores nothing for the refused call (`lib/moderation.test.ts`)
- [x] Admin and job routes are metered per credential: `adminGate` 60/min, `jobGate` 30/min, credential checked before the budget is spent, and none of the nine files calls the raw auth helper (`lib/ops.test.ts`, `lib/contracts.test.ts`)
- [x] `?status=` on both admin report routes is validated against one shared list and `?before=` pages the queue
- [x] Suite green with zero skips against a real Postgres: 49 files, 731 tests (§5.16)

## 9. Open questions

1. ~~Is the split error grammar intentional (old routes left alone) or drift?~~ **Answered, 2026-09-16.** Drift. Nothing in the repo, the docstrings or the commit history says otherwise, and the split ran along the seam between the five routes that used `apiJson` and the twenty-three that hand-built `NextResponse` — a wire shape decided by which file happened to be edited last. The fix takes the cheap side of the fork the question posed: one boundary (`apiRoute`) with the request id as a **header**, so the routes that hand-build their 2xx bodies keep those bodies byte-for-byte while the refusals gain the `code` field they were missing. That the guard test in §5.16 would have caught the original split is the test of the answer, and it now exists.
2. ~~Should `/api/report`'s limiter answer be indistinguishable from success (anti-oracle) or explicit?~~ **Answered, 2026-09-16: explicit.** R11-5's ambiguity is resolved toward the 429, for three reasons. Every other limited route in the product already answers 429, so the limiter's existence and its boundary are public regardless; the anti-oracle arm therefore buys nothing an attacker cannot read off `/api/checkout`. Indistinguishable success leaves a *client* unable to tell "reported" from "dropped", which is the §2 prohibition this plan exists to remove. And the operator-facing assurance the old 200 carried — "we may still have your report" — belongs in the form copy, where it is addressed to a person, not in a response a client parses. The arm that remains open is the inverse: if a later threat model wanted an indistinguishable answer it would have to change every limited route at once, and that is a `13`/`14` question, not a contract one.
3. Should the job routes answer 401 rather than 200 in a non-production environment, given that preview deployments share the production database (`14` §5)? R13-2 argues yes on the grounds that the *database* is production even when `NODE_ENV` is not. **Left to `13`, unchanged by this pass** — R11-4 meters the job routes but deliberately does not touch what a wrong token gets, precisely so the two rows stay separable.
4. Who calls `/api/jobs/config` and `/api/jobs/reconcile`? ~~The docstrings say "the external pinger" and nothing in the repo provisions one.~~ **Settled in `13` §5.13**: `.github/workflows/outbox-tick.yml:78-98` calls both on its `*/10` tick, and it is the only caller in the repo; the "external pinger" named in `jobs/reconcile/route.ts:94-99` does not exist in the repository. What remains open is the tick's real cadence, which `13` measures.
5. Why is `/api/unsubscribe` the one write route left unthrottled? Because its caller is not a person clicking a link — mail clients and scanners prefetch URLs in a message body, and each prefetch would spend budget the recipient's own click needs. A limiter here converts a prefetch into a failed unsubscribe, which is a compliance failure, not a security win: the route takes an address-scoped token (legacy listing tokens still resolve), its `GET` renders a form and never mutates, its `POST` answers the same body whether or not the token resolves, and the worst a flood achieves is a repeated `UPDATE` of a suppression row the caller had to hold a valid token to reach. `lib/rateStore.ts`'s per-IP keying is also the wrong shape for it, since one recipient's client retries from several addresses. This is a deliberate non-take, recorded in §5.16 alongside the store's fail-open behaviour; the same reasoning is why `/api/dev/pay` sits at 30/hour and not at checkout's 5/hour — it is a developer's hand-run endpoint behind its own mode gate, not a customer path, so the limiter's job there is to stop a runaway loop, not to ration a scarce resource.

## 10. Cross-references

- Envelope and request-id helpers: `lib/api.ts`, `lib/route.ts`; the suite that pins them: `lib/contracts.test.ts` (§5.14).
- Checkout's validation order and idempotency rules are the money path's (`06` §? — rejection matrix, `08` — replay/conflict semantics); this doc records only the HTTP order and the codes.
- `/pay/[paymentId]` provider gating and `PaySimulator.tsx` are settled in `05` §7 R05-8; not re-reported.
- The 30 s polling surfaces are accepted risk (`05` §9 Q2); the retry latency behind them is measured in `15` §5.
- Job schedules, leases and failure visibility: `13`. Threat model and ranked exploitability: `14`. Cost and latency: `15`.
- Ledger citations: `doc/PROD-READINESS-CHECKLIST.md` §J (job auth), §E (envelope) — cited by section, not re-derived.

## 11. Change log

- 2026-09-15: authored 2026-09-15 against `9681bdc`, from the reads and probes in §5 (local dev + local production-mode build over a scratch Postgres 16 replaying migrations `0000`-`0006`); nothing fixed, no production request, no production write.
- 2026-09-16: **fix pass** against the same checkout, verified against a scratch Postgres 16 at migrations `0000`-`0008` (§5.16). Fixes: R11-3 — one boundary (`apiRoute`/`withContract` in `lib/route.ts`, with `codeForStatus`, `isConnectivityFailure`, `inboundRequestId`, `jsonBody`, `notAllowed`/`allowedOptions`), all 28 route files converted and their handlers renamed to private impls; a 9-case boundary suite plus a per-file wiring guard in `lib/contracts.test.ts`. R11-4 — `adminGate` (60/min) and `jobGate` (30/min) in `lib/jobs.ts`, keyed per credential by a salted digest (`callerKey`) and scoped per route, with the credential checked before any budget is spent; 9 admin/job route files switched; `/api/dev/pay` gained a per-IP limiter and a `400 BAD_JSON` body path; 4 gate cases in `lib/ops.test.ts`. R11-2 — `?count=` clamped to 1-20. R11-5 — `429 RATE_LIMITED` through `apiError`, `ReportResponse` narrowed to `{ok:true}`. R11-6 — `REPORT_STATUSES`/`isReportStatus` in `lib/api.ts`, both admin report routes validating, `?before=` cursor with a stable secondary sort, 3 DB cases. Two decisions: the envelope stays **header-first** so no 2xx body a consumer parses changes shape, and the operator budgets are **per credential**, not per IP, because the cron workflow and an operator's shell both present that token from many addresses. The route census reads 28 files today against §5.1's 26 — `08` and `10` each added one (§5.16). Test movement: 712 → **731** in 49 files, all green with zero skips; `tsc --noEmit` and `eslint app lib` clean. Commits: this doc's fix pack and the `00-REVIEW-PLAN.md` tracker row.
- 2026-09-16 (working tree) — re-verification fix, §5.9 plus §1/§2/§3's citation set. **The `moderate` anchor was mislocated, not out of range:** §5.9 cited `…/moderate/route.ts:60-66` for the `PROFILE_MODERATED` audit row, but at that commit those lines were the `GET` handler's guard and lookup (that file was 68 lines then and is 65 today) — a readable range pointing at the wrong verb, and at a row the route never wrote: it comes from the shared `applyModeration` at `lib/moderation.ts:98-104`. The fix names `:20-51` (the `POST` handler) and `route.ts:43-48` where the helper is called; the same pass corrects the third admin surface's clause, since `/api/admin/outbox/retry` writes **no** `AuditLog` row and resets the row's `attempts`/`nextAttemptAt` (`admin/outbox/retry/route.ts:26-29`). Five further citations named lines their files did not have when written — every one of those files is the same size or larger today, so a HEAD-based check reads fine and only an at-the-time check catches it: `next.config.mjs:1-46` → `:1-44`; `lib/jobs.ts:33-45` → `:34-41` in §2 and again in §5.9 (`adminAuth`'s true span in a 41-line file; it sits at `:87` in today's 347-line one); `lib/jobs.ts:19-31,33-45` → `:19-31,34-41` in §3; `lib/manage.ts:110-121` → `:110-120` (`manageCookieHeader`); `admin/reports/[id]/route.ts:44-49` → `:35-41` (the `REPORT_TRIAGED` audit call in a 43-line file). R11-1's `emails/preview/route.ts:44` stands unchanged: it is a transpiled stack frame quoted verbatim, with §5.8's source line 36 beside it. No claim, verdict or count changed.
- 2026-09-16 (working tree, PR `26` final-verification audit) — the F-010 refresh plus F-012's two token spellings. §1/§3/§5.1's counts now carry their today-value beside the authoring-day reading (26 → 35 routes; 11-of-26 → 21-of-35 error-grammar imports; force-dynamic 24-of-26 → all 35; the limiter census is ten route files plus the job/admin gates, with the four closed senders named); §3.3's READ_CACHE cites `lib/route.ts:47-50` and quotes the full header it emits today; §2's Operator and Scheduler rows and §3.5 spell the bearer forms as `Authorization: Bearer` (`ADMIN_TOKEN` / `CRON_SECRET`) the way the rest of the set does, note that the query-string secret form R14-8 deleted is gone, and cite today's `jobAuth`/`adminAuth` spans (`:53-71,88-98`) beside the authoring ones. No verdict changed.


## 12. UNKNOWN log

**Note (2026-09-16, fix pass).** No row was retired and none moved closer to being answerable: the pass
ran against a scratch Postgres and a local container, which by construction cannot answer what these
rows ask — every one of them needs a request to the deployed host, the operator secret, a DNS zone, or a
provider console. U11-5 was already settled by file read in `13` §5.13 and the fix pass did not disturb
it. The two rows the fix pass *did* touch in the code are U11-1 and U11-3, and neither is answered by
that: the admin success bodies still have no observed sample, and the 405/500 bodies were still only
observed locally.

| Id | Unknown | What settles it |
| --- | --- | --- |
| U11-1 | What `/api/admin/*` returns on success (report list shape, triage echo, moderation echo) | `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://www.periodictable.lol/api/admin/reports` from a shell that holds the operator secret |
| U11-2 | Whether a real Resend send returns the same status the skipped path records | One send with `RESEND_API_KEY` set, then `SELECT status FROM "EmailLog" ORDER BY "createdAt" DESC LIMIT 1` |
| U11-3 | Whether Vercel's edge rewrites any of these bodies or headers (405 bodies, empty 500s, `Vercel-CDN-Cache-Control`) | `curl -i https://www.periodictable.lol/api/report` (405) and any 5xx observed live; compare with §5.3 |
| U11-4 | Route latency against Neon rather than a local socket | Same matrix against the deployed host, or a Neon branch with this checkout pointed at it |
| U11-5 | ~~Whether anything actually calls `/api/jobs/config`~~ — **settled, `13` §5.13**: `.github/workflows/outbox-tick.yml:78-98` calls `config` and `reconcile` on a `*/10` tick and is their only caller; the residual unknown is that tick's *real* cadence and whether the "external pinger" in `jobs/reconcile/route.ts:94-99` also exists outside the repo | Settled by file read (`13` §5.13); the residual is `13` U13-1 and U13-4 |
