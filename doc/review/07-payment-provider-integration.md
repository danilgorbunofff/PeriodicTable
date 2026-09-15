# 07 — Payment provider integration

| Field | Value |
| --- | --- |
| Phase · batch | 07 · 2 |
| Status | draft |
| Date reviewed | 2026-09-15 |
| Commit reviewed | `9681bdcbff2435ef258224c52000e0f8d6089f5c` |
| Reviewer | review agent |

**How this doc was produced.** The same scratch environment as `06`: Postgres 16 container `ptl-review-batch2-pg` (host port 55499) migrated 0000–0006 and seeded, and dev servers started from **isolated copies** of the checkout under `%TEMP%\ptl-b2\s<port>` (`node_modules` junctioned) so that no two servers share a `.next` directory (`06` §5.12). Each server was given a different provider posture by environment alone — port 3206 no Stripe variables, 3207 `VERCEL_ENV=preview` with a partial configuration, 3212 `VERCEL_ENV=production` + `PAYMENTS_LIVE=true` with a key and no webhook secret, 3214 the same plus the webhook secret, `NEXT_PUBLIC_APP_URL=https://review.example` and Cloudflare's always-pass Turnstile test secret. Every posture was probed live; the Stripe API itself was reached once with a deliberately invalid key from a throwaway script (`npx tsx _b2stripe.ts`, since deleted) to capture the rejection path verbatim. No real charge was created and no provider console was read (that is U07-4).

| Probe not run | Why | Residue |
| --- | --- | --- |
| A real Stripe Checkout session with a live or test key | Needs a valid key; the operator deferral `04` U04-3 still owns the real-charge run | None — U07-4 |
| A Stripe dashboard reading (endpoint health, delivery attempts, key validity) | No provider console access from this host | None — U07-4 |
| Webhook delivery from Stripe to this host | The host is not reachable from Stripe and no endpoint is registered to it | Signatures were exercised locally instead (§5.6) |
| Revoking a key in the dashboard | Operator-only action | None — §5.7 gives the procedure |

## 1. Scope

**Owns.** Plan §1 **S3 × L4**: `lib/stripe.ts` whole, the provider branch of `app/api/checkout/route.ts` (`:39-74`, `:363-374`), the mode gate on `app/pay/[paymentId]/page.tsx` and the simulator beside it (`app/pay/[paymentId]/PaySimulator.tsx`), `app/api/dev/pay/route.ts`, `prisma/migrations/0006_stripe_provider/migration.sql`, the legacy Whop rows and the provider-facing half of `lib/flags.ts` / `lib/env.ts`.

**Does not own.** The intake gates that run before the provider is consulted (`06` — its §7 R06-7 is the 502 whose row this doc explains); what the app does once a provider event says *paid* (`08`); which element a payment buys and what it costs (`09`); the mail a settlement enqueues (`10`); the shape of `POST /api/checkout` as a contract (`11`).

**Paths inspected.** `lib/stripe.ts` whole (355 lines); `app/api/checkout/route.ts:30-115,355-374`; `app/pay/[paymentId]/page.tsx` whole; `app/pay/[paymentId]/PaySimulator.tsx` whole; `app/api/dev/pay/route.ts` whole (48 lines); `lib/flags.ts` whole (25 lines); `lib/env.ts:14-40,140-175`; `app/api/jobs/config/route.ts`; `prisma/migrations/0006_stripe_provider/migration.sql`; `prisma/schema.prisma:36-70,171-200`.

## 2. Actors

| Actor | Applies | What this phase must check for them |
| --- | --- | --- |
| Paying customer | yes | That the URL they are handed is a real payment page, that a failure to create one says so, and that their money only ever reaches the app through a channel the app can verify |
| Payment provider | yes | Stripe's API contract: which fields identify the payment back to us, what a rejection looks like, and what a rotation of either credential does to in-flight traffic |
| Operator | yes | Which deployment is which mode, what happens when half the credentials are present, and how to rotate a key or a signing secret without a window |
| Attacker | yes | Whether the simulator — an unauthenticated endpoint that grants stakes — can be reached in a posture the deployment believes is real |
| Deployer | yes | Whether a preview deployment is safe to hand to a customer, and whether a misconfigured production fails loudly or quietly |
| Future maintainer | yes | Why the provider abstraction is a 355-line module handing out no SDK types, and what `PRODUCT_TAX_CODE` is for |
| Email recipient | partly — `10` | The address Stripe is given as `customer_email` |

## 3. Intended behaviour

The provider mode is derived from **credential presence, not from the deployment's environment**: `getProviderMode()` returns `"stripe"` only when `STRIPE_SECRET_KEY` **and** `STRIPE_WEBHOOK_SECRET` are both set, and `"dev"` otherwise (`lib/stripe.ts:18-19,28`); `stripePartiallyConfigured()` is true when exactly one of the two is present (`:33`). The design intent is fail-closed: payments stay off until the launch flag says otherwise *and* the provider is fully configured (`lib/flags.ts:12-20` — production requires `PAYMENTS_LIVE === "true"` **and** both keys; outside production the flag defaults to live). The checkout endpoint refuses everything with a 403 when `paymentsLiveServer()` is false (`app/api/checkout/route.ts:109-111`).

