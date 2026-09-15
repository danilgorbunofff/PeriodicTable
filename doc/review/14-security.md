# 14 — Security

| | |
|---|---|
| **Phase · batch** | 3 · platform (contracted-cabinet review, doc 14 of 15) |
| **Status** | draft |
| **Date reviewed** | 2026-09-15 |
| **Commit reviewed** | `9681bdcbff2435ef258224c52000e0f8d6089f5c` |
| **Reviewer** | review agent (batch 3) |

This document was written around an external security review that ran first, per the batch-3 brief. The
reviewer's findings table, its explicit "not a finding" verdicts and its unresolved items are reproduced in
§4 before anything else, so the reader can see exactly what the second opinion was and where this document
agrees, narrows or extends it. Where this document disagrees with the reviewer, it says so in the finding.

| Probe not run | Why | Residue |
|---|---|---|
| Live exploit of a two-account IDOR against a **real** second customer's data | Requires creating a second paying customer on the live deployment (real money, real mail, real data mutation). Prohibited: no destructive or billable provider operations. | The authorisation model is read from source (§5.5) and exercised only against local rows I created myself (`ptl_review`), never against production rows. |
| Turnstile challenge solving / bot throughput measurement | Would require a real bypass of an anti-abuse control against the live site. | `verifyTurnstile` behaviour read from `lib/abuse.ts` and its fail-open matrix recorded (§5.12) as *unconfigured in the environments I can see*; production configuration stays UNKNOWN (U14-3). |
| Upstash-backed limiter behaviour under load | No Upstash credentials in this checkout, and connecting a shared store to a live deployment is not mine to do. | `UpstashStore` read in full (§5.6) including the 1500 ms timeout and the fail-open path; the **unconfigured** path is what is exercised. |
| Production `Payment` / `PaymentProvider` row inventory | No production database credentials here, and reading customer payment rows is not required for the verdict. | Carried as U14-1; it is the one fact that decides whether R14-1's failure mode can strand an existing buyer. |
| Secret-value inspection in Vercel (env list, log search) | Read-only on a provider console I cannot authenticate to from this environment; and a *presence* check is not a value check — the rule is to name secrets, never print them. | Every secret in §5.2 has its presence proven by behaviour where possible; the rest are U14 rows with the exact settling command. |
| Full preview-alias enumeration | Only the deployment URLs returned by the GitHub deployments API were tested; one branch-alias form did not resolve from this host (`curl` exit `000`). | Recorded as U14-4 with the enumeration command; the tested aliases were uniformly SSO-gated (§5.3). |

## 1. Scope

**Owns.** The security posture of the platform as deployed: the threat model (§3), each attacker goal the
plan names, walked against source and the live deployment (§5), the control inventory — response headers
and CSP, Turnstile, rate limiting and its store, the secret inventory and the transport of each secret,
magic-link token construction, webhook signature verification, dependency advisories, log hygiene and
error-body leakage (§5.1–§5.13, §6), and the findings ranked by exploitability (§7).

**Does not own.** Money-path correctness (doc 06–08: whether a settlement is right, not whether it can be
triggered by a stranger), the board's rendering rules (doc 03), the mail *copy* and cadence (doc 10 — this
document owns only the injection and relay properties of the templates), and PII retention/deletion
mechanics (doc 12 §7 owns the schema and the deletion path; this document owns whether a stranger can read
the data those mechanisms protect).

**Scope correction to the plan.** The plan's §2 lists "all 27 routes" under `app/api/`; the tree contains
**26** (`app/api/**/route.ts`, 26 files). The extra route in the plan's count is `app/api/dev/emails/preview`,
whose real path is **`app/api/emails/preview/route.ts`** (no `dev/` segment) — resolved against the tree, not
renamed here. Likewise the plan asks for a security review of `/api/dev/pay` and `/api/emails/preview` as
"dead in production": they are dead by **two different mechanisms** with very different robustness, and that
difference is R14-1.

**Paths inspected.** `app/api/**/route.ts` (26), `lib/ip.ts`, `lib/rateStore.ts`, `lib/rateLimit.ts`,
`lib/abuse.ts`, `lib/jobs.ts`, `lib/manage.ts`, `lib/stripe.ts`, `lib/env.ts`, `lib/flags.ts`, `lib/audit.ts`,
`lib/outbox.ts`, `lib/screenshots.ts`, `lib/validate.ts`, `lib/startups.ts`, `lib/email.ts`, `emails/*.tsx`,
`emails/escape.ts`, `next.config.mjs`, `app/pay/[paymentId]/page.tsx`, `app/api/unsubscribe/route.ts`,
`app/go/[stakeId]/route.ts`, `vercel.json`, `.github/workflows/outbox-tick.yml`, `package.json`,
`ops/accepted-advisories.json`, `scripts/audit-prod.mjs`. No `middleware.ts` exists anywhere in the tree.

## 2. Actors

| Actor | Trust | What they hold | What they can reach |
|---|---|---|---|
| **Anonymous internet caller** | none | a browser, `curl`, and control of every request header | all 15 unauthenticated routes; the rate limiter key (`cf-connecting-ip`, §5.6); the waitlist mail path (§5.7) |
| **Listing owner** — a startup that paid to stake | self-asserted, email-proven | a `ManageToken` (256-bit, 15 min, single-use, §5.5) | `PATCH /api/startups/[domain]`, `GET /api/manage/session` — **for their own domain only** |
| **Paying customer** | proven by Stripe | Stripe Checkout session + receipt mail | settlement is provider-driven; they never hold an app credential |
| **Operator** | high | `ADMIN_TOKEN`, `CRON_SECRET`, Neon console, Stripe dashboard, Vercel console, Resend console | the four `/api/admin/*` routes, the four `/api/jobs/*` routes, the database, the mail pipeline |
| **Scheduler** | `CRON_SECRET` | Vercel cron (2 entries) and GitHub Actions (1 workflow) | `POST|GET /api/jobs/*` |
| **Infrastructure** | trusted third parties | Stripe (money), Resend (mail), Microlink (screenshots), Vercel (edge/host), Upstash (limiter store), Cloudflare Turnstile (anti-abuse) | the callbacks and outbound fetches in §5 |
| **Third-party victim** | none — *not* a user | a mailbox an attacker knows | the waitlist confirmation mail (§5.7) |
| **Competitor of a listed startup** | none | the public board | the board, `/api/report` (§5.7), the listing's public fields (§5.9) |

The distinction that matters for this document: the listing owner is the only actor with a *self-service*
write to another table, and in production that capability is currently **unreachable** (`lib/manage.ts`
drops the link and logs a warning instead of mailing it — §5.5). Everything else writes through a
provider or through the operator.

## 3. Intended behaviour

The controls as designed, in the order a hostile request meets them:

1. **Transport and browser controls** — `next.config.mjs` sets CSP (production only), HSTS, `nosniff`,
   `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin` and a
   `Permissions-Policy` that closes camera, microphone and geolocation, on every path (`/:path*`).
   There is no `middleware.ts`, so nothing else runs before a route.
2. **Bot control** — `lib/abuse.ts` verifies a Cloudflare Turnstile token when `TURNSTILE_SECRET` is set;
   the design intent is "challenge anything anonymous that can spend money or send mail".
3. **Rate limiting** — `lib/rateStore.ts` keys a 10 000-bucket counter on `clientIp(headers)`; the intended
   production store is Upstash (shared across instances) with a per-instance `MemoryStore` fallback.
4. **Route-level authority** — `lib/jobs.ts` gates the four `/api/admin/*` routes on `ADMIN_TOKEN`
   (fail-closed when unset) and the four `/api/jobs/*` routes on `CRON_SECRET` (same); `lib/manage.ts`
   gates profile writes on a short-lived single-use token bound to a purpose and a domain.
5. **Provider authority** — money state changes only from a signature-verified Stripe webhook
   (`lib/stripe.ts`), never from a client.
6. **Deployment authority** — dev surfaces are meant to be unreachable where they are dangerous: the
   provider-mode gate on `/api/dev/pay` and the `NODE_ENV === "production"` gate on
   `/api/emails/preview`.
7. **Dependency authority** — `ops/accepted-advisories.json` + `scripts/audit-prod.mjs` make the accepted
   advisory set explicit, with a TRIPWIRE line and an expiry, so an upgrade cannot be quietly skipped.

## 4. The path, walked

### 4.1 Security review — findings as reported

