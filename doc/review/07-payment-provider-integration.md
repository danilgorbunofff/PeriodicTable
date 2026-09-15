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

### 5.9 Fix verification

2026-09-15, this worktree, after the §11 fix pass. Two limits on what follows, both stated because they bound what is proven. There is no Stripe account reachable from here, so no key is probed against Stripe and no session is created; and this host has no Postgres (and no Docker to make one), so the DB-gated suites stay skipped, exactly as they are in the plain `npm test` run. What the fix pack could execute is the real `POST /api/checkout` handler; everything else on the money path is pinned by unit suites over the new modules plus `readFileSync` assertions at the call sites.

```
npx vitest run         → 38 files passed, 5 skipped (43); 541 passed, 0 failed, 71 skipped (612)
npx tsc --noEmit       → clean (after npx prisma generate — see below)
npx eslint lib app     → clean
```

- **The gate (R07-1, R07-2).** `lib/phase7.test.ts` drives a truth table over `{NODE_ENV, VERCEL_ENV, VITEST, NEXT_PHASE, PAYMENTS_LIVE, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET}` and re-runs §5.1's four postures by environment rather than by hand: 3206 (local dev, no Stripe variables) → the simulator is the only checkout; 3207 (preview, `sk_live_x` set, no webhook secret) → **neither** the simulator nor a live shop; 3212 (production, `PAYMENTS_LIVE=true`, key set, no secret) → both false; 3214 (both credentials) → live Stripe, simulator dead. `PAYMENTS_LIVE=false` closes the simulator in every environment, and a case asserts the invariant that a live simulator never coincides with a production environment. The two call sites are pinned statically: `/api/dev/pay` checks `devSimulatorEnabled()` **before** `req.json()` and before any Prisma read, and `/pay/[paymentId]` carries both `notFound()` gates plus the row-provider gate.
- **Mode is not permission.** `lib/stripe.test.ts` asserts production with a half pair still reads `getProviderMode() === "dev"` — the finding's own premise — while `devSimulatorEnabled()` and `paymentsLiveServer()` are both false. That is the 3207/3212 posture no longer being decided by key presence.
- **The startup report (R07-3).** `lib/env.test.ts` asserts `reportProdEnvAtStartup()` is silent outside production and during a build phase (with a spy, so "silent" means not called), that in production it emits exactly one `error` line naming the missing variables and `/api/jobs/config`, that the sentinel values never appear in it, that it never throws, and — statically — that `lib/prisma.ts` imports and calls it. `ADMIN_TOKEN` is in `REQUIRED_PROD_ENV`, so the drift guard that equates `required` findings with that list covers the promotion.
- **The key probe (R07-4).** `lib/stripe.test.ts` asserts `probeStripeKey()` calls `GET https://api.stripe.com/v1/balance` with a `Bearer` header and an abort signal, that 401 and 403 map to `invalid` with Stripe's echoed key redacted out of the detail, that a 500 and a throwing `fetch` map to `unknown` (never `invalid`), that an absent key costs no request, and that a second call inside the 60 s window is served from the cache (injected clock). `lib/env.test.ts` asserts the severity mapping — `invalid` fails `ok`, `unknown` does not — and `lib/ops.test.ts` asserts the route's `stripeKey` field and that no test process reaches the network. The probe was **not** run against Stripe: U07-1 stands.
- **R07-5, executed.** The one case that drives a route: production, `PAYMENTS_LIVE=true`, one Stripe variable, `POST /api/checkout` → the 403 paused body **and** exactly one `partial Stripe configuration … payments are paused` line at `error` level; a second POST adds no second line. §5.3's probe is the before: that posture produced no line at all.
- **R07-6.** `app/pay/[paymentId]/page.tsx` reads the row's `provider` and 404s unless it is `PaymentProvider.DEV`, so §5.8's legacy row now answers 404 instead of a page whose only button is a 403. The enum is untouched — four live rows still deserialize.
- **R07-7.** The `reason` prop and the sentence it carried are gone (asserted at source), and because any Stripe variable closes the simulator, the page cannot render in a partial configuration at all: the sentence §5.3 disproved is now unreachable rather than reworded.