Once a payment row is `PENDING`, `resumeCheckoutUrl()` is the single place that decides what URL the buyer gets (`route.ts:39-74`): in `dev` mode it mints `/pay/<id>` and persists it; in `stripe` mode it creates a Checkout Session, persists `providerRef` and `providerCheckoutUrl`, and returns null — which the caller turns into a retryable 502 rather than a dead link — if Stripe did not answer (`:68-73`, `:97-103`). The session carries `metadata[paymentId]` and `metadata[elementSymbol]` on the session **and** a copy on the PaymentIntent (`lib/stripe.ts:109-112`), because reversal events (refunds, disputes) deliver a charge object, which carries only the intent's copy. Amounts convert once, `Math.round(amountUsd * 100)` (`:97`), and the request carries `Idempotency-Key: pt_checkout_<paymentId>` (`:122`) so a retry of the same row cannot create two sessions.

The simulator is supposed to be unreachable whenever Stripe is: `app/pay/[paymentId]/page.tsx` is a one-line gate — `if (getProviderMode() !== "dev") notFound();` — a state batch 1 settled as correct (`05` §7 R05-8). The simulation endpoint repeats the check (`app/api/dev/pay/route.ts:12-15`) and its header comment states the safety claim this doc tests: *"can never grant stakes for free in production"*.

## 4. The path, walked