Presented first, per the batch-3 brief, in the exact form the security-review agent returned them
(severity labels rendered to the emoji form this review series uses). "Confidence" is the reviewer's, out
of 10.

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|---|---|---|---|---|
| 1 | 🟡 MEDIUM | `lib/ip.ts` | 5-7, 20 | The limiter key is attacker-chosen, so every per-IP abuse control in the app can be deleted with one request header. `clientIp()` prefers `cf-connecting-ip` (`:20`), but this deployment is not behind Cloudflare — production responses carry `Server: Vercel` and no `cf-ray` — and Vercel does not set that header, so it is a pure client-supplied value accepted verbatim (`:14-17`). Attacker gains unmetered `/api/waitlist`, `/api/report`, `/api/manage/request`, `/api/search`, `PATCH /api/startups/[domain]` and `/api/checkout` ⇒ third-party mail at unbounded recipient count, operator-inbox flooding, unbounded scraping, unlimited junk `Startup`/`Payment`/`ManageToken`/`Report` rows; combined with the instance-local `MemoryStore` fallback and `rateLimitAsync` failing open on any store error, the effective ceilings are decorative. | 10 |
| 2 | 🟡 MEDIUM | `app/api/waitlist/route.ts` | 20, 29-30, 56-63 | Anonymous third-party mail relay with no address-ownership proof. The caller-supplied `email` (`:29`) is only format-checked, then becomes the Resend recipient (`to: entry.email`, `:60`) in a mail sent from the brand's verified sending domain; the sole ceiling is the dedupe key `waitlist-mail:${email}:${hourBucket}` (`:61`, one mail per address per hour), unbounded across addresses once row 1's bypass is applied. The mail asks nothing of the recipient (no double opt-in), so nothing is proven about the address. Attacker gains brand-signed (DKIM-authenticated), attacker-targeted mail to arbitrary victims, plus reputation damage to the domain that carries outbid notices and receipts to paying customers. | 9 |
| 3 | ⚪ LOW | `lib/validate.ts`; `app/api/startups/[domain]/route.ts` | 153-157; 51-52 | Validation result is computed and thrown away: `validateProfileInput` only truthiness-tests `normalizeUrl(input.logoUrl)` (`:154`) and returns the un-normalised `base`, while the route persists the raw `body.logoUrl.trim()` (`:52`). The un-normalised value is emitted verbatim into public JSON (`/api/board`, `/api/elements/[sym]`, `/api/search`, `/api/table-order`), into Next metadata `images: [startup.logoUrl]` (`app/s/[domain]/page.tsx:34`) and into `<Avatar src>` (`:139`). Attacker gain: a listing owner can store an arbitrary unnormalised string (any scheme/host/credential form that merely passes `normalizeUrl`, plus unbounded length — no length check on this field) served to every visitor's payload and offered to third-party link unfurlers as `og:image`, i.e. a stored third-party request beacon and a public-payload integrity gap. Not XSS: React escapes, `javascript:`/`data:` cannot pass the truthiness gate, CSP `img-src` blocks third-party renders. Reachability is gated by the manage session, which production never issues. | 8 |
| 4 | ⚪ LOW | `package.json` | 21 | `next@14.2.35` is pinned to a version carrying nine advisories, two of them RCEs — GHSA-p293-qw3h-jr36 (unauthenticated RCE on Windows-hosted servers) and GHSA-2xp9-vwfh-vxw4 (unauthenticated RCE in the Image Optimization API when AVIF is used) — plus GHSA-p9j2-gv94-2wf4 / GHSA-89xv-2m56-2m9x (SSRF in rewrites / Server Actions on custom servers), GHSA-955p-x3mx-jcvp (unauthenticated disclosure of internal Server Function endpoints) and cache-confusion/DoS issues; `npm audit --omit=dev` reports `{"critical":1,"total":1}`. The reviewer verified the deployment does not reach the RCE/SSRF/disclosure paths (no `next/image` import, no `images` key in `next.config.mjs`, no `middleware.ts`, no `rewrites`, no `"use server"`, Linux hosting), so today's gain is the DoS/cache-confusion class; the risk is that the only thing preserving that verdict is the tripwire in `ops/accepted-advisories.json` — adding an image-optimizer config or hosting on Windows upgrades it to critical RCE with no code-review step. | 8 |
| 5 | ⚪ LOW | `app/api/jobs/reconcile/route.ts`; `app/api/jobs/config/route.ts` | 47; 35 | The ops secret is accepted from the query string (`req.nextUrl.searchParams.get("secret")`) rather than only from a header, and the runbook instructs operators to call the endpoint that way. Attacker gain: none directly, but `CRON_SECRET` lands wherever URLs are recorded — Vercel request logs, shell history, browser history, `Referer` on any outbound link — and possession of it unlocks `/api/jobs/*`, including `/api/jobs/outbox` (forces the mail pipeline) and `/api/jobs/screenshot`. | 7 |

### 4.2 Security review — judged *not* findings, with the reviewer's reason

- **`POST /api/dev/pay` free stakes — "unreachable in production."** Reviewer's reasoning: the live route
  answered `403 {"error":"Disabled when Stripe is enabled."}`; `getProviderMode() === "dev"` is additionally
  gated by `paymentsLiveServer()`; the simulator only acts on `Payment.provider = DEV` rows; and
  `app/pay/[paymentId]/page.tsx` `notFound()`s when the mode is not `dev`. The reviewer recorded one
  tripwire: on a non-production Vercel environment `VERCEL_ENV=preview` makes `isProduction()` false, which
  opens the dev gates **and** makes `jobAuth` fail open, and that is only safe because preview deployments
  are behind Vercel Authentication (observed: `401 "Protected deployment"` / `302` to `vercel.com/sso-api`).
- **Stripe webhook forgery/replay — "verification is sound."** HMAC-SHA256 over `` `${t}.${rawBody}` `` on the
  raw body, `timingSafeEqual`, `SIGNATURE_TOLERANCE_SECONDS = 300` in both directions before the digest
  comparison, missing/partial secret ⇒ `401`, replay neutralised by `ProviderEvent.providerEventId` dedupe,
  reversals classified before paid/failed, amounts re-validated against the `Payment` row, `providerRef`
  ownership checked before settling.
- **`emails/outbid.tsx` / `emails/receipt.tsx` do not import `esc()` — "not exploitable."** Every
  interpolated value is charset-constrained upstream: element names/symbols are code constants; the domain
  comes from `new URL().hostname` / `domainFromSocial`'s caller regex, none of which can contain `<`, `>` or
  `&`. Delivery is Resend's JSON API (no SMTP envelope), the recipient passes `normalizeEmail`, subjects are
  constants ⇒ no header injection either.
- **`app/api/unsubscribe/route.ts:22` returns `text/html` containing a caller-supplied token — "not XSS."**
  The token is written inside `value="…"` and `"` is stripped, so a breakout needs a quote that is removed;
  entity payloads (`&quot;`) are decoded *after* attribute parsing and stay inside the attribute value.

**This document agrees with rows 2–5's verdicts and disagrees with the `dev/pay` verdict.** The reviewer
tested *one* production deployment and concluded "unreachable"; this review agrees the route is closed
*today* (§5.3) and keeps it as a **P0** finding anyway (R14-1) because the gate it relies on is provider
mode, not environment — the same binary answers `200` and grants a real stake when either Stripe key is
missing, and `requireProdEnv()` has no call site to stop that from shipping. Doc 11 registered the
behavioural half (§5.10/§5.14 there); doc 14 owns the exploitability chain. Additionally, the
`emails/receipt.tsx` interpolation is now *demonstrated* rather than argued (§5.9) — the charset argument
holds, but it is the only thing holding.

### 4.3 Security review — unresolved items

1. Is `RESEND_API_KEY` live in production? Decides whether the relay actually delivers or is only logged.
2. Is `ADMIN_TOKEN` set in production? It is not in `REQUIRED_PROD_ENV` and `requireProdEnv()` is never
   called, so nothing proves it at boot.
3. Are Upstash and Turnstile configured? Scales finding 1 (shared vs per-instance limits) and says whether
   `verifyTurnstile` is a no-op.
4. Do any unprotected preview aliases exist? Only the deployment URLs from the GitHub API were tested.
5. Does the image-optimizer / AVIF tripwire still hold?
6. Does the production CSP actually block finding 3's third-party image render in browsers?

All six are carried into §12 as U14 rows with the exact command that settles each; item 6 is in fact
settled by the captured header in §5.1 (`img-src` is an allow-list, no wildcard), and item 5 by
`next.config.mjs` having no `images` key at all.

## 5. Live evidence

All timestamps 2026-09-15. `PROD = https://www.periodictable.lol`. Local servers are my own:
`npx next dev -p 3215` and a production build `npx next build` (exit 0) + `npx next start -p 3211` against
the throwaway database `ptl-review-pg-55440` (`ptl_review`). Port `:3212` in earlier notes belongs to a
sibling session and is cited nowhere in this document.

### 5.1 Transport and browser controls

Verbatim production headers, `curl.exe -sS -D - -o NUL https://www.periodictable.lol/`:

```
HTTP/1.1 200 OK
Cache-Control: public, max-age=0, must-revalidate
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://plausible.io
  https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https://*.microlink.io
  https://www.google.com https://*.gstatic.com; connect-src 'self' https://plausible.io;
  frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self';
  frame-ancestors 'self'
Permissions-Policy: camera=(), microphone=(), geolocation=()
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=63072000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Access-Control-Allow-Origin: *          <- platform-added; see below
Server: Vercel
```

What the CSP does and does not do:

- `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'` are all present —
  no `<object>` embedding, no base-tag hijack, no form exfiltration to a third party, no framing.
- `img-src` is an **allow-list with no wildcard**: `'self' data: https://*.microlink.io
  https://www.google.com https://*.gstatic.com`. This settles the reviewer's unresolved item 6: the logo
  render of finding 3 cannot reach an attacker-chosen host through `<img>`/`<Avatar>`.
- `script-src` carries `'unsafe-inline'` and no nonce (there is no `middleware.ts` to mint one), so an
  injection that survives React's escaping would execute. That is why the escaping analysis in §5.9 is
  load-bearing rather than decorative.
- **Dead Turnstile entries.** `script-src` and `frame-src` both allow `https://challenges.cloudflare.com`,
  and `next.config.mjs` emits that string unconditionally, while `lib/abuse.ts` only verifies a token when
  `TURNSTILE_SECRET` is set. If the widget is never mounted the CSP entry is inert; if it is mounted
  without the secret, the challenge is decorative (§5.12). Either way the header advertises a control that
  the code may not be enforcing — a reader of the headers alone would conclude a bot control exists.

`next.config.mjs` applies CSP only when `NODE_ENV === "production"` (`:37-38`), so **my local dev server
`:3215` serves no CSP at all** — worth stating because it means a dev-server probe can never disprove a
production CSP finding.

There is **no `middleware.ts`** anywhere in the tree (`glob **/middleware.ts` → 0; also none under `src/`),
so nothing gates a request before its route handler, and no nonce/CSP/`Origin` check is centralised.

**`Access-Control-Allow-Origin: *` on production `/`** — present on the HTML response and absent on
`/api/stats`. A `Select-String -SimpleMatch "Access-Control"` over all first-party `.ts/.tsx/.mjs/.js/.json`
(excluding `node_modules`/`.next`) returns **zero** matches, and the app defines no `headers()` entry for it
(`next.config.mjs` sets the five static headers above plus CSP, nothing else), so this header is added by
the platform, not by this repository. It is on a public, credential-free HTML document, so it is not a
finding; it is recorded so a future reader does not attribute it to app code.

### 5.2 Secret inventory and exposure

Read from `lib/env.ts` (`REQUIRED_PROD_ENV`, 9 names; `PROD_ENV_ADVISORIES`; `getProdConfigReport()`),
`lib/stripe.ts`, `lib/jobs.ts`, `lib/rateStore.ts`, `lib/abuse.ts`, `lib/ip.ts`, `lib/email.ts`.