**Still not measured.** No live key (U07-1), no real card (U07-2), no proxy probe (U07-3), no dashboard reading (U07-4). `nextUrl.origin` is unchanged, `PRODUCT_TAX_CODE` is unchanged (§9 Q3), and the rejected-session line is throttled and at `error` level but nothing alerts on it (§9 Q4). `npx tsc --noEmit` failed on the first attempt with ten errors in files this pass never touched (`app/api/webhooks/stripe/route.ts`, `lib/settle.ts`, `app/api/checkout/route.ts:360`) — all of them `Property 'STRIPE' does not exist` / `not assignable to type 'PaymentProvider'`: the generated Prisma client in `node_modules` predated migration 0006. `npx prisma generate` fixed it and the typecheck went clean. A checkout that has not regenerated the client cannot typecheck, which is a note for whoever runs this next, not a defect this doc reported.

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

**After the fix pass** (§5.9), the rows above that cited a finding read:

| Situation | Current behaviour | What the buyer sees | What the operator sees |
| --- | --- | --- | --- |
| No Stripe variables, local development | unchanged — dev mode, one click applies a stake | the simulator (R07-1 keeps this; §9 Q2) | nothing |
| Partial config, non-production (§5.2's 3207) | the shop is paused and the simulator is refused — a half pair is not a licence to run the stand-in provider | "Payments are paused — join the waitlist." (403); `/pay/<id>` is a 404 | one `partial Stripe configuration … falling back … (permitted outside production only)` line, and no line at all once production is the environment |
| Partial config, production (§5.3's 3212) | paused as before, and the simulator is now closed too: `POST /api/dev/pay` is 403 and `/pay/<id>` is 404 | the waitlist instead of a free stake | one `… payments are paused` line at `error` level, once per process, before the guard that answers the buyer |
| Both credentials, invalid key (§5.4/§5.5) | `GET /api/jobs/config` reports `stripeKey:"invalid"` as a `required` finding and answers 503 | the same 502 | a 503 from the endpoint that reports configuration, plus at most one rejected-session line per minute per process instead of one per click |
| Both credentials, key probe unreachable (§5.5's offline case) | `stripeKey:"unknown"` is a `degraded` advisory: the report still says `ok` | unchanged | no alert on a network blip |
| Production, `PAYMENTS_LIVE=false` | 403 as before, and the simulator is closed with it | "Payments are paused…" | nothing |
| Legacy `WHOP` row revisited (§5.8) | `/pay/<id>` → 404 (the row's own provider is not `DEV`) | "no such page" rather than a button that can only print an error | nothing |
| Cold start in a misconfigured production | one boot-time line naming the missing variables and the endpoint that reports them | unchanged | the deployment log, without anyone having to ask `/api/jobs/config` first |
| `ADMIN_TOKEN` missing in production | now a `required` finding (it was not in the list) | unchanged unless an admin surface is used | `/api/jobs/config` 503 names it |

## 7. Findings

### R07-1 — The dev simulator grants permanent stakes in a production-flagged process whenever Stripe is half-configured

- **Severity.** P0
- **Category.** money
- **Evidence.** `getProviderMode()` is `"stripe"` only when **both** credentials are present (`lib/stripe.ts:18-19,28`); `app/api/dev/pay/route.ts:12-15` gates on `getProviderMode() !== "dev"` and its header comment claims the endpoint *"can never grant stakes for free in production"* — which the probe disproves: with `VERCEL_ENV=production`, `PAYMENTS_LIVE=true` and `STRIPE_SECRET_KEY` set but `STRIPE_WEBHOOK_SECRET` absent, `POST /api/dev/pay` answered `200 {"ok":true,"status":"paid","terminal":true,"elementSymbol":"Fr"}` for a row inserted a second earlier, and the row came back `…|dev|paid|5|…|Fr||2026-09-15 09:30:43.11|1` — `appliedAt` set, `providerRef` empty. The page gate agrees with the endpoint: `GET /pay/probe_prod_free_1` returned the simulator with HTTP 200 (§5.3).
- **Reproduction.** Start the app with `VERCEL_ENV=production`, `PAYMENTS_LIVE=true`, `STRIPE_SECRET_KEY=<anything>`, no `STRIPE_WEBHOOK_SECRET` and a reachable database. `GET /api/jobs/config` reports `STRIPE_WEBHOOK_SECRET` required; `POST /api/checkout` is 403; `POST /api/dev/pay` with any `PENDING` `paymentId` returns `paid` and applies the stake.
- **Proposed fix.** Gate the simulator on *configuration* rather than on mode: refuse when `isProduction()` (`lib/env.ts:31`) or when `stripePartiallyConfigured()` (`lib/stripe.ts:33`) is true — a partial configuration is an incident, not a licence to run the stand-in provider. Belt and braces: require the admin bearer token on `/api/dev/pay`, and make the pay page 404 under the same condition. Test: a case asserting 403/404 for `{production + partial config}` and 200 only for `{non-production + no Stripe vars}`.
- **Fix.** `devSimulatorEnabled()` in `lib/flags.ts:43` decides the simulator on configuration **and** environment: it returns false in production, false under `PAYMENTS_LIVE=false`, and false whenever *either* Stripe variable is set — both means the real keys are in play, exactly one is the incident §5.3 documents — so it is true only for `getAppEnv()` `development`/`test` with no Stripe variables at all. The two call sites use that one predicate: `app/api/dev/pay/route.ts:29` answers `403 {"error":"Simulator disabled on this deployment."}` as the function's first statement, before the body is parsed and before any Prisma read, and `app/pay/[paymentId]/page.tsx:29-30` calls `notFound()`. `lib/phase7.test.ts` re-runs §5.1's four postures as a nine-case environment truth table plus the invariant that a live simulator never coincides with a production environment, and pins the route order statically; `lib/env.test.ts` asserts a lone `STRIPE_SECRET_KEY` closes the simulator and that the kill switch does too. *Not taken:* the admin bearer token on `/api/dev/pay` — that is §9 Q2's call, and taking it unasked would lock the operator out of the local flow the route exists for.
- **Status.** fixed

### R07-2 — A preview-flagged deployment serves the simulator and writes real stakes to the production database

- **Severity.** P0
- **Category.** money
- **Evidence.** Outside production `paymentsLiveServer()` returns true unless `PAYMENTS_LIVE=false` (`lib/flags.ts:12-20`), and `getProviderMode()` follows key presence, so a Preview deployment with one Stripe variable set is in dev mode. Probed on 3207 (`VERCEL_ENV=preview`, key set, secret unset): `POST /api/checkout` → `200 {… "provider":"dev","checkoutUrl":"/pay/cmu2gw3hr000lb4o0p0pn5o8x"}`, then `POST /api/dev/pay` → `{"ok":true,"status":"paid","terminal":true,"elementSymbol":"Si"}`, then the row `cmu2gw3hr000lb4o0p0pn5o8x|dev|paid|11|Si|1|probe preview stripe` — an $11 stake with no card (§5.2). `doc/PROD-READINESS-CHECKLIST.md` §1 records `DATABASE_URL` scoped `Production, Preview`, so this is the production pool.
- **Reproduction.** Any preview deployment whose environment has a Stripe variable but not both. Open a checkout, complete it in the simulator, watch the stake appear on the production board.
- **Proposed fix.** Decide the provider mode from the *deployment* as well as the credentials: in `getProviderMode()` (or at the call sites in `route.ts:39-74` and `dev/pay/route.ts`) require `getAppEnv() === "development"` for the dev provider, and make a partial configuration in preview behave like production — paused, with the config report as the operator's signal. Alternatively scope `DATABASE_URL` to Production only and run a separate preview database.
- **Fix.** The same predicate closes this posture, because it is decided on the deployment and not on key presence: a preview process with `sk_live_x` set and no `STRIPE_WEBHOOK_SECRET` now has neither a shop (`paymentsLiveServer()` is false, `lib/flags.ts:52-63`) nor a simulator, so `POST /api/checkout` answers the paused 403 and `GET /pay/<id>` is a 404 — the $11 stake §5.2 recorded can no longer be minted. `lib/phase7.test.ts` asserts exactly that posture by environment, and that a fully configured non-production deployment falls through to the real keys rather than the stand-in. *Unchanged and not code:* the ops half of this finding — preview shares the production `DATABASE_URL`, so a preview deployment that *does* take real payments writes real rows. That is §9 Q1's decision, and the alternative in the proposed fix (scope the variable to Production only) is a Vercel change this pass cannot make.
- **Status.** fixed

### R07-3 — Nothing validates the production environment; `requireProdEnv()` has no caller

- **Severity.** P2
- **Category.** ops
- **Evidence.** `requireProdEnv()` is defined at `lib/env.ts:164` and called from nowhere in the app: `grep -rn "requireProdEnv" --include=*.ts --include=*.tsx` returns only `lib/env.ts` itself, `lib/env.test.ts`, a comment at `app/api/jobs/config/route.ts:10-11`, `HANDOFF.md:284` and `doc/PROD-READINESS-CHECKLIST.md:41` (which already records the same thing). The only runtime surface is the authenticated `GET /api/jobs/config` (`app/api/jobs/config/route.ts`), which does not run unless an operator asks: probed on 3212 it answered `503 {"ok":false,"env":"production","findings":[{"key":"STRIPE_WEBHOOK_SECRET","severity":"required"}…]}` while the shop was serving a buyer-facing 403 (§5.3). `REQUIRED_PROD_ENV` (`lib/env.ts:39`) also omits `ADMIN_TOKEN`, so the endpoint that reports the missing variables can itself be locked out by a missing variable.
- **Reproduction.** Deploy production with `PAYMENTS_LIVE=true` and one Stripe variable: the app boots, serves every page, and reports the problem only to a caller who already knows to ask.
- **Proposed fix.** Call `requireProdEnv()` once at startup in a module the app cannot avoid importing (e.g. `lib/prisma.ts` or `instrumentation.ts`) with a hard failure in `getAppEnv() === "production"`, and add `ADMIN_TOKEN` to `REQUIRED_PROD_ENV`. If a hard failure is unacceptable at launch, log the report at `error` level on every cold start so it appears in the deployment logs without a request.
- **Fix.** `ADMIN_TOKEN` is in `REQUIRED_PROD_ENV` (`lib/env.ts:45`) with its reason beside it (`lib/env.ts:82`), so a missing admin token is now a `required` finding and `/api/jobs/config` answers 503 without it. The startup half took the second of the two proposed variants rather than the first: `reportProdEnvAtStartup()` (`lib/env.ts:218`) is called at module scope in `lib/prisma.ts:10`, so the first Prisma import of a cold start logs — once, at `error`, naming the count, the missing variables' reasons and `/api/jobs/config` — and never throws. A crash loop on a missing variable would take the board down for a shop that can serve it without that variable, so `requireProdEnv()` (`lib/env.ts:235`) keeps its strict semantics and still has no call site, which the header comment now says out loud rather than leaving to be discovered. `lib/env.test.ts` asserts the silence outside production and during a build (with a spy, so "silent" means it was not called), the single line's content, that it never throws and never prints the sentinel values, and statically that `lib/prisma.ts` calls it.
- **Status.** fixed

### R07-4 — A syntactically present but invalid key passes configuration and 502s every buyer

- **Severity.** P2
- **Category.** money
- **Evidence.** Key *mode* is classified from the prefix alone (`lib/stripe.ts:130-141`), so `STRIPE_SECRET_KEY=sk_test_REVIEWfake…` is "configured": `stripeEnabled`/`providerConfigured()` are true (`lib/stripe.ts:18-19`, `lib/flags.ts:12-14`), `GET /api/jobs/config` stops reporting it, `/api/dev/pay` correctly refuses, and every checkout answers `502 {"error":"Payment provider unavailable. Try again."}` leaving a row `…|stripe|pending|9|(null)|(null)|Md` (§5.4). The only signal is the console line `stripe: checkout/sessions rejected (HTTP 401, key=sk_test) — { "error": { "message": "Invalid API Key provided: sk_test_************************0000" …` (§5.5). Contrast the *missing*-variable case, which at least closes the shop with a 403 (§5.3): a wrong key leaves the storefront open and takes money to the door and back.
- **Reproduction.** Set both variables, with the key truncated by one character, and POST a checkout.
- **Proposed fix.** Add a key-validity probe to `/api/jobs/config` (a `GET /v1/balance` or a zero-amount session create with a short timeout) so the report can distinguish present from working, and emit an error-level log with a counter once per minute rather than per request. Test: a case with a stubbed 401 asserting the config report's `severity:"required"` finding.
- **Fix.** `probeStripeKey()` (`lib/stripe.ts:93`) answers the question the prefix cannot: `GET https://api.stripe.com/v1/balance` with the key as a `Bearer` header, a 3 s abort, and a 60 s per-key cache, mapping `ok` → `valid`, 401/403 → `invalid`, anything else (including a throw) → `unknown`. `credentialFinding()` (`lib/env.ts:142`) turns that into a finding: `invalid` is `required`, so the report fails and `/api/jobs/config` answers 503 with `stripeKey:"invalid"`; `unknown` is only `degraded`, so a network blip does not raise the alarm the finding is about. The probe runs **only** in production and **only** after `jobAuth()`, so an unauthenticated caller cannot use the endpoint as a key oracle, and it never logs or returns the key — Stripe's own echoed key goes through `redactSecrets()` (`lib/stripe.ts:69`) before it reaches a log line or the response. The per-request warning became `logCheckoutRejection()` (`lib/stripe.ts:137`), exported, at `error` level, latched to one line per minute per process with a suppressed counter, which is the "counter once per minute" half of the proposed fix. `lib/stripe.test.ts` pins the request shape, both failure severities, the redaction and the cache window on an injected clock; `lib/env.test.ts` the severity mapping; `lib/ops.test.ts` the route field and that tests never reach the network. *Not taken:* an alert on the line (§9 Q4) — the pass made it reachable and quiet, not paged.
- **Status.** fixed

### R07-5 — The partial-configuration warning is unreachable in production

- **Severity.** P3
- **Category.** correctness
- **Evidence.** `route.ts:112-114` warns when `stripePartiallyConfigured()`, but it sits *after* the paused guard at `:109-111`: in production a partial configuration makes `paymentsLiveServer()` false (`lib/flags.ts:12-20`), so the function has already returned 403 and the warning never executes. In non-production the warning does fire, which is exactly the posture where it does not matter (§5.2 — the deployment believes it is fine and is not). Probed: 3212's checkout returned the paused 403 and no partial-config line appeared in the server log.
- **Reproduction.** Production + `PAYMENTS_LIVE=true` + one Stripe variable; POST a checkout; grep the log for `partial Stripe configuration`.
- **Proposed fix.** Move the check above the paused guard so the operator's log carries the cause, and pair it with the config report (R07-3).
- **Fix.** The warning block is above the paused guard (`app/api/checkout/route.ts:151-171`) and latched by a module-scope `partialConfigLogged` flag, so it fires once per process rather than once per request — the environment cannot change while a function instance lives, and a paused shop under a load test would otherwise log a line per request. The message branches on `paymentsLiveServer()` so it states the consequence that actually applies: falling back to the simulator where that is permitted, paused where it is not. One decommissioned-the-first-draft note, recorded because it is the same mistake in miniature: the initial version of the fix wrapped the block inside the paused branch, which would have left it dead in the posture this finding is about. `lib/phase7.test.ts` drives the real handler in the §5.1 3212 posture and asserts the 403 body plus exactly one `partial Stripe configuration … payments are paused` line, and that the second POST adds none; before the fix that posture produced no line at all (§5.3).
- **Status.** fixed

### R07-6 — Legacy `WHOP` rows are a dead end that still renders a payment page

- **Severity.** P3
- **Category.** data
- **Evidence.** `prisma/migrations/0006_stripe_provider/migration.sql` adds the `stripe` enum value and deliberately keeps `whop`; `prisma/schema.prisma:54-60` records four live rows in that state. `/pay/{whop-row}` answers 200 and renders the simulator, while `/api/dev/pay` refuses the row with `403 {"error":"Simulator handles dev payments only."}` (§5.8) because the page gate tests the process mode (`app/pay/[paymentId]/page.tsx`) and the endpoint additionally tests the row's provider. A buyer holding an old link therefore reaches a page whose primary button can only print an error (`PaySimulator.tsx:33`).
- **Reproduction.** Insert a `PENDING` row with `provider='whop'`, open `/pay/<id>`, press *Pay now*.
- **Proposed fix.** Either hide the pay page for non-`DEV` rows (`notFound()` when the row's provider is not the current mode) or replace the simulator body for such rows with the paused/waitlist copy. The enum value itself can stay: dropping it needs a data migration and buys nothing.
- **Fix.** The page reads the row and 404s unless it belongs to the simulator: `app/pay/[paymentId]/page.tsx:31-35` selects `provider` and calls `notFound()` when `payment?.provider !== PaymentProvider.DEV`, which is the first of the two proposed shapes (hide the page) rather than the second (swap the body). §5.8's legacy row therefore answers 404 instead of rendering a button whose every press is a 403 — and it does so whether or not the process is in dev mode. The enum is untouched: dropping `WHOP` needs a data migration and would strand four live rows, exactly as `prisma/schema.prisma:54-60` records.
- **Status.** fixed

### R07-7 — The simulator's copy asserts a cause it cannot know

- **Severity.** P3
- **Category.** content
- **Evidence.** `PaySimulator.tsx:56` tells the buyer *"No Stripe keys configured — this simulator stands in for the real checkout."* In the 3212 posture a key **is** configured and only the webhook secret is missing (§5.3); in the 3207 posture a complete `sk_…` key is present in the process environment. The sentence is rendered from `getProviderMode()`, which cannot see the difference between "no key" and "half a configuration", so it states the confident and wrong one.
- **Reproduction.** Any partial configuration; open `/pay/<id>`; read the second paragraph.
- **Proposed fix.** Make the copy neutral — the heading already says `DEV SIMULATOR` — or pass the real reason from the server page (`stripePartiallyConfigured()` is importable in the server component beside it).
- **Fix.** Neither variant of the proposed fix was needed once R07-1/R07-2 landed, and that is the honest record: because `devSimulatorEnabled()` returns false whenever *any* Stripe variable exists, the page can only render with zero Stripe variables in the environment, so the `reason` prop had exactly one reachable value and the sentence it fed was unreachable. The prop and the branched copy were therefore deleted rather than made neutral — `PaySimulator.tsx` now says what the page *is* ("A local stand-in for the real checkout: no payment is taken and no money moves. On Pay, the stake applies instantly."), the heading still says `DEV SIMULATOR`, and the pay page no longer imports `stripePartiallyConfigured`. `lib/phase7.test.ts` asserts at source that no `reason` prop and no "No Stripe keys are configured" survive.
- **Status.** fixed

## 8. Acceptance criteria

Ticked boxes are verified by §5: the first block by the live probes of §5.1-§5.8 as run on 2026-09-15, the second by the fix pass's own run in §5.9. The two unticked boxes are operator probes this checkout cannot run.

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

**Fix-pass criteria** (2026-09-15, verified by §5.9):

- [x] A half-configured Stripe pair cannot hand out a stake in any environment, and the simulator is unreachable anywhere but `development`/`test` with no Stripe variables (R07-1, R07-2 — the truth table in `lib/phase7.test.ts`, `lib/flags.ts:43`, the 403 at `app/api/dev/pay/route.ts:29` before the body is read)
- [x] A missing production variable is visible on every cold start without anyone asking (`reportProdEnvAtStartup()`, called at `lib/prisma.ts:10`; `ADMIN_TOKEN` in `REQUIRED_PROD_ENV`)
- [x] A syntactically present but invalid key fails configuration instead of passing it (R07-4 — `probeStripeKey()` + `credentialFinding()`, 503 from `/api/jobs/config`, no network in tests)
- [x] The partial-configuration warning reaches the posture that needs it, once per process (R07-5 — the executed route case, the before being §5.3's silent log)
- [x] A legacy non-`DEV` payment row is a 404, not a button that can only fail (R07-6, §5.8)
- [x] The simulator's copy claims nothing it cannot know (R07-7; the offending sentence is unreachable by construction, not merely reworded)

## 9. Open questions

- **Q1.** Should a preview deployment be able to take payments at all? R07-2 assumes not; a deliberate preview-payments feature would invert the finding. *Partly closed 2026-09-15: the free-stake half is gone — a preview deployment with a half-configured pair now pauses the shop and 404s the simulator, so it can no longer mint stakes with no card. What is untouched is the fully configured case: with both credentials and no `PAYMENTS_LIVE=false`, `paymentsLiveServer()` is still true outside production, and the code has no opinion about which database those real payments land in. That remains the operator's call, and it is the one that decides whether the `DATABASE_URL` scope is a finding or a preference.*
- **Q2.** Is the dev simulator a feature the operator wants to keep reachable in a non-production deployment that has a customer-facing URL? If yes, R07-1's fix should be "production-only gate"; if no, the simulator should require the admin token everywhere. *Unanswered, and this pass deliberately did not answer it by accident: the fix went with the "non-production + no Stripe variables" shape, which keeps the local flow working, and did **not** add `adminAuth` to `/api/dev/pay`. If the operator wants the simulator gated everywhere, it is a one-line change in `app/api/dev/pay/route.ts` plus the token in the local `.env` — and `lib/phase7.test.ts`'s truth table is where that decision gets pinned.*
- **Q3.** `PRODUCT_TAX_CODE = "txcd_10000000"` (`lib/stripe.ts:52`) is Stripe's "general — tangible goods" code, applied with a comment about Managed Payments. Whether that is the right classification for a stake is a tax question, not a code question, and only the operator's accountant can settle it. *Untouched by the fix pass: the constant is unchanged, and the probe R07-4 added is `GET /v1/balance`, which is not tax-specific.*
- **Q4.** A rejected key produces one log line per buyer attempt. Is an alert wanted on that line, or is the dashboard's own 4xx view enough (R07-4)? *Not taken, and narrowed: the line is now `console.error` through `logCheckoutRejection()` with a 60 s per-process latch and a suppressed counter, so the volume is bounded at one line per minute per instance instead of one per click — but nothing alerts on it, because an alert recipient is `18`'s territory and there is none configured. The decision is now "do we want a page for this" rather than "can we see it".

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
- 2026-09-15 (working tree): fix pass for R07-1…R07-7, each cited in §7 with the verification in §5.9 and the register's `Fixed in` cells. `lib/flags.ts`: new `devSimulatorEnabled()` (configuration **and** environment — false in production, false under `PAYMENTS_LIVE=false`, false whenever either Stripe variable is set, true only for `development`/`test` with no Stripe variables) and `partialProviderConfig()`; `paymentsLiveServer()` now shares the predicate, and `paymentsLiveClient()` is untouched. Call sites: `/api/dev/pay` checks it as the first statement, before the body is parsed and before any Prisma read; `/pay/[paymentId]` checks it, and then the row's own `provider` (`notFound()` unless `DEV`); the checkout's dev resume URL moved from `getProviderMode() === "dev"` to it. `lib/env.ts`: `ADMIN_TOKEN` promoted into `REQUIRED_PROD_ENV`, `configFindingsOk()` as the single definition of `ok`, the `CredentialHealth` union plus `credentialFinding()`, and `reportProdEnvAtStartup()` — called at `lib/prisma.ts:10`, silent outside production, one `error` line in production, never throws. `lib/stripe.ts`: `probeStripeKey()` (`GET /v1/balance`, `Bearer`, 3 s abort, 60 s per-key cache, `redactSecrets()`), `credentialFinding` wired into `/api/jobs/config`'s new `stripeKey` field, and `logCheckoutRejection()` latching the rejected-session line to one `error` per minute. `app/api/checkout/route.ts`: the partial-configuration warning moved above the paused guard and latched once per process. `app/pay/[paymentId]/PaySimulator.tsx`: the `reason` prop and the "No Stripe keys configured" sentence deleted. Tests: new `lib/phase7.test.ts` (nine-case environment truth table, mode-is-not-permission, the executed R07-5 reachability case, call-site wiring), additions to `lib/stripe.test.ts`, `lib/env.test.ts`, `lib/ops.test.ts`, and one spy corrected in `lib/phase4.test.ts` (the rejection log moved from `warn` to `error`). Verification §5.9: `npx vitest run` 541 passed / 0 failed / 71 skipped, `npx tsc --noEmit` clean after `npx prisma generate`, `npx eslint lib app` clean. No schema, migration or dependency change; `WHOP` stays in the enum; no real key and no live payment. Deliberately not taken: `adminAuth` on `/api/dev/pay` (§9 Q2), a hard `requireProdEnv()` failure at startup, a per-request (rather than per-minute) rejection line, and an alert on it (§9 Q4).

## 12. UNKNOWN log

| Id | Phase | Category | Unknown | What settles it |
| --- | --- | --- | --- | --- |
| U07-1 | 07 | ops | Whether the production Stripe key currently configured in Vercel is valid, and whether the endpoint `we_1UFVsvQ8DCQQIpW5GtOvFfws` is currently delivering | A dashboard reading of the endpoint's delivery rate plus one `GET /v1/balance` with the production key |
| U07-2 | 07 | money | Whether a real card completes on this integration (session creation fields are verified only against Stripe's rejection path) | One test-mode session paid with a test card, then the webhook walk in `08` §5 against that row |
| U07-3 | 07 | security | Whether `nextUrl.origin` can be forced to an attacker host by a proxy in front of the app — the success/cancel URLs are built from it (`route.ts:64-66`) | A request through the production proxy with `Host`/`X-Forwarded-Host` variants and a read of the resulting session's `success_url`; in-process probes here resolved to the local origin in every variant |
| U07-4 | 07 | ops | The dashboard-side state of the two credentials and the endpoint (key labels, roll history, `WHOP_*` variable deletion) | Operator screenshot/export of the Vercel and Stripe configuration pages |