1. **Mode.** Process start reads only environment variables. `getAppEnv()` prefers `VERCEL_ENV` (`production`/`preview`/`development`) and falls back to `NODE_ENV === "production"` (`lib/env.ts:21-29`); `isProduction()` is `getAppEnv() === "production"` (`:31`). Nothing at boot validates anything — `requireProdEnv()` exists (`lib/env.ts:164`) and is called from no runtime path (§7 R07-3).
2. **Gate.** `POST /api/checkout` first asks `paymentsLiveServer()`. False → 403 `{"error":"Payments are paused — join the waitlist.","waitlist":true}` (`route.ts:109-111`).
3. **Row.** Under the per-element advisory lock the payment row is written with `provider` = the mode resolved at that moment (`route.ts:180-329`; the `Payment` row's `provider` column, `prisma/schema.prisma:171-200`).
4. **Hop.** `resumeCheckoutUrl()` decides dev vs stripe (`route.ts:55-73`) and the response is `{ paymentId, checkoutUrl, provider, … }` (`:363-374`) — `provider` is the string the *client* is told, and `06` §5 shows the modal navigating to `checkoutUrl` unconditionally.
5. **Stripe call.** `createStripeCheckoutSession()` (`lib/stripe.ts:59-141`) form-encodes the session, logs a key-mode line, and returns `{ providerRef, checkoutUrl }` or null. A non-2xx produces `stripe: checkout/sessions rejected (HTTP <status>, key=<sk_live_|sk_test_|unexpected-format>) — <body>` on stdout (`:130-141`).
6. **Back.** Stripe redirects to `${origin}/?paid=<SYM>` on success and `${origin}/?canceled=<SYM>` on cancel (`route.ts:64-66`); the webhook arrives independently at `/api/webhooks/stripe` (`08`).
7. **Simulator.** In dev mode the buyer instead lands on `/pay/<id>`, a page whose only control is the simulator (`PaySimulator.tsx:77-113`): *Pay now* → `POST /api/dev/pay` → on `status === "paid"` it routes to `/?paid=<SYM>`, otherwise it prints `json.error ?? json.status` (`:21-34`).
8. **Irreversible point.** The provider contract becomes binding at session creation: `providerRef` is unique (`prisma/schema.prisma:171-200`) and the session's metadata is the only way a later event finds the payment. Everything before step 5 is free; everything after belongs to `08`.

## 5. Live evidence

2026-09-15, this host, scratch DB. Unless stated otherwise each request was written to a file and sent with `Invoke-WebRequest -InFile` so the JSON body was not mangled by the shell.

### 5.1 The mode table

Four postures were run. In every row the *same code* was served, differing only in environment.

| Posture as probed | `paymentsLiveServer()` | `getProviderMode()` | `POST /api/checkout` | `GET /pay/{id}` | `POST /api/dev/pay` |
| --- | --- | --- | --- | --- | --- |
| 3206 — no `STRIPE_*`, `PAYMENTS_LIVE` unset, `VERCEL_ENV` unset (local dev) | true (non-prod default) | `dev` | 200, `provider:"dev"`, `checkoutUrl:"/pay/<id>"` | 200, simulator | 200, `{"ok":true,"status":"paid","terminal":true,…}` |
| 3207 — `VERCEL_ENV=preview`, `STRIPE_SECRET_KEY` set, `STRIPE_WEBHOOK_SECRET` unset | true | `dev` | 200, `provider:"dev"`, `checkoutUrl:"/pay/<id>"` | 200, simulator | 200, `{"ok":true,"status":"paid","terminal":true,"elementSymbol":"Si"}` |
| 3212 — `VERCEL_ENV=production`, `PAYMENTS_LIVE=true`, key set, webhook secret unset | **false** (`providerConfigured()` false) | `dev` | 403 `{"error":"Payments are paused — join the waitlist.","waitlist":true}` | 200 for a row that already existed, simulator | 200, `{"ok":true,"status":"paid","terminal":true,"elementSymbol":"Fr"}` |
| 3214 — as 3212 plus `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL=https://review.example`, always-pass Turnstile secret | true | `stripe` | 502 `{"error":"Payment provider unavailable. Try again."}` (the fake key is invalid) | **404** | n/a — mode is `stripe`, so this returns 403 `{"error":"Disabled when Stripe is enabled."}` |

The four rows separate two variables that the code treats as one. **`VERCEL_ENV=production` does not by itself make a deployment live** (3212 is production-flagged and still refuses buyers), and **`PAYMENTS_LIVE` does not by itself enable Stripe** (3212 has it `true` and runs in dev mode). The mode is key presence; the flag only closes the door.

### 5.2 3207 — a preview-flagged deployment mints a permanent stake with no card

```
POST http://127.0.0.1:3207/api/checkout
  {"elementSym":"Si","amountUsd":11,"idempotencyKey":"probe-preview-stripe-key-1", …, "email":"probe preview stripe"}
→ 200 {"paymentId":"cmu2gw3hr000lb4o0p0pn5o8x","checkoutUrl":"/pay/cmu2gw3hr000lb4o0p0pn5o8x","provider":"dev"}

POST http://127.0.0.1:3207/api/dev/pay  {"paymentId":"cmu2gw3hr000lb4o0p0pn5o8x","outcome":"pay"}
→ 200 {"ok":true,"status":"paid","terminal":true,"elementSymbol":"Si"}

psql> SELECT id, provider, status, "amountUsd", "elementId", "appliedAt" FROM "Payment" WHERE id='cmu2gw3hr000lb4o0p0pn5o8x';
cmu2gw3hr000lb4o0p0pn5o8x|dev|paid|11|Si|1|probe preview stripe
```

`/api/dev/pay` answering 200 rather than 403 is itself the proof that `getProviderMode()` was `dev` in that process, i.e. that at least one Stripe variable was unset. Two facts follow: the deployment's *environment* did not decide its provider, and `POST /api/dev/pay` — an unauthenticated endpoint (`app/api/dev/pay/route.ts`, no auth decorator) — applied a real, permanent stake (`appliedAt` set, element Si is now led by an $11 stake) with no card. `doc/PROD-READINESS-CHECKLIST.md` §1 records `DATABASE_URL` scoped to `Production, Preview`, so a preview deployment writes to the production database.

### 5.3 3212 — a production-flagged deployment still grants a free stake

Same checkout body, `VERCEL_ENV=production`, `PAYMENTS_LIVE=true`, `STRIPE_SECRET_KEY` present, `STRIPE_WEBHOOK_SECRET` absent:

```
GET /api/jobs/config   (Authorization: Bearer review-admin-token)
→ 503 {"ok":false,"env":"production","findings":[
     {"key":"STRIPE_WEBHOOK_SECRET","severity":"required",…},
     {"key":"UPSTASH_REDIS_REST_URL","severity":"degraded",…}, …]}

POST /api/checkout          → 403 {"error":"Payments are paused — join the waitlist.","waitlist":true}
GET  /api/jobs/reconcile    (no auth) → 401 {"error":"unauthorized"}
GET  /api/jobs/outbox       (no auth) → 401 {"error":"unauthorized"}
GET  /api/jobs/config       (no auth) → 401 {"error":"unauthorized"}
GET  /api/jobs/reconcile    (Bearer)  → 200 {"ok":true,"paidTotal":5,…,"unverified":{"count":4,"byProvider":[{"provider":"DEV","count":4}]}}

psql> INSERT INTO "Payment" (id,…) VALUES ('probe_prod_free_1',…,'5','Fr',…);
POST /api/dev/pay  {"paymentId":"probe_prod_free_1","outcome":"pay"}
→ 200 {"ok":true,"status":"paid","terminal":true,"elementSymbol":"Fr"}
psql> probe_prod_free_1|dev|paid|5|probe3212@example.com|Fr||2026-09-15 09:30:43.11|1
GET  /pay/probe_prod_free_1 → 200 (12 692 bytes, DEV SIMULATOR)
```

The production flag did close the *rehearsal* hole — the three job endpoints answer 401 unauthenticated here, where the 3206 dev server answered 200 (`10` §5). It did **not** close the simulator: with one of the two Stripe credentials absent, `getProviderMode()` is `dev`, the pay page renders, and `/api/dev/pay` writes a stake whose `providerRef` is empty and whose `appliedAt` is set. The buyer-facing shop is paused in this posture, so a passing visitor cannot reach the flow — but the endpoint that hands out stakes needs only a `paymentId`, and `paymentId`s are printed in `/pay/<id>` URLs and in the operator's own tooling.

### 5.4 3214 — a fully configured posture, with a key that does not work

```
POST /api/checkout  {"elementSym":"Md","amountUsd":9,"idempotencyKey":"probe-3214-live-posture-1", …}
→ 502 {"error":"Payment provider unavailable. Try again."}
psql> cmu2h636w0005b4tsyg9yui8n|join|pending|stripe|Md|(null)|(null)
POST /api/checkout  (same idempotencyKey)
→ 502 {"error":"Payment provider unavailable. Try again."}     — still exactly 1 row for that key
POST /api/checkout  (fresh key, same buyer, second click)
→ 502 {"error":"Payment provider unavailable. Try again."}     — a second pending row (cmu2hgrnb0009b4tsj1jn0yp0)
GET  /pay/cmu2h636w0005b4tsyg9yui8n
→ 404
```

Two things are settled here. The provider-mode page gate works exactly as batch 1 recorded it (`05` §7 R05-8): in `stripe` mode a `/pay/<id>` URL is a 404, so the simulator cannot be reached at all. And the 502 is **not** idempotent from the buyer's point of view: the same key replays to the same 502 and leaves one row, but the modal mints a fresh key per submit (`components/Modals.tsx:250-253`), so a second click leaves a second `PENDING` row. Neither row has a `providerRef`, so neither can ever be found by a webhook — only by `/api/jobs/reconcile`, which counts them as unverified (`08` §5).

### 5.5 What Stripe itself answers when the key is wrong

`npx tsx _b2stripe.ts` (throwaway, deleted) called `createStripeCheckoutSession()` with `STRIPE_SECRET_KEY` set to a synthetic `sk_test_`-prefixed placeholder (elided here: `sk_test_REVIEWfake…` — no real key was used or recorded anywhere in this doc):

```
stripe: checkout/sessions rejected (HTTP 401, key=sk_test) — {
  "error": { "message": "Invalid API Key provided: sk_test_************************0000",
             "type": "invalid_request_error" } }
RESULT: null
```

The rejection is mapped to `null` and the buyer gets the 502 above. The log line is the *only* place the HTTP status and Stripe's message appear; nothing increments a counter, sets a flag, or writes a row.

### 5.6 Signature verification, locally exercised

`lib/stripe.ts:144-232` is a hand-rolled verifier: `SIGNATURE_TOLERANCE_SECONDS = 300` (`:168`), freshness checked **before** the HMAC, and any `v1` candidate equal to the computed digest is accepted (`:218-220`) — which is what makes a two-secret rotation safe (§5.7). Probes against `/api/webhooks/stripe` with an unsigned body, a stale timestamp, and a signature computed with the wrong secret all returned `401 {"error":"bad signature"}` and wrote no `ProviderEvent` row; a correctly signed body was accepted and logged `[stripe-webhook] verified signature` (the route's only success log, `app/api/webhooks/stripe/route.ts:43-45`). `08` §5 carries the full event-by-event walk; this doc uses the 401 only for its operator-facing consequence below.

### 5.7 Rotation procedures, as runnable steps

**A — secret key.** `STRIPE_SECRET_KEY` is read at request time (`lib/stripe.ts:18-19,59`), so no cache has to be busted.

1. In the Stripe dashboard, create a restricted or standard secret key for the account; note its mode prefix (`sk_test_` / `sk_live_`).
2. Set it in Vercel for **both** the Production and Preview environments (`doc/PROD-READINESS-CHECKLIST.md` §1 — `DATABASE_URL` is already shared across both; the Stripe key must be too, or preview keeps running in dev mode per §5.2).
3. Redeploy so both environments pick it up. `GET /api/jobs/config` with `Authorization: Bearer $ADMIN_TOKEN` must stop reporting `STRIPE_SECRET_KEY`; if it still does, the variable was set in the wrong scope.
4. Verify by creating one real session in a Stripe **test** mode first: a successful call writes `providerRef` and `providerCheckoutUrl` on the `Payment` row (`route.ts:68-73`), so a test-mode row with a `pi_`/`cs_` reference is the proof.
5. Only then revoke the old key in the dashboard.
6. Watch the server log for `stripe: checkout/sessions rejected (HTTP 401, key=sk_test)` (`lib/stripe.ts:130-141`). Nothing else in the app reports a rejected key, so if step 4 was skipped this log line is the entire warning.

**B — webhook signing secret.** The endpoint is `we_1UFVsvQ8DCQQIpW5GtOvFfws` and it handles seven event types (`doc/PROD-READINESS-CHECKLIST.md` §5).

1. In the dashboard's endpoint detail, roll the signing secret. Stripe keeps the previous secret valid during the roll.
2. Put the new value in `STRIPE_WEBHOOK_SECRET` (Production **and** Preview) and redeploy.
3. There is **no gap to schedule around**: the verifier accepts any `v1` candidate that matches, so during the overlap window both the old and the new secret verify (`lib/stripe.ts:218-220`); the 300 s tolerance (`:168`) applies only to the timestamp, not to the secret.
4. Confirm by replaying one recent event from the dashboard and watching for `[stripe-webhook] verified signature` plus an `APPLIED`/`DUPLICATE` `ProviderEvent` row for that event id; a replay of an already-applied event is safe by design (`08` §7 R08-2 discusses the one row it corrupts).
5. Delete the old secret only after step 4 has been repeated once with the new value alone.

**The exact symptom of a stale webhook secret** — one sentence: *buyers keep paying and nothing happens*. Concretely: `/api/webhooks/stripe` answers `401 {"error":"bad signature"}` and returns before any write, so there is **no `ProviderEvent` row, no `settlePayment` call, no stake applied, and no email**; the only log line is the 401 branch, and the *success* path's `console.log("[stripe-webhook] verified signature")` never appears (`app/api/webhooks/stripe/route.ts:43-45`). Stripe's own endpoint page shows the delivery rate dropping to 0% and, after its retry window, disabling the endpoint. From inside the app the payment rows stay `PENDING` forever and `/api/jobs/reconcile` reports them in `unverified` — a signal nobody watches on a cron (`08` §7 R08-6), so in practice the discovery happens when a customer complains or on the dashboard.

### 5.8 Migration 0006 and the legacy Whop rows

`prisma/migrations/0006_stripe_provider/migration.sql` is five lines: `ALTER TYPE "PaymentProvider" ADD VALUE 'stripe';` plus a comment recording that the `whop` value is retained deliberately. A row written while Whop was the provider therefore still deserializes, and `prisma/schema.prisma:54-60` records that four such live rows exist. Probed:

```
GET  /pay/probe_whop_legacy_1   → 200 (simulator renders)
POST /api/dev/pay {"paymentId":"probe_whop_legacy_1","outcome":"pay"}
     → 403 {"error":"Simulator handles dev payments only."}
```

The page gate tests the *process* mode, not the *row's* provider (`app/pay/[paymentId]/page.tsx` — `getProviderMode() !== "dev"`), and the simulator refuses non-`DEV` rows (`app/api/dev/pay/route.ts`). The two disagree by construction, so a legacy row's simulated "Pay now" button can only print `Simulator handles dev payments only.` (`PaySimulator.tsx:33`). `doc/PROD-READINESS-CHECKLIST.md` §5 lists deleting the `WHOP_*` variables as the one remaining ops step; nothing in the code base reads a Whop row.

## 6. Failure and edge matrix

| Situation | What the buyer sees | What the app does | Evidence |
| --- | --- | --- | --- |
| No Stripe variables, local dev | Real simulator page (`DEV SIMULATOR`) | Dev mode; stake applies on one click | §5.1 row 1 |
| Partial config, non-production (`VERCEL_ENV=preview`) | Real simulator page | Dev mode; real stake, no card | §5.2 |
| Partial config, production | "Payments are paused — join the waitlist." (403) | Shop closed; **simulator still answers 200** | §5.3 |
| Both credentials, invalid key | "Payment provider unavailable. Try again." (502) | `PENDING` row with no `providerRef`; one per click | §5.4/§5.5 |
| Both credentials, valid key, Stripe timeout | same 502 | same, retryable; no session exists | `route.ts:68-71`, §5.4 shape |
| Both credentials, session created, buyer abandons | nothing (they never return) | `PENDING` row + `providerCheckoutUrl`; a replay re-serves the same URL (`route.ts:38`) | `06` §5.7 |
| Both credentials, buyer cancels at Stripe | `/?canceled=<SYM>` (a link nothing reads — `06` §7 R06-8) | row stays `PENDING` | `route.ts:66`; `06` §5.8 |
| Stripe sends a reversal (refund/dispute) | no email | stake unwound in one transaction; audit row written | `08` §5 |
| Webhook secret stale | nothing at all | 401 before any write; no row, no log on success path | §5.7 |
| Legacy `WHOP` row revisited | simulator page; "Simulator handles dev payments only." on click | Dead end by construction | §5.8 |
| Attacker posts to `/api/dev/pay` in a partial-config production | n/a | Stake applied if they have a `paymentId` | §5.3, §7 R07-1 |
| `PAYMENTS_LIVE=false` (non-prod) | "Payments are paused…" | 403 before any row is written | `route.ts:109-111` |
| Provider returns 200 but with no `id`/`url` | 502 | `createStripeCheckoutSession` returns null on a malformed body | `lib/stripe.ts:59-141` |

## 7. Findings

### R07-1 — The dev simulator grants permanent stakes in a production-flagged process whenever Stripe is half-configured

- **Severity.** P0
- **Category.** money
- **Evidence.** `getProviderMode()` is `"stripe"` only when **both** credentials are present (`lib/stripe.ts:18-19,28`); `app/api/dev/pay/route.ts:12-15` gates on `getProviderMode() !== "dev"` and its header comment claims the endpoint *"can never grant stakes for free in production"* — which the probe disproves: with `VERCEL_ENV=production`, `PAYMENTS_LIVE=true` and `STRIPE_SECRET_KEY` set but `STRIPE_WEBHOOK_SECRET` absent, `POST /api/dev/pay` answered `200 {"ok":true,"status":"paid","terminal":true,"elementSymbol":"Fr"}` for a row inserted a second earlier, and the row came back `…|dev|paid|5|…|Fr||2026-09-15 09:30:43.11|1` — `appliedAt` set, `providerRef` empty. The page gate agrees with the endpoint: `GET /pay/probe_prod_free_1` returned the simulator with HTTP 200 (§5.3).
- **Reproduction.** Start the app with `VERCEL_ENV=production`, `PAYMENTS_LIVE=true`, `STRIPE_SECRET_KEY=<anything>`, no `STRIPE_WEBHOOK_SECRET` and a reachable database. `GET /api/jobs/config` reports `STRIPE_WEBHOOK_SECRET` required; `POST /api/checkout` is 403; `POST /api/dev/pay` with any `PENDING` `paymentId` returns `paid` and applies the stake.
- **Proposed fix.** Gate the simulator on *configuration* rather than on mode: refuse when `isProduction()` (`lib/env.ts:31`) or when `stripePartiallyConfigured()` (`lib/stripe.ts:33`) is true — a partial configuration is an incident, not a licence to run the stand-in provider. Belt and braces: require the admin bearer token on `/api/dev/pay`, and make the pay page 404 under the same condition. Test: a case asserting 403/404 for `{production + partial config}` and 200 only for `{non-production + no Stripe vars}`.
- **Status.** open

### R07-2 — A preview-flagged deployment serves the simulator and writes real stakes to the production database

- **Severity.** P0
- **Category.** money
- **Evidence.** Outside production `paymentsLiveServer()` returns true unless `PAYMENTS_LIVE=false` (`lib/flags.ts:12-20`), and `getProviderMode()` follows key presence, so a Preview deployment with one Stripe variable set is in dev mode. Probed on 3207 (`VERCEL_ENV=preview`, key set, secret unset): `POST /api/checkout` → `200 {… "provider":"dev","checkoutUrl":"/pay/cmu2gw3hr000lb4o0p0pn5o8x"}`, then `POST /api/dev/pay` → `{"ok":true,"status":"paid","terminal":true,"elementSymbol":"Si"}`, then the row `cmu2gw3hr000lb4o0p0pn5o8x|dev|paid|11|Si|1|probe preview stripe` — an $11 stake with no card (§5.2). `doc/PROD-READINESS-CHECKLIST.md` §1 records `DATABASE_URL` scoped `Production, Preview`, so this is the production pool.
- **Reproduction.** Any preview deployment whose environment has a Stripe variable but not both. Open a checkout, complete it in the simulator, watch the stake appear on the production board.
- **Proposed fix.** Decide the provider mode from the *deployment* as well as the credentials: in `getProviderMode()` (or at the call sites in `route.ts:39-74` and `dev/pay/route.ts`) require `getAppEnv() === "development"` for the dev provider, and make a partial configuration in preview behave like production — paused, with the config report as the operator's signal. Alternatively scope `DATABASE_URL` to Production only and run a separate preview database.
- **Status.** open

### R07-3 — Nothing validates the production environment; `requireProdEnv()` has no caller

- **Severity.** P2
- **Category.** ops
- **Evidence.** `requireProdEnv()` is defined at `lib/env.ts:164` and called from nowhere in the app: `grep -rn "requireProdEnv" --include=*.ts --include=*.tsx` returns only `lib/env.ts` itself, `lib/env.test.ts`, a comment at `app/api/jobs/config/route.ts:10-11`, `HANDOFF.md:284` and `doc/PROD-READINESS-CHECKLIST.md:41` (which already records the same thing). The only runtime surface is the authenticated `GET /api/jobs/config` (`app/api/jobs/config/route.ts`), which does not run unless an operator asks: probed on 3212 it answered `503 {"ok":false,"env":"production","findings":[{"key":"STRIPE_WEBHOOK_SECRET","severity":"required"}…]}` while the shop was serving a buyer-facing 403 (§5.3). `REQUIRED_PROD_ENV` (`lib/env.ts:39`) also omits `ADMIN_TOKEN`, so the endpoint that reports the missing variables can itself be locked out by a missing variable.
- **Reproduction.** Deploy production with `PAYMENTS_LIVE=true` and one Stripe variable: the app boots, serves every page, and reports the problem only to a caller who already knows to ask.
- **Proposed fix.** Call `requireProdEnv()` once at startup in a module the app cannot avoid importing (e.g. `lib/prisma.ts` or `instrumentation.ts`) with a hard failure in `getAppEnv() === "production"`, and add `ADMIN_TOKEN` to `REQUIRED_PROD_ENV`. If a hard failure is unacceptable at launch, log the report at `error` level on every cold start so it appears in the deployment logs without a request.
- **Status.** open

### R07-4 — A syntactically present but invalid key passes configuration and 502s every buyer

- **Severity.** P2
- **Category.** money
- **Evidence.** Key *mode* is classified from the prefix alone (`lib/stripe.ts:130-141`), so `STRIPE_SECRET_KEY=sk_test_REVIEWfake…` is "configured": `stripeEnabled`/`providerConfigured()` are true (`lib/stripe.ts:18-19`, `lib/flags.ts:12-14`), `GET /api/jobs/config` stops reporting it, `/api/dev/pay` correctly refuses, and every checkout answers `502 {"error":"Payment provider unavailable. Try again."}` leaving a row `…|stripe|pending|9|(null)|(null)|Md` (§5.4). The only signal is the console line `stripe: checkout/sessions rejected (HTTP 401, key=sk_test) — { "error": { "message": "Invalid API Key provided: sk_test_************************0000" …` (§5.5). Contrast the *missing*-variable case, which at least closes the shop with a 403 (§5.3): a wrong key leaves the storefront open and takes money to the door and back.
- **Reproduction.** Set both variables, with the key truncated by one character, and POST a checkout.
- **Proposed fix.** Add a key-validity probe to `/api/jobs/config` (a `GET /v1/balance` or a zero-amount session create with a short timeout) so the report can distinguish present from working, and emit an error-level log with a counter once per minute rather than per request. Test: a case with a stubbed 401 asserting the config report's `severity:"required"` finding.
- **Status.** open

### R07-5 — The partial-configuration warning is unreachable in production

- **Severity.** P3
- **Category.** correctness
- **Evidence.** `route.ts:112-114` warns when `stripePartiallyConfigured()`, but it sits *after* the paused guard at `:109-111`: in production a partial configuration makes `paymentsLiveServer()` false (`lib/flags.ts:12-20`), so the function has already returned 403 and the warning never executes. In non-production the warning does fire, which is exactly the posture where it does not matter (§5.2 — the deployment believes it is fine and is not). Probed: 3212's checkout returned the paused 403 and no partial-config line appeared in the server log.
- **Reproduction.** Production + `PAYMENTS_LIVE=true` + one Stripe variable; POST a checkout; grep the log for `partial Stripe configuration`.
- **Proposed fix.** Move the check above the paused guard so the operator's log carries the cause, and pair it with the config report (R07-3).
- **Status.** open

### R07-6 — Legacy `WHOP` rows are a dead end that still renders a payment page

- **Severity.** P3
- **Category.** data
- **Evidence.** `prisma/migrations/0006_stripe_provider/migration.sql` adds the `stripe` enum value and deliberately keeps `whop`; `prisma/schema.prisma:54-60` records four live rows in that state. `/pay/{whop-row}` answers 200 and renders the simulator, while `/api/dev/pay` refuses the row with `403 {"error":"Simulator handles dev payments only."}` (§5.8) because the page gate tests the process mode (`app/pay/[paymentId]/page.tsx`) and the endpoint additionally tests the row's provider. A buyer holding an old link therefore reaches a page whose primary button can only print an error (`PaySimulator.tsx:33`).
- **Reproduction.** Insert a `PENDING` row with `provider='whop'`, open `/pay/<id>`, press *Pay now*.
- **Proposed fix.** Either hide the pay page for non-`DEV` rows (`notFound()` when the row's provider is not the current mode) or replace the simulator body for such rows with the paused/waitlist copy. The enum value itself can stay: dropping it needs a data migration and buys nothing.
- **Status.** open

### R07-7 — The simulator's copy asserts a cause it cannot know

- **Severity.** P3
- **Category.** content
- **Evidence.** `PaySimulator.tsx:56` tells the buyer *"No Stripe keys configured — this simulator stands in for the real checkout."* In the 3212 posture a key **is** configured and only the webhook secret is missing (§5.3); in the 3207 posture a complete `sk_…` key is present in the process environment. The sentence is rendered from `getProviderMode()`, which cannot see the difference between "no key" and "half a configuration", so it states the confident and wrong one.
- **Reproduction.** Any partial configuration; open `/pay/<id>`; read the second paragraph.
- **Proposed fix.** Make the copy neutral — the heading already says `DEV SIMULATOR` — or pass the real reason from the server page (`stripePartiallyConfigured()` is importable in the server component beside it).
- **Status.** open

## 8. Acceptance criteria

- [x] The mode table exists and every row was observed, not derived — §5.1, four live postures.
- [x] `getProviderMode()` is pinned to credential presence with a citation — §3, `lib/stripe.ts:18-19,28`.
- [x] The two rotation procedures are runnable steps with a verification step each — §5.7 A.1-6, B.1-5.
- [x] The stale-webhook-secret symptom is stated exactly, including the absence of a row, a stake, an email and a success log — §5.7.
- [x] A partial configuration in production has been exercised end to end, including the simulator route — §5.3, R07-1.
- [x] The preview-posture claim is backed by a database row, not by reading the environment — §5.2.
- [x] An invalid key's failure mode is recorded with Stripe's own message — §5.5, R07-4.
- [x] The provider-mode page gate is verified in both directions — 404 in stripe mode (§5.4), 200 in dev mode (§5.1).
- [x] Migration 0006 and the legacy Whop rows are accounted for, including what a buyer sees — §5.8, R07-6.
- [x] `requireProdEnv()`'s call sites have been searched, not assumed — R07-3.
- [ ] How to revoke the old key without a window (R07-4's proposed check) — needs the operator's dashboard and a valid key.
- [ ] The endpoint's seven handled event types re-verified from the dashboard — cited from `doc/PROD-READINESS-CHECKLIST.md` §5, U07-4.

## 9. Open questions

- **Q1.** Should a preview deployment be able to take payments at all? R07-2 assumes not; a deliberate preview-payments feature would invert the finding.
- **Q2.** Is the dev simulator a feature the operator wants to keep reachable in a non-production deployment that has a customer-facing URL? If yes, R07-1's fix should be "production-only gate"; if no, the simulator should require the admin token everywhere.
- **Q3.** `PRODUCT_TAX_CODE = "txcd_10000000"` (`lib/stripe.ts:52`) is Stripe's "general — tangible goods" code, applied with a comment about Managed Payments. Whether that is the right classification for a stake is a tax question, not a code question, and only the operator's accountant can settle it.
- **Q4.** A rejected key produces one log line per buyer attempt. Is an alert wanted on that line, or is the dashboard's own 4xx view enough (R07-4)?

## 10. Cross-references

- `06` §5.6/§7 R06-7 — the 502 this doc explains; `06` §5.4-5.5 — idempotency replay.
- `05` §7 R05-8 — the provider-mode page gate, cited not re-derived; verified again here in both directions (§5.4).
- `08` — what happens to the `PENDING` rows this doc leaves behind, and to the reversals whose metadata is set at `lib/stripe.ts:109-112`.
- `09` — what the money bought.
- `10` — the receipt that a settlement enqueues.
- `doc/PROD-READINESS-CHECKLIST.md` §1 (`DATABASE_URL` scope), §5 (endpoint `we_1UFVsvQ8DCQQIpW5GtOvFfws`, seven handled types, `WHOP_*` deletion), §7 l.41 (`requireProdEnv` call sites, `ADMIN_TOKEN`).
- Plan §1 matrix: S3 × L4; plan §2 batch 2 doc-07 spec.

## 11. Change log

- 2026-09-15 — authored 2026-09-15 against `9681bdcbff2435ef258224c52000e0f8d6089f5c`. First pass: sections 1-12, findings R07-1…R07-7, UNKNOWN U07-1…U07-4.

## 12. UNKNOWN log

| Id | Phase | Category | Unknown | What settles it |
| --- | --- | --- | --- | --- |
| U07-1 | 07 | ops | Whether the production Stripe key currently configured in Vercel is valid, and whether the endpoint `we_1UFVsvQ8DCQQIpW5GtOvFfws` is currently delivering | A dashboard reading of the endpoint's delivery rate plus one `GET /v1/balance` with the production key |
| U07-2 | 07 | money | Whether a real card completes on this integration (session creation fields are verified only against Stripe's rejection path) | One test-mode session paid with a test card, then the webhook walk in `08` §5 against that row |
| U07-3 | 07 | security | Whether `nextUrl.origin` can be forced to an attacker host by a proxy in front of the app — the success/cancel URLs are built from it (`route.ts:64-66`) | A request through the production proxy with `Host`/`X-Forwarded-Host` variants and a read of the resulting session's `success_url`; in-process probes here resolved to the local origin in every variant |
| U07-4 | 07 | ops | The dashboard-side state of the two credentials and the endpoint (key labels, roll history, `WHOP_*` variable deletion) | Operator screenshot/export of the Vercel and Stripe configuration pages |