| Secret | Purpose | Transport / consumer | Presence proven by |
|---|---|---|---|
| `DATABASE_URL` | Neon connection | `lib/prisma.ts` | `GET /api/stats` → `200` with a JSON body on PROD (a DB round-trip succeeded) |
| `STRIPE_SECRET_KEY` | provider mode + checkout session creation | `lib/stripe.ts` | `POST /api/dev/pay` → `403 "Disabled when Stripe is enabled."`, which requires `getProviderMode() === "stripe"` and therefore both Stripe names present (doc 11 §5.14) |
| `STRIPE_WEBHOOK_SECRET` | webhook HMAC | `lib/stripe.ts:172` region | same `403`; a missing secret makes the webhook answer `401`, not `403` |
| `PAYMENTS_LIVE` | master money switch | `lib/flags.ts:10-19` | not provable from outside; inconsistent state would show as the payment link on `/` (U14-2) |
| `ADMIN_TOKEN` | 4 admin routes | `x-admin-token` header (`lib/jobs.ts:33-45`) | **not proven present**; `GET /api/admin/reports` without it answers `403` whether or not it is set (fail-closed) — U14-2 has the settling command |
| `CRON_SECRET` | 4 job routes | `Authorization: Bearer` **or** `?secret=` (`reconcile/route.ts:47`, `config/route.ts:35`) | **not proven present**; `GET /api/jobs/config` without it → `401` (§5.3) |
| `RESEND_API_KEY` | outbound mail | `lib/email.ts` | **not proven**; locally unset, so every `EmailLog` row I created is `status='logged'` (§5.7) — U14-3 |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | shared limiter store | `lib/rateStore.ts` | **not proven**; if absent the code logs `rate-limit: no shared store configured … using instance-local memory` once per process — U14-3 |
| `TURNSTILE_SECRET` | bot challenge | `lib/abuse.ts` | **not proven** — U14-3 |
| `CLICK_SALT` | salts the report `ipHash` | `/api/report/route.ts:44-46`, `lib/ip.ts` | not provable from outside; a missing salt falls back to the literal `"ptl-dev-salt"` |
| `REPORT_NOTIFY_EMAIL` | report destination | `/api/report/route.ts:71` | not provable; defaults to `abuse@periodictable.lol` |

**No secret is in the client bundle.** `Select-String -SimpleMatch` over every file in `.next\static`
(production build) for `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `ADMIN_TOKEN`,
`CRON_SECRET`, `TURNSTILE_SECRET`, `CLICK_SALT`, `UPSTASH_REDIS_REST_TOKEN`, `DATABASE_URL` → **0 matches
each**. `NEXT_PUBLIC_PAYMENTS_LIVE` also matches 0, with the caveat that Next inlines the *value* of a
`NEXT_PUBLIC_*` variable and erases the name, so that row is a "the name is absent" negative, not a
statement about the value. Only one non-API route imports a server-only module — `app/pay/[paymentId]/page.tsx:2`
(`@/lib/stripe`) — and it is a server component; the rest of the app tree imports no server module, so the
bundle-negative is structural, not luck.

**`requireProdEnv()` has no call site** (`Select-String "requireProdEnv("` → definition only), so a missing
required secret degrades behaviour silently at runtime instead of stopping the deploy. `getProdConfigReport().ok`
fails only on the `required` list, i.e. it would report `ok: true` with `ADMIN_TOKEN` missing.

### 5.3 Attacker goal: a free stake through `/api/dev/pay`

Live, on PROD:

```
POST /api/dev/pay  {"paymentId":"00000000-0000-4000-8000-000000000000"}
  -> 403 {"error":"Disabled when Stripe is enabled."}          (44 B)

GET /api/jobs/config            -> 401  24 B  {"error":"unauthorized"}
GET /api/jobs/config?secret=wrong-secret-xyz
                                -> 401  24 B  {"error":"unauthorized"}
GET /api/jobs/reconcile         -> 401  24 B  {"error":"unauthorized"}
GET /api/admin/reports          -> 403  21 B  {"error":"forbidden"}
POST /api/admin/outbox/retry    -> 403  21 B  {"error":"forbidden"}
```

So **today the free-stake route is closed and both auth families fail closed with a byte-identical body**
for "absent" and "wrong" credentials — no oracle distinguishes a wrong secret from a missing one.

The gate, however, is provider mode, not environment. `app/api/dev/pay/route.ts:15-16` rejects only when
`getProviderMode() !== "dev"`, and `getProviderMode()` (`lib/stripe.ts:20-45`) returns `"dev"` whenever
**either** Stripe name is missing. It never consults `NODE_ENV` or `isProduction()`. The four-layer
behavioural matrix, all observed on the local production build (`:3211`) and reproduced in doc 11 §5.10:

| Environment state | `getProviderMode()` | `paymentsLiveServer()` | `POST /api/dev/pay` | `/pay/[paymentId]` |
|---|---|---|---|---|
| Stripe keys present (PROD today) | `stripe` | `true` | `403` | Stripe redirect |
| Stripe key absent, `NODE_ENV=production` | `dev` | `false` (flag off) | **`200` + real `Stake`** | simulator |
| Stripe key absent, `PAYMENTS_LIVE=true` | `dev` | `true` | `200` | simulator |
| Vercel preview (`VERCEL_ENV=preview`) | `dev` | `true` (default-live) | `200` | simulator |

The second and fourth rows are the finding. Row 4 is the reviewer's tripwire: on a preview deployment
`isProduction()` is false, so `paymentsLiveServer()` takes the "default live unless false" branch
(`lib/flags.ts:17`) and `jobAuth` fails open (`lib/jobs.ts`, reviewer's local read), which would mean free
stakes *and* unauthenticated `/api/jobs/*`. I tried to confirm reachability rather than assume it:

```
GET  https://<preview-deployment-url>/            -> 302 to vercel.com/sso-api (+ _vercel_sso_nonce)
GET  https://<preview-deployment-url>/api/stats   -> 302 to vercel.com/sso-api
POST https://<preview-deployment-url>/api/dev/pay -> 401 {"protection":{"auto_vercel_auth_redirect":true,
     ...,"vercel_auth_enabled":true},"error":{"code":"401","message":"Protected deployment"}}
```

Preview deployments are **SSO-gated**, and the newest of the 7 deployments listed by the GitHub deployments
API behaved identically to the one tested by the reviewer. The control that closes the free-stake path in
preview therefore lives in Vercel's project settings, not in this repository, and nothing in the repo fails
closed if it is turned off. One alias form I tried did not resolve from this host (`curl` exit `000`); I did
not enumerate every alias (U14-4).

There is a second, quieter path to the same place, which is what makes this P0 rather than "wait for an
upgrade": **the prerendered pages do not know about the mode at write time**. `app/pay/[paymentId]/page.tsx`
is `export const dynamic = "force-dynamic"` and calls `notFound()` for non-dev modes, so the page itself is
correct — but it imports `PaySimulator` unconditionally at `:8` (the client gate `paymentsLiveClient()` is a
hook, not an import guard), `app/page.tsx` carries no `revalidate`/`dynamic` and is served from Vercel's
cache (`X-Vercel-Cache: HIT`, `Age: 12548` in §5.1's capture), and nothing calls `requireProdEnv()`. A
deployment that loses `STRIPE_SECRET_KEY` — the silent failure mode `getProdConfigReport()` was written to
report and no one calls — therefore keeps serving a cached "payments paused" `/` while `/api/dev/pay` and
the simulator answer normally. Any pre-existing `Payment` row would still be `provider = STRIPE`, and
`/api/dev/pay` refuses those (`403`, simulator handles dev payments only), so an in-flight buyer in that
window is stranded rather than refunded. Production `Payment` / `PaymentProvider` row counts are U14-1.

**The contrast that fixes it is already in the repo:** `app/api/emails/preview/route.ts:8-10` gates on
`process.env.NODE_ENV === "production"` and returns `404` — an environment gate, which is why that route is
dead on every Vercel environment including previews, while `/api/dev/pay` is dead only while the keys happen
to be present.

### 5.4 Attacker goal: forge or replay a Stripe webhook — negative

Read in full (`lib/stripe.ts`) and confirmed by the reviewer's independent run:

- The raw body is read **before** JSON parsing, and the digest is HMAC-SHA256 over `` `${t}.${rawBody}` ``.
- `digestMatches` uses `timingSafeEqual`, and `SIGNATURE_TOLERANCE_SECONDS = 300` is applied to `t` in both
  directions **before** the digest comparison, so a stale `t` cannot be paired with a fresh digest.
- A missing or partial `STRIPE_WEBHOOK_SECRET` fails to `401` rather than skipping verification, observed
  live on the local build (`POST /api/webhooks/stripe` with no signature → `401`).
- Replay: `ProviderEvent` is keyed by `providerEventId`, so a re-delivered event is recorded once; statusless
  events are ignored with `200` so Stripe does not retry forever; reversals are classified before
  paid/failed; `ProviderMoney` re-validates amount and currency against the `Payment` row; `providerRef`
  ownership is checked before settling.

Residual risk is the 300 s window by design (a captured *valid* signed request can be replayed inside it,
which the idempotency key then absorbs), and the fact that the secret's value cannot be rotated from here.
Nothing to register as a finding.

### 5.5 Attacker goal: read or write another owner's data (IDOR) — negative

- **No `/api/payments/*` route exists** (26-route tree, §1). Payment state is reachable only through the
  server-rendered `/pay/[paymentId]` page, which requires the id (a cuid, not enumerable) and renders no
  other customer's data, and through provider-driven settlement.
- **Manage tokens** (`lib/manage.ts:44-72`): `randomBytes(32)` ⇒ 256 bits, stored **only** as sha256, TTL
  `MANAGE_TOKEN_TTL_MS = 15 * 60_000`, single-use via `consumedAt`, bound to `purpose: "profile-manage"` and
  to a domain. `GET /api/manage/session` and `PATCH /api/startups/[domain]` both re-derive the token, and the
  route additionally checks `session.domain !== domain` → `401`, so a valid token for `a.com` cannot write
  `b.com`. In production the token is never delivered: the production branch logs `console.warn` and drops
  the link (v2 TODO), which is why the whole capability is dormant.
- **Reports**: `GET /api/admin/reports` is `adminAuth`-gated (403 observed); the public surface is write-only
  intake.
- **Profiles**: `/api/board`, `/api/elements`, `/api/search`, `/api/table-order` return public listing fields
  only; the reviewer's row 3 enumerates exactly what a stored `logoUrl` can leak publicly, and it is not
  another owner's data.

### 5.6 Attacker goal: delete the abuse controls with one header — **reproduced**

`lib/ip.ts:14-20` takes `clientIp` from `cf-connecting-ip` first. PROD is on Vercel (`Server: Vercel`) and
carries no `cf-ray`, so the header is not set by the platform and a caller-supplied value is accepted
verbatim. Reproduced end-to-end on my own dev server `:3215`, two loops that differ **only** in that header:

```
node spoof.mjs        # fetch(), headers include a literal cf-connecting-ip
rotating ip=203.0.113.1  -> 200 {"ok":true,"id":"cmu2je2jc0000b4g812tayrsn"}
rotating ip=203.0.113.2  -> 200 {"ok":true,"id":"cmu2je2sr0005b4g8r2egcc6e"}
... 11/11 rotating IPs -> 200, 11 distinct WaitlistEntry rows ...
----
node spoof2.mjs       # same body, one fixed IP
control req 1 ip=192.0.2.55 -> 200 ...
control req 10 ip=192.0.2.55 -> 200 ...
control req 11 ip=192.0.2.55 -> 429 {"error":"Too many requests. Try again later."}
```

The fixed-IP loop proves the counter is per-key and binds at 10/h; the rotating loop proves changing the
header resets it. `SELECT count(*) FROM "WaitlistEntry"` after the probes: **34** rows, including
`control-1@example.com` … `control-10@example.com`. The same key feeds every limiter in the app:

| Route | Key | Limit (from source) | Verified |
|---|---|---|---|
| `POST /api/checkout` | `checkout:${ip}` | 5 / h | doc 11 §5 |
| `POST /api/report` | `report:${ip}` | 10 / h | 11th returns `200` + `{"ok":true,"note":"rate-limited"}`, not `429` (doc 11 R11-5) |
| `POST /api/waitlist` | `waitlist:${ip}` | 10 / h | §5.6 above |
| `POST /api/manage/request` | `manage:${ip}` | 10 / h | source (`manage/request/route.ts:18`) |
| `POST /api/manage/verify` | `manage-verify:${ip}` | 20 / h | source (`manage/verify/route.ts:11`) |
| `PATCH /api/startups/[domain]` | `profile:${ip}` | 30 / h | source (`startups/[domain]/route.ts:18`) |
| `GET /api/search` | `search:${ip}` | 60 / min | source (`search/route.ts:19`) |

All seven key strings and windows read from the call sites in one sweep (`Select-String "rateLimitAsync\(" app/api` → 7 matches).

Two independent multipliers make the ceilings weaker than they look:

1. **The store fails open.** `lib/rateStore.ts` `rateLimitAsync` catches every store error and returns
   `true` (`console.error("rate-limit store failed open:", e)`), and `UpstashStore` aborts after
   `AbortSignal.timeout(1500)`. A Redis hiccup therefore *raises* the effective limit to infinity for the
   duration, silently.
2. **The store may be per-instance.** With no Upstash configured, every Vercel instance keeps its own
   `MemoryStore` (10 000-bucket sweep), so the real ceiling is `limit × instances`, and the code says so
   once per process: `rate-limit: no shared store configured … using instance-local memory`. Presence of the
   Upstash names in production is U14-3.

`/api/admin/*` and `/api/jobs/*` have **no** limiter at all — they rely solely on their secret, which is the
right trade only because the secret is high-entropy; it does mean a leaked secret has no velocity limit
(R14-8).

### 5.7 Attacker goal: use the product as a spam relay

| Path | Recipient | Attacker-controlled? | Ceiling | Verdict |
|---|---|---|---|---|
| `POST /api/report` | `REPORT_NOTIFY_EMAIL ?? abuse@periodictable.lol` (`report/route.ts:71`) | no — operator only | 10/h (bypassable) | not a relay |
| `POST /api/waitlist` | **the caller-supplied address** (`waitlist/route.ts:60`) | **yes** | 1 mail per address per hour (`waitlist-mail:${email}:${hourBucket}`) and 10/h per IP (bypassable) | **relay** — R14-3 |
| `POST /api/manage/request` | the address on the listing, operator notice | no — the token is dropped in production | 10/h (bypassable) | not a relay; a DB row is written per call (§5.10) |
| `GET /api/emails/preview` | nobody — it renders HTML to the caller | n/a | none needed | dead outside `NODE_ENV=development` |

Reproduction of the waitlist case on `:3215` (same requests as §5.6), with the durable rows it leaves:

```
SELECT "to", template, status, detail FROM "EmailLog" ORDER BY "createdAt" DESC LIMIT 4;
control-10@example.com | waitlist | logged | You're on the waitlist (checkout-paused)
control-9@example.com  | waitlist | logged | You're on the waitlist (checkout-paused)
...
SELECT type, "dedupeKey", attempts, "nextAttemptAt", "completedAt" FROM "OutboxEvent"
  WHERE "dedupeKey" LIKE 'waitlist-mail:%' ORDER BY "createdAt" DESC LIMIT 3;
WAITLIST_EMAIL | waitlist-mail:control-10@example.com:497074 | 0 | 2026-09-15 10:41:47.102 | 2026-09-15 10:36:47.144
```

Every row is `status='logged'` because `RESEND_API_KEY` is unset locally: **delivery is not proven here**,
only the enqueue→drain→log chain (the inline 3 s/5-row drain of doc 05 §7 R05-7 completed each row within
~0.3 s of creation). Whether the production pipeline actually delivers is U14-3; if it does, an attacker
with one rotated header can send unbounded brand-signed mail to arbitrary addresses, one mail per address
per hour.

### 5.8 Attacker goal: SSRF through the screenshot worker — negative

`lib/screenshots.ts:59-96` (`probeShot`) fetches exactly one URL, `https://api.microlink.io/?url=<encoded>`,
and stores only results whose own URL is `*.microlink.io`; `isPublicHost` and `BLOCKED_HOST_SUFFIXES`
(`lib/validate.ts:24-63`) are re-checked at fetch time, blocking IP literals in any notation, `localhost`,
`metadata.*`, `instance-data.*`, `.local`, `.internal`, `.invalid` and the wildcard-DNS helpers
(`nip.io`/`xip.io`/`sslip.io`), with a 10 s abort. The user-supplied domain never becomes a fetch target for
our process — it becomes a query parameter to a third-party service that does its own fetching. The
metadata-endpoint class of attack is therefore out of reach; the residual is that Microlink is a
data-egress path by design (it learns which domains we screenshot), which is a product trade, not a finding.

### 5.9 Attacker goal: inject markup through domain / title / social / logo

Stored-field reachability first, then the escaping, because the answer differs per field:

- **`domain`** — `domainFromUrl` returns `new URL(url).hostname`, and `normalizeUrl` (`lib/validate.ts:1-20`)
  rejects non-http(s) schemes and any URL carrying credentials, lowercases the host and requires
  `isPublicHost`. For social listings the caller's handle must match `/^[a-zA-Z0-9._]{2,30}$/` **before**
  `domainFromSocial(handle)` is called (`lib/validate.ts:107-111`). A hostname or that handle can contain
  none of `<`, `>`, `"`, `&`. **This is what makes the two unescaped templates safe** — not any escaping in
  the templates themselves.
- **`title` / `pitch`** — length-bounded (2–32, 2–140) but not charset-bounded, so `<b>x</b>` is a legal
  title. React escapes it on the board; `emails/report.tsx:24,34,37` and `emails/waitlist.tsx:19` pass their
  strings through `esc()`. Title/pitch are **not** interpolated into the two templates that skip `esc()`.
- **`logoUrl`** — the checkout path cannot inject one: `lib/startups.ts:41` overwrites whatever the client
  sent with `https://www.google.com/s2/favicons?domain=${p.domain}&sz=64`. Only the manage-session route
  writes a caller value, raw (R14-5), and production never issues a manage token (§5.5).

Escaping, template by template:

| Template | Interpolated caller-reachable values | Escaping | Evidence |
|---|---|---|---|
| `emails/report.tsx` | `domain`, `reason`, ids | `esc()` (`:8,24,34,37`) | source |
| `emails/waitlist.tsx` | `domain` (subject line) | `esc()` (`:7,19`) | source |
| `emails/outbid.tsx` | `elementSymbol` ×2, `winnerDomain` | **none** | source; reviewer's row 4.2 verdict |
| `emails/receipt.tsx` | `elementSymbol` ×2, `elementName`, `domain` | **none** | **rendered witness below** |

Rendered witness on `:3215` (the `receipt` branch is the one that renders; the `outbid` branch 500s in dev,
which is doc 11's R11-1 and not re-reported here):

```
GET /api/emails/preview?template=receipt&sym=%3Cb%3Ex%3C%2Fb%3E   -> 200, 1202 B
<h1 ...>You&apos;re #1 in <b>x</b> (Carbon) ...</h1>
Your $21 stake puts you <strong>#1</strong> on <b>x</b>.
```

The tag is emitted **raw**, twice, while the same template hand-writes `&apos;` elsewhere — the author
escapes by hand where they remember to. Consequence: injection into these templates is one charset
regression in `validate.ts` away, and the CSP that would otherwise contain it ships with `'unsafe-inline'`
(§5.1). Registered as R14-4 (hardening), **not** as an exploit, and I say plainly that I agree with the
reviewer that it is not exploitable today.

Elsewhere in the app: the only `dangerouslySetInnerHTML` is JSON-LD built from constants, and
`app/api/unsubscribe/route.ts:22` returns `text/html` echoing a caller token inside `value="…"` with `"`
stripped (reviewer's verdict accepted; R14-6 records the residual).

### 5.10 Attacker goal: enumerate customer emails — negative

- `POST /api/manage/request` answers a **uniform 200** whether or not the domain exists (source; the token is
  produced only when a listing with an email is found). It does write a `ManageToken`-adjacent row per call,
  so it is a write-amplification surface under §5.6's bypass, not an enumeration oracle.
- `POST /api/waitlist` answers a uniform `{"ok":true,"id":…}` and the dedupe key is derived from the
  attacker's own address, so probing an address does not reveal whether it was already on the list.
- `/api/startups/[domain]` `PATCH` returns `401` for a foreign domain *before* any body validation, so it
  cannot be used to test which domains are registered — but note the 401-vs-400 ordering is observable: a
  caller can distinguish "domain not mine" (401) from "domain invalid" (400) only for the *same* domain, not
  for arbitrary ones.
- Public listing payloads include an owner email only where the product intends it (the listing's contact);
  the reviewer's row 3 covers the one field that can be made to beacon a third party.
- The `EmailLog` table is never exposed by a route.

### 5.11 Availability, honesty and error leakage

Failure injection against my local production build with the database stopped (doc 11 §5.14 has the full
matrix): every DB-backed JSON route answers `500` with a **0-byte body** in ~20 ms —
`/api/board`, `/api/stats`, `/api/elements`, `/api/activity`, `/api/search`, `/api/table-order`,
`POST /api/dev/pay` — while `/elements/He` and `/` answer `200` from cache. Two security-relevant
consequences:

1. **No stack, no SQL, no connection string reaches the client.** Next's production error handler emits an
   empty body; the Prisma `P1001` and the stack appear only in the server log. That is the right shape —
   but it also means the *client* cannot tell "broken" from "empty" (doc 11 R11-3, doc 15 owns the UX half).
2. **An outage masquerades as a product decision.** `POST /api/checkout` answers `403 {"error":"Payments are
   paused"}` when the database is down, because the flag check runs before the query. A customer reading
   that concludes the product paused payments; an operator watching status codes sees a 403 that looks
   deliberate. Registered by doc 15 (availability/honesty); recorded here because it is also a monitoring
   blind spot — nothing in the app alerts on it.

Log hygiene: `console.warn`/`console.error` sites I read log **names and codes, never values** — e.g.
Turnstile logs the ticket's error codes plus whether a remote IP was present; the limiter logs
`rate-limit store failed open`; the mailer logs the send outcome. `EmailLog.detail` stores a human string
(`"You're on the waitlist (checkout-paused)"`), not a provider id, so a mail-provider incident cannot be
traced to a message from the database (doc 13's finding). No secret value is interpolated into any log line
I read.

### 5.12 Turnstile, and what "fail-open" costs

`lib/abuse.ts`, read in full:

| State | `verifyTurnstile` behaviour |
|---|---|
| `TURNSTILE_SECRET` unset | returns `true` — **fail open**, with a one-line warning |
| token missing/empty | fails closed (`ok:false`) |
| Cloudflare network error | fails closed |
| Cloudflare says failure | fails closed, logging the error codes and whether a remote IP was present |

So the control is either enforcing or absent — never "enforcing badly" — and the failure mode I can observe
locally is the *absent* one. Combined with §5.1's dead CSP entries and R14-2's bypass, the anti-abuse story
currently rests on one control that may not be switched on and one that a header defeats. Presence of
`TURNSTILE_SECRET` in production is U14-3; the settling signal is the single warning line in
Vercel → Logs at process start.

### 5.13 Dependency advisories

`package.json:21` pins `next@14.2.35`; `npm audit --omit=dev` reports `{"critical":1,"total":1}`. The
accepted set is explicit in `ops/accepted-advisories.json` (entry carries a TRIPWIRE describing exactly the
condition that turns the acceptance into an incident — an image-optimizer `images` config or Windows
hosting) with `expires 2026-12-31`, and it is enforced by `scripts/audit-prod.mjs:17` via `npm run audit:prod`
(referenced in `README.md:77,91`). I verified the tripwire's precondition myself, twice: `next.config.mjs`
has **no `images` key** (grep, whole file read) and the tree imports `next/image` **nowhere**; the deployment
is Linux/Vercel. Registered as R14-11 — accepted risk with a real expiry, so the finding is the *expiry
mechanism's blast radius*, not the advisory.

### 5.14 The audit trail

`lib/audit.ts` writes `AuditLog` rows for `STARTUP_CREATED`, `PROFILE_UPDATED`, `REPORT_TRIAGED`,
`PROFILE_MODERATED` and the jobs' own actions. **Three of the four `/api/admin/*` surfaces write an audit
row; `POST /api/admin/outbox/retry` writes none** — it resets `attempts:0` and calls `drainOutbox`
(`app/api/admin/outbox/retry/route.ts:14-30`), and nothing else records that an operator did it. Doc 13 §9
and doc 11 §5.9 already noted the gap; doc 14 owns the finding (R14-9), because "every `/api/admin/*`
authenticated **and audited**" is a batch-3 plan requirement and this is the one that fails it.

### 5.15 Malformed-body handling — a negative result worth recording

A planned finding ("unvalidated non-string request fields produce uncaught 500s") is **not supported by the
probe**, and I am not registering it. On `:3215`, one fresh spoofed IP per request:

```
POST /api/waitlist       {"email":{"a":1}}                        -> 400 54B  {"error":"A valid email is required.","field":"email"}
POST /api/report         {"domain":123,"reason":"spam"}           -> 200 11B  {"ok":true}
POST /api/manage/request {"domain":123}                           -> 400 31B  {"error":"domain is required."}
POST /api/checkout       {"elementSymbol":"C","domain":"stripe.com","amountUsd":1,"email":{"a":1}}
                                                                  -> 400 76B  {"error":"Please confirm you own or may promote this URL.","field":"attest"}
GET  /api/emails/preview?template=receipt&sym=9                    -> 200 1179B (falls back cleanly to the default element)
```

No 500, no stack, no partial write. Three of four write routes type-check every field before use
(`manage/request/route.ts:27,30`; `waitlist/route.ts`; `checkout/route.ts` via its validator). `/api/report`
is the **most** defensive of the set: `report/route.ts:22` coerces the reason with
`(body.reason ?? "").toString().slice(0, 280).trim()` and `:24` keeps the domain only when it is a string —
a numeric domain becomes `null`, which is exactly why the probe answered `{"ok":true}`. Recorded because
negative results are evidence too, and because it narrows the 500-class to one route: doc 11's R11-1
(`/api/emails/preview` with an `outbid` template and a non-alphabetic symbol), cited here, not re-reported.

## 6. Failure and edge matrix

Attacker attempt → control → observed → residual, all against the 2026-09-15 build.

| # | Attempt | Control it meets | Observed | Residual |
|---|---|---|---|---|
| 1 | rotate `cf-connecting-ip` to nullify every limiter | `clientIp` + `rateLimitAsync` | **control defeated**: 11/11 rotating → `200`; fixed → 10×`200`, 11th `429` (§5.6) | every per-IP ceiling becomes per-header-value; R14-2 |
| 2 | blow up the limiter store to fail open | `rateLimitAsync` catch | **fails open by design** (§5.6) | unlimited during a store incident; no alert; R14-2 |
| 3 | `POST /api/dev/pay` for a `DEV` payment | provider mode | PROD `403`; with a Stripe key absent → `200` + real `Stake` | R14-1 (P0); previews additionally protected only by Vercel SSO |
| 4 | reach a preview deployment's `/api/dev/pay` | Vercel Authentication | `401 "Protected deployment"` / `302` SSO on tested aliases | not enumerable from here; U14-4 |
| 5 | forge/replay a webhook | HMAC + tolerance + dedupe | `401` without a signature; replay absorbed by `providerEventId` | 300 s window, idempotency-absorbed (§5.4) |
| 6 | read another owner's payment/profile | ids + `session.domain !== domain` | no `/api/payments/*`; `401` mismatch | cuid non-enumerability is the only barrier for `/pay/[id]` |
| 7 | mint a manage token for someone else's domain | 256-bit token, sha256-at-rest, 15 min, single-use, purpose-bound | uniform `200`; production drops the link entirely | dormant capability; R14-7 covers the dev-only `debugToken` |
| 8 | send mail to an arbitrary address via waitlist | format check + per-address/hour dedupe | accepted; row + outbox + `EmailLog` written | relay (R14-3); delivery unproven locally (U14-3) |
| 9 | flood the operator inbox via report | `REPORT_NOTIFY_EMAIL` | destination not attacker-chosen | volume only, gated by #1 |
| 10 | SSRF the screenshot worker | `isPublicHost` + Microlink indirection | no first-party fetch of the user URL | third-party egress by design (§5.8) |
| 11 | inject markup via domain/social handle | caller regex before `domainFromSocial` | blocked by charset, not by escaping | R14-4; one charset regression from live injection |
| 12 | inject markup via `logoUrl` | `normalizeUrl` truthiness only | raw string persisted (manage route only) | R14-5; unreachable in production today |
| 13 | reflect a token into HTML on `/api/unsubscribe` | quote stripping | `text/html` with the token inside an attribute | R14-6 |
| 14 | enumerate a customer email | uniform responses | no oracle found (§5.10) | — |
| 15 | leak internals from a crash | Next production error handler | `500` with a **0-byte** body; stack server-side only | client cannot tell broken from empty (doc 11 R11-3) |
| 16 | read secrets out of the browser | bundle hygiene | 0 matches for 9 server secret names in `.next/static` | `NEXT_PUBLIC_*` values inlined by design |
| 17 | abuse a leaked `CRON_SECRET` | no velocity limit on `/api/jobs/*` | 0-of-N auth failures alertable; secret also accepted in URLs | R14-8 |
| 18 | learn whether `ADMIN_TOKEN`/`CRON_SECRET` exist | fail-closed 403/401 | byte-identical bodies for absent vs wrong | — |
| 19 | send a non-string JSON field to a write route | per-route type checks | `400` naming the field on three of four routes; `/api/report` answers `ok:true` and sanitises the value to `null` | none observed (§5.15) |
| 20 | ask a non-production deployment for a manage token | `isProduction()` branch in `lib/manage.ts:65` | token returned in the response body (`manage/request/route.ts:37`) | R14-7; previews SSO-gated |

## 7. Findings

Ordered by severity, and each carries an **Exploitability** line because the plan asks for findings ranked
by exploitability: that line answers "what does it cost an attacker, today, from where they are?" — which is
often a different order from severity. (The `TEMPLATE.md` block has no such line; this document adds it and
docs 11–13 do not, deliberately, so the ranking request is answered in the artifact rather than only in §6.)

### R14-1 — A free stake is one missing environment variable away

**Severity** — P0 (silent, undetectable money/data loss if it fires)
**Exploitability** — latent. Not reachable on the reviewed production deployment (`403` observed, §5.3), and
preview deployments are behind Vercel SSO (§5.3). But the guard is *provider mode*, not environment: on any
production deployment that has lost `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` — including a bad
`vercel env` edit, a rotated key, or a restore into a fresh project — an unauthenticated `POST /api/dev/pay`
mints a real `Stake` in one request, with no credential, no payment and no signal.
**Category** — authorisation, money integrity. Doc 07 owns what a settlement does; this finding owns the
gate that decides who may trigger one.
**Evidence**
- `app/api/dev/pay/route.ts:15-16` — the only rejection is `getProviderMode() !== "dev"`; nothing reads
  `NODE_ENV` or `isProduction()`.
- `lib/stripe.ts:20-45` — `getProviderMode()` returns `"dev"` when **either** Stripe name is absent.
- `lib/flags.ts:10-19` — in production `paymentsLiveServer()` needs `PAYMENTS_LIVE === "true"` **and**
  `providerConfigured()`; with the flag set and the key missing, the "live" branch is what *opens* the
  simulator rather than closing it.
- Live PROD: `POST /api/dev/pay` → `403 {"error":"Disabled when Stripe is enabled."}` (44 B). Local
  production build `:3211` with the Stripe names unset: `200` + a `Stake` row (matrix in §5.3).
- `requireProdEnv()` is defined and **never called** (`Select-String "requireProdEnv("` → definition only),
  so nothing refuses to boot in that state; `getProdConfigReport().ok` would report `true` with
  `ADMIN_TOKEN` missing.
- `app/page.tsx` has no `revalidate`/`dynamic` → `/` is served from Vercel's cache (`X-Vercel-Cache: HIT`,
  `Age: 12548`, §5.1), so the storefront can keep advertising "payments paused" while the route pays out.
- `app/pay/[paymentId]/page.tsx:8` imports `PaySimulator` unconditionally; the mode check is a runtime
  `notFound()` plus a client hook (`paymentsLiveClient()`), not an import guard.
- The correct pattern is already in the repo: `app/api/emails/preview/route.ts:8-10` returns `404` on
  `NODE_ENV === "production"`, which is why that route is dead in *every* Vercel environment, previews
  included — the difference between an environment gate and a mode gate is exactly this finding.
**Reproduction** (own machine only)
```
npx next build && npx next start -p 3211     # with STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / PAYMENTS_LIVE unset
curl.exe -sS -X POST http://127.0.0.1:3211/api/dev/pay -H "content-type: application/json" \
  --data-binary "@payload.json"              # payload.json: {"paymentId":"<id of a DEV payment>"}
# -> 200 {"ok":true,...} and a new Stake row;  doc 11 §5.10 has the same walk with the response bodies
```
**Proposed fix** — three independent guards, because one is how this shipped: (a) make the dev route return
`404` whenever `isProduction()`, mirroring `emails/preview`; (b) call `requireProdEnv()` from a path that runs
at boot (or check `getProdConfigReport().ok` at the top of `/api/checkout` and `/api/dev/pay`); (c) make
`paymentsLiveServer()` require `providerConfigured()` in production *even when* `PAYMENTS_LIVE === "true"`,
so "live but unconfigured" resolves to "off", not "simulator". Then the two rows of §5.3's matrix that read
`200` become `404`.
**Status** — open (draft)

### R14-2 — Every per-IP abuse control is keyed on a header the caller writes

**Severity** — P1 (a control the operator believes is enforced is not)
**Exploitability** — highest in this document, and the cheapest: one request header, no account, no
timing, reproducible in seconds from any machine, with the whole effect visible immediately as `429`s that
stop appearing.
**Category** — abuse control / rate limiting.
**Evidence**
- `lib/ip.ts:14-20` — `clientIp()` prefers `cf-connecting-ip`; PROD answers `Server: Vercel` with no
  `cf-ray`, so the platform is not Cloudflare and the header is a pure client input.
- Reproduced end-to-end, §5.6: 11 rotating values → **11× `200`** (`WaitlistEntry` rows to prove it);
  fixed fresh value → **10× `200`, 11th `429`**; a second fixed value that an earlier loop had already
  exhausted → 11× `429` (proving the counter follows the header, not the connection).
- The ceiling it removes, route by route: checkout 5/h, report 10/h, waitlist 10/h, manage 10/h,
  manage-verify 20/h, profile 30/h, search 60/min (§5.6, keys and windows read from the call sites).
- `lib/rateStore.ts` — `rateLimitAsync` returns `true` on **any** store error
  (`console.error("rate-limit store failed open:", e)`), and `UpstashStore` aborts at
  `AbortSignal.timeout(1500)`, so a Redis incident silently raises the limit to infinity.
- With no Upstash configured the store is instance-local (`rate-limit: no shared store configured … using
  instance-local memory`), making the real ceiling `limit × live instances`. Presence of the Upstash names
  in production is U14-3.
- `/api/admin/*` and `/api/jobs/*` carry **no** limiter at all, so a leaked operator secret has no velocity
  ceiling.
**Reproduction** — `node spoof.mjs` / `node spoof2.mjs` (§5.6); same shape as the fragments quoted there.
**Proposed fix** — key on an identity the client cannot set: the platform-set hop (`x-forwarded-for` /
`x-real-ip` as Vercel writes them, verified per U14-5) or a Vercel-provided IP, and ignore
`cf-connecting-ip` unless the deployment is actually behind Cloudflare. Independently: log and alert on the
fail-open path ("store failed open" at error level, alert if it happens more than N times an hour), and for
the mail and money routes fail **closed** on store error instead of open. Add a limiter to the eight
operator/scheduler routes so a leaked secret is not unlimited.
**Status** — open (draft)

### R14-3 — Anonymous third-party mail relay through `/api/waitlist`

**Severity** — P1 (a paying-customer channel used to send attacker-chosen mail; brand and deliverability
damage, and it is invisible from our side)
**Exploitability** — high when mail is live: unauthenticated, one header (R14-2) to remove the address
ceiling, and one request per victim address; no account, no cost, no feedback to us.
**Category** — abuse / mail reputation. The mail *chain* is doc 05 §7 R05-7 and doc 10's subject; this
finding owns the recipient-authority question.
**Evidence**
- `app/api/waitlist/route.ts:20` limiter, `:29` the address comes straight from the body, `:60`
  `to: entry.email` — the caller's string becomes the Resend recipient, `:61` the only per-address ceiling is
  `waitlist-mail:${email}:${hourBucket}` (one mail per address per hour).
- The address is never confirmed: no double opt-in, and the mail states nothing the recipient asked for.
- Probe + durable proof, §5.7: 11 rotating-header requests → 11× `200`, 34 `WaitlistEntry` rows, and
  `EmailLog` rows `control-10@example.com | waitlist | logged | You're on the waitlist (checkout-paused)`
  with matching `OutboxEvent` rows (`WAITLIST_EMAIL | waitlist-mail:control-10@example.com:497074 |
  attempts 0`) completed ~0.3 s after creation — enqueue → drain → log, per `Send` row.
- `status='logged'` on every row because `RESEND_API_KEY` is unset locally: **delivery is not proven here**
  (U14-3). If it is live in production, the mail is DKIM-signed by the domain that also carries receipt and
  outbid notices to paying customers.
**Reproduction** — §5.7's loop with any address you control, then the two SQL reads quoted there.
**Proposed fix** — the cheapest correct shape is double opt-in: store the address as *pending* and send a
confirmation link; only a click makes it a waitlist entry. If product wants the instant confirmation, send
it only when the address was not already on the list *and* require a Turnstile token (which today may be
unset — U14-3), and raise the per-address bucket from one hour to 24. Either way, cap the number of
*distinct recipients* per IP per day, which is the metric the current design does not have.
**Status** — open (draft)

### R14-4 — Two mail templates interpolate without escaping; a charset check three modules away is the only guard

**Severity** — P2 (hardening; one regression from injecting HTML into customer mail)
**Exploitability** — none today. I accept the reviewer's verdict and state it plainly: every value these
templates interpolate is charset-constrained upstream or a code constant, so a stranger cannot reach them.
**Category** — output encoding.
**Evidence**
- `emails/report.tsx:8` and `emails/waitlist.tsx:7` import `esc()` from `emails/escape.ts`;
  **`emails/outbid.tsx` and `emails/receipt.tsx` do not** (`Select-String` over `emails/` → 2 matches,
  both in the escaping templates).
- Rendered witness, §5.9: `GET /api/emails/preview?template=receipt&sym=<b>x</b>` → `200`, 1202 B, body
  contains `<h1 …>You&apos;re #1 in <b>x</b> (Carbon) 🎉</h1>` and `Your $21 stake puts you <strong>#1</strong>
  on <b>x</b>.` — the tag is emitted raw, while the same file hand-writes `&apos;`.
- The guards that keep it unexploitable: `elementSymbol`/`elementName` are code constants;
  `winnerDomain`/`domain` come from `new URL().hostname` or from `domainFromSocial()` behind
  `/^[a-zA-Z0-9._]{2,30}$/` (`lib/validate.ts:107-111`), so no `<`, `>`, `"`, `&` can appear.
- The CSP would not contain it: `script-src 'self' 'unsafe-inline' …` with no nonce (§5.1).
**Reproduction** — the two `emails/preview` requests in §5.9; no mail is sent by that route.
**Proposed fix** — import `esc()` in both templates and wrap every interpolation (mechanical: `{esc(sym)}`,
`{esc(domain)}`, `{esc(name)}`). If HTML in mail is desired for a *deliberately* permissive field, then
sanitise at the write boundary instead and say so in the schema comment. This is a two-file change with a
one-line test per template.
**Status** — open (draft)

### R14-5 — The validated URL is thrown away and the raw one is stored

**Severity** — P2 (public payload integrity; a stored third-party request beacon)
**Exploitability** — latent. Requires a manage session to write, and production never issues a token
(`lib/manage.ts:65-68`), so no attacker can reach the write path today. The exposure is what happens when
the v2 manage pages ship, plus the fact that the *validator* is already wrong now.
**Category** — input validation / public serialisation.
**Evidence**
- `lib/validate.ts:153-157` — `validateProfileInput()` calls `normalizeUrl(input.logoUrl)` only as a
  truthiness test and then `return base`, i.e. the normalised value is computed and discarded.
- `app/api/startups/[domain]/route.ts:51-52` — the route persists `body.logoUrl.trim()` raw. No length cap
  on this field (title/pitch caps live in the same validator; `logoUrl` has none).
- The raw string is then emitted publicly: `/api/board`, `/api/elements/[sym]`, `/api/search`,
  `/api/table-order` payloads, plus `images: [startup.logoUrl]` metadata and `<Avatar src>` on
  `app/s/[domain]/page.tsx:34,139`.
- Not XSS and not a beacon *today*: React escapes, `javascript:`/`data:` cannot pass the truthiness gate,
  and the production CSP's `img-src` is a wildcard-free allow-list (§5.1) — so the third-party render the
  reviewer worried about is blocked in browsers. What survives is the unvalidated string itself.
**Reproduction** — with a manage token from a non-production run: `PATCH /api/startups/<domain>` with
`{"logoUrl":"https://user:pw@exAMPLE.com:8443/../x?a=1#b"}` then read `/api/board` and observe the
unnormalised value verbatim (no `https://` normalisation, no host lowercasing, no credential rejection).
**Proposed fix** — `logoUrl: normalizeUrl(input.logoUrl) ?? null` in `validateProfileInput`'s return, plus a
length cap (2048) and a rejection of control characters. The route then stores what was validated.
**Status** — open (draft)

### R14-6 — A caller-supplied token is reflected into an HTML response on `/api/unsubscribe`

**Severity** — P3 (no exploit found; the shape invites one)
**Exploitability** — none demonstrated. The reviewer's analysis is accepted: `"` is stripped from the token
before it is placed inside `value="…"`, and entity payloads are decoded after attribute parsing, so the
value cannot break out of the attribute.
**Category** — output encoding.
**Evidence** — `app/api/unsubscribe/route.ts:22` returns `Content-Type: text/html` built by string
concatenation around the caller's `token` query parameter, with `"` removed. There is no CSP on the response
that would matter for a same-origin document with `script-src 'unsafe-inline'` (§5.1).
**Reproduction** — `curl.exe -sS "http://127.0.0.1:3215/api/unsubscribe?token=x%22y"` and observe the
stripped quote.
**Proposed fix** — serve the token in a JSON response and let a client-rendered page post it, or escape it
with `esc()` and set an explicit `Content-Security-Policy: default-src 'none'` on that response. A
one-line response-header addition removes the class permanently.
**Status** — open (draft)

### R14-7 — A non-production deployment hands a management token to any caller

**Severity** — P2 (an unauthenticated caller obtains write capability over listings)
**Exploitability** — latent and environment-dependent: on any deployment where `isProduction()` is false —
notably a Vercel **preview** — `POST /api/manage/request` returns the raw 256-bit token in its JSON body,
which is sufficient to call `GET /api/manage/session` and `PATCH /api/startups/[domain]`. Preview
deployments are SSO-gated (§5.3), which is the only thing in the path; that gate is a Vercel project
setting, not repository code (Q1).
**Category** — authorisation / capability leak.
**Evidence** — `lib/manage.ts:44` (`debugToken?: string` in the return type), `:47` (`send: true` with no
oracle for bad input), `:65` `if (!isProduction()) return { sent: true, debugToken: raw }`, `:67` the
production branch that drops the link with a warning graph; and `app/api/manage/request/route.ts:37`
`...(result.debugToken ? { debugToken: result.debugToken } : {})` — the value crosses the HTTP boundary.
**Reproduction** — `POST /api/manage/request {"domain":"<a listed domain>","email":"<its address>"}` against
a local production build started with `VERCEL_ENV` unset (or `NODE_ENV=development`); the response carries
`debugToken`. Against production the same request returns `ok` with no token.
**Proposed fix** — treat every deployed environment as production for capability purposes: gate on
`process.env.VERCEL_ENV` being *absent or* `"production"` rather than on `isProduction()`, or hard-require a
`DEV_MANAGE_TOKENS=1` opt-in that the Vercel project does not set. Also make the field name impossible to
ship by accident (`__devToken` behind a `if (process.env.NODE_ENV === "development")` spread, as
`emails/preview` does with its whole-route `404`).
**Status** — open (draft)

### R14-8 — The ops secret is accepted from the query string

**Severity** — P2 (secret hygiene for the credential that can force the mail pipeline and the screenshot
worker)
**Exploitability** — low but real: no attacker needs to guess anything; the secret leaks into whatever
records URLs — Vercel request logs, shell history, browser history, a `Referer` header on any outbound link
from a tool that called it.
**Category** — secret transport.
**Evidence** — `app/api/jobs/reconcile/route.ts:47` and `app/api/jobs/config/route.ts:35` read
`req.nextUrl.searchParams.get("secret")` as an accepted alternative to the header; `lib/jobs.ts:26,38`
produce the `401 {"error":"unauthorized"}` / `403 {"error":"forbidden"}` bodies, and the four `/api/jobs/*`
routes also accept `Authorization: Bearer` (the form Vercel cron uses). Live: `GET /api/jobs/config` with no
secret → `401`; with `?secret=wrong-secret-xyz` → `401` (§5.3) — the query-string path is live code, not
dead.
**Reproduction** — the two 401 probes in §5.3; the query-string branch is additionally visible in the runbook
and in doc 13's per-job tables.
**Proposed fix** — accept only `Authorization: Bearer` (plus the platform cron header) and delete the
`searchParams` branch; rotate `CRON_SECRET` once, since it has been used in URLs. There is no limiter on
these routes by design, which is fine for a 256-bit secret — the query string is what makes that argument
weak.
**Status** — open (draft)

### R14-9 — One `/api/admin/*` route is authenticated but not audited

**Severity** — P3 (an operator action with money-adjacent effect that leaves no trace)
**Exploitability** — not an attacker path; it is a *detection* gap: if `ADMIN_TOKEN` leaks, the one route
that leaves no `AuditLog` row is the one that forces mail to be sent.
**Category** — audit trail.
**Evidence** — `app/api/admin/outbox/retry/route.ts:14-30` resets `attempts: 0` / `nextAttemptAt` and calls
`drainOutbox`, writing no `AuditLog` entry; `lib/audit.ts` writes for `STARTUP_CREATED`, `PROFILE_UPDATED`,
`REPORT_TRIAGED`, `PROFILE_MODERATED` and the job actions. Doc 13 §9 and doc 11 §5.9 record the same gap;
doc 14 owns it because "every `/api/admin/*` authenticated **and audited**" is a batch-3 requirement.
**Reproduction** — `POST /api/admin/outbox/retry` with the operator token, then
`SELECT count(*) FROM "AuditLog";` before/after — unchanged.
**Proposed fix** — add an `OUTBOX_RETRY` action to `lib/audit.ts` and write it with the row count the retry
reset, the same way `REPORT_TRIAGED` records its subject.
**Status** — open (draft)

### R14-10 — Rejected operator credentials and exhausted limits are invisible

**Severity** — P3 (operational blind spot on the highest-privilege surfaces)
**Exploitability** — not an attack; it is why an attack would go unnoticed. Nothing distinguishes "one typo"
from "someone is brute-forcing `/api/jobs/config`" — except Vercel's access log, which no one is reading and
which does not exist for a self-hosted deployment.
**Category** — observability / monitoring.
**Evidence** — `lib/jobs.ts` contains **no logging at all** (`Select-String "console"` over the file → 0
matches) while returning the two rejection bodies at `:26` and `:38`; the live probes in §5.3 produced four
rejections and unsurprisingly no alert; the limiter's fail-open path logs once per *event* with no counter
and no alert (§5.6); the four `/api/admin/*` and four `/api/jobs/*` routes have no limiter, so a leaked or
guessed secret can be retried forever.
**Reproduction** — `curl.exe -sS https://www.periodictable.lol/api/jobs/config` (§5.3) then check any
alerting channel: none is wired in the repository (no Sentry/Datadog/log-drain config anywhere in the tree).
**Proposed fix** — log every rejection with the route, the presenting-credential *shape* (header vs query vs
missing — never the value) at `warn`, and add one alert: more than N rejections on the eight privileged
routes in an hour. Add a modest limiter (e.g. 60/h per IP) to those routes so a wrong secret costs the
attacker time. If a hosted error tracker is added later, this is the first thing to route into it.
**Status** — open (draft)

### R14-11 — `next@14.2.35` ships nine advisories, two of them RCE, on an enforced acceptance with an expiry

**Severity** — P2 (first week: it is a release-hygiene item with a dated deadline, not a live exploit)
**Exploitability** — none today, and this is verified rather than argued. The reviewer checked and I re-checked
the preconditions of the two RCE classes: `next.config.mjs` has **no `images` key** (AVIF optimizer path
unreachable) and no `next/image` import exists anywhere in the tree; no `middleware.ts`; no `rewrites`; no
`"use server"`; hosting is Linux/Vercel. The live gain is the DoS / cache-confusion class.
**Category** — dependency risk (accepted, enforced, time-boxed).
**Evidence** — `package.json:21` `"next": "14.2.35"`; `npm audit --omit=dev` →
`{"critical":1,"total":1}`; `ops/accepted-advisories.json` carries the acceptance, a TRIPWIRE naming exactly
the condition that upgrades it (image-optimizer config, Windows hosting) and `expires 2026-12-31`;
`scripts/audit-prod.mjs:17` implements the check and **`.github/workflows/ci.yml:52` runs
`npm run audit:prod` on every push**, so the acceptance cannot be silently widened and the tripwire is not
a note — it is a build gate. What is *not* automatic is the expiry: after 2026-12-31 the gate starts failing
and someone must upgrade, which is the correct design.
**Reproduction** — `npm run audit:prod` (exit 0 today) and `npm audit --omit=dev`.
**Proposed fix** — schedule the upgrade (14.2.x latest or the 15 line) rather than waiting for the tripwire;
when it happens, re-run `npm run audit:prod` and delete the acceptance entry rather than editing its expiry.
**Status** — open (draft)

## 8. Acceptance criteria

- [x] A caller cannot change money state without a signature-verified provider event — `lib/stripe.ts`
  HMAC over the raw body, 300 s two-sided tolerance, `timingSafeEqual`, `ProviderEvent.providerEventId`
  dedupe; live `401` without a signature (§5.4).
- [x] Every `/api/admin/*` and `/api/jobs/*` route rejects absent **and** wrong credentials with a
  byte-identical body — live `403 {"error":"forbidden"}` (21 B, four routes) and
  `401 {"error":"unauthorized"}` (24 B, four routes) (§5.3).
- [ ] `/api/dev/pay` refuses every production environment regardless of provider mode — R14-1.
- [ ] Every per-IP ceiling is keyed on a value the client cannot choose, and the store fails closed for
  mail and money — R14-2.
- [ ] Every outbound mail goes to an address whose owner asked for it — R14-3.
- [x] No server secret name or value appears in the client bundle — `Select-String -SimpleMatch` over
  `.next\static` for nine names → 0 matches each; one non-API route imports a server lib (§5.2).
- [x] No route exposes another owner's data on a guessed identifier — no `/api/payments/*`; manage tokens
  256-bit/sha256/15 min/single-use/purpose-bound with a `session.domain !== domain` check (§5.5).
- [x] The screenshot worker never fetches a caller-supplied URL from our process — Microlink indirection
  plus `isPublicHost` and `BLOCKED_HOST_SUFFIXES` re-checked at fetch time (§5.8).
- [x] Framework advisories are accepted explicitly, with a tripwire that a build gate enforces and a dated
  expiry — `ci.yml:52` → `scripts/audit-prod.mjs` (§5.13).
- [x] Malformed bodies produce a typed `400`, not a `500` — three of four write routes type-check; `/api/report`
  sanitises coercively; the class is doc 11's R11-1 alone (§5.15).
- [ ] Every mail template escapes caller-reachable values — R14-4.
- [ ] The value that is validated is the value that is persisted — R14-5.
- [ ] A deployed non-production environment cannot hand out management capability — R14-7.
- [ ] Every `/api/admin/*` write leaves an audit row — R14-9.
- [ ] A rejected operator credential is recorded where a human will see it — R14-10.
- [ ] CSP `script-src` has no `'unsafe-inline'` and the header advertises no control the code does not
  enforce (the two dead Turnstile entries) — §5.1.

**Budget** — 6 of 16 met at `9681bdc`. Nine require a code or config change (R14-1, R14-2, R14-3, R14-4,
R14-5, R14-7, R14-9, R14-10, plus the CSP row); the cheapest two are R14-4 and R14-5 (each a handful of
lines, both latent). Three facts are operator-only and are tracked as U14-2/U14-3/U14-4; none of them is a
code change. My ordering if I had one day: R14-2 (it silently voids the rest of the controls), R14-1 (P0 by
consequence), R14-3, then the two-line hardening pair.

## 9. Open questions

- **Q1 — Is Vercel Authentication an owned control?** It is load-bearing for R14-1 and R14-7 (previews are
  safe *because* of it) and it exists nowhere in the repository, so nothing records that turning it off is a
  security change. Whoever owns the Vercel project should confirm it is intentional and add it to
  `doc/PROD-READINESS-CHECKLIST.md` as a required setting. (Not a finding; a durability question.)
- **Q2 — Which identity header does this deployment actually set?** The R14-2 fix cannot be written until
  U14-5 is answered: `cf-connecting-ip` is caller-controlled here, and whether Vercel overwrites
  `x-forwarded-for` / sets `x-real-ip` on this project must be verified on the deployment, not assumed from
  documentation.
- **Q3 — Does the waitlist mail produce any feedback we would notice?** A Resend webhook (bounce/complaint)
  would be the only signal that R14-3 is being abused. If none is configured, the relay is invisible from
  our side as well as from the recipient's — which raises the priority of the fix, not lowers it.
- **Q4 — Once `requireProdEnv()` is called at boot, what should a degraded start do?** Refuse to serve
  (turning a config mistake into an outage) or serve with payments off and a visible banner (turning it into
  a business decision)? That is a product call, and doc 15 owns the availability half of it.

## 10. Cross-references

- `doc/review/00-REVIEW-PLAN.md` §2 "Batch 3 — the platform underneath" (the five doc specs and the named
  attacker goals), §4 (the P0–P3 severity rubric applied in §7), §5 rows 11–15.
- `doc/review/TEMPLATE.md` — section order; §7 uses the standard finding block plus the `Exploitability`
  line explained at the head of §7.
- Batch 1, cited not re-reported: doc 05 §7 **R05-7** (the report/waitlist mail chain, its 3 s/5-row drain
  and the 04:00 cron retry — the mechanism R14-3 abuses), **R05-8** (`/pay/[paymentId]` gated by provider
  mode with `PaySimulator.tsx` — the surface R14-1 exploits), 05 §9 Q2 (the 30 s polling surfaces accepted
  as risk).
- Doc 11 — **R11-1** (the one real 500: `emails/preview` with an `outbid` template), **R11-3** (two error
  envelopes and empty bodies), **R11-4** (unthrottled admin/job/money routes), **R11-5** (`/api/report`
  answers `200` when limited — the reason §5.6's report row is measured by effect, not status), **R11-6**.
  Doc 11 owns route contracts; this document owns exploitability.
- Doc 12 — §7 owns PII retention and deletion (`EmailLog`, `WaitlistEntry`, `Report.ipHash`); this document
  only records who can read or write those rows.
- Doc 13 — the per-job auth tables and the `EmailLog` "no provider id, every row `logged`" gap (R13-4,
  R13-5, §9) are cited in §5.7 and R14-9; doc 13 owns job semantics.
- Docs 06–10 (batch 2, not yet written): 06 checkout validation order, 07 provider-mode semantics (the
  money-path half of R14-1), 08 settlement authority, 09 ownership/competition, 10 mail cadence and copy.
  Where R14-1 and R14-3 touch money-path behaviour, the *behaviour* belongs to those docs; the *authority*
  question is this one's.
- `doc/PROD-READINESS-CHECKLIST.md` — cited by section for secret inventory and header expectations, not
  restated.
- `ops/accepted-advisories.json`, `scripts/audit-prod.mjs`, `.github/workflows/ci.yml:52` — the enforced
  acceptance quoted in R14-11.
- `doc/review/FINDINGS.md` — R14-1…R14-11 are registered there in id order with severity and status.

## 11. Change log

| Date | Change |
|---|---|
| 2026-09-15 | authored 2026-09-15 against `9681bdcbff2435ef258224c52000e0f8d6089f5c` |
| 2026-09-15 | §5.6 key table corrected from the call sites (`manage:${ip}`, `manage-verify:${ip}`, `profile:${ip}`, `search:${ip}`) |
| 2026-09-15 | §5.15 added: the planned non-string-field 500 finding was **not** reproduced and is not registered |
| 2026-09-15 | R14-10 replaced the dropped field-validation finding with the credential-rejection observability gap, on the strength of `lib/jobs.ts`'s missing logging |

## 12. UNKNOWN log

| Id | Unknown | What settles it |
|---|---|---|
| U14-1 | Whether any `Payment` row is in flight (`provider = STRIPE`, unsettled) and the `PaymentProvider` distribution — the fact that decides whether R14-1's failure mode *strands* an existing buyer or only creates free ones | Operator, Neon SQL: `SELECT provider, status, count(*) FROM "Payment" GROUP BY 1,2;` — counts only; no rows exported into this repository |
| U14-2 | Whether `ADMIN_TOKEN` and `PAYMENTS_LIVE` are set in production, and consistent with each other | `vercel env ls production` (names only, never values) plus the payment link rendered on `/`; note the fail-closed `403` proves nothing about presence |
| U14-3 | Whether `RESEND_API_KEY`, `UPSTASH_REDIS_REST_URL`/`_TOKEN` and `TURNSTILE_SECRET` are set in production — decides whether R14-3 delivers and whether §5.6's limits are shared | Vercel → Logs at process start: the single `rate-limit: no shared store configured … using instance-local memory` line, the Turnstile not-configured warning; a delivered mail's `DKIM`/`Return-Path` headers prove Resend |
| U14-4 | Whether any alias of a preview deployment is reachable without Vercel Authentication | Enumerate `gh api repos/danilgorbunofff/PeriodicTable/deployments` (and `…/deployments/<id>/statuses`) and `curl -sS -o NUL -D -` each host, expecting `302 → vercel.com/sso-api`; one branch-alias form did not resolve from this host (`curl` exit `000`) |
| U14-5 | Which request header this deployment sets as the client identity, i.e. whether `x-forwarded-for`/`x-real-ip` can be trusted as the limiter key | One request per header value against a harmless production route and comparison of limiter behaviour, or the Vercel project's edge configuration; **blocks the R14-2 fix** |
| U14-6 | Whether Vercel adds `Access-Control-Allow-Origin: *` to any `/api/*` response besides `/` | Header sweep: `curl -sS -D - -o NUL` over all 26 production routes (§5.1 captured `/` and `/api/stats`; `/` has it, `/api/stats` does not). Matters only if a cookie-authenticated route is added later |
| U14-7 | The last-rotation dates of `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET`, `ADMIN_TOKEN`, `CLICK_SALT` (and whether `CLICK_SALT` is set at all — unset means the literal `"ptl-dev-salt"` is hashed into every `Report.ipHash`) | Provider consoles plus a dated line per secret in the runbook; **values are never printed**, only names and dates |
| U14-8 | Whether a real browser blocks a foreign-host `logoUrl` render, and whether a future build keeps `script-src` free of `'unsafe-inline'` | Browser matrix against a listing whose `logoUrl` points at a foreign host (needs a manage session, i.e. after the v2 manage pages ship); the CSP half is re-checkable on every deploy from the headers §5.1 captured |

