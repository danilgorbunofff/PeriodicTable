# 06 — Checkout before payment

| Field | Value |
| --- | --- |
| Phase · batch | 06 · 2 |
| Status | draft — fixes applied (R06-1…R06-10) |
| Date reviewed | 2026-09-15 (fix pass 2026-09-15, §5.13) |
| Commit reviewed | `9681bdcbff2435ef258224c52000e0f8d6089f5c` |
| Reviewer | review agent |

**How this doc was produced.** A scratch Postgres 16 container (`ptl-review-batch2-pg`, host port 55499) was migrated 0000–0006 and seeded (`prisma/seed.ts`: 122 elements, 8 startups, 26 stakes), then a dev server was started from an **isolated copy** of the checkout (`%TEMP%\ptl-b2\s3206`, `node_modules` junctioned) on port 3206 with `DATABASE_URL`, `CRON_SECRET`, `CLICK_SALT` and Turnstile/Stripe variables set per probe. Nothing in this doc was measured against production or the main checkout. The isolation mattered: several Next dev servers sharing one `.next` directory corrupt each other's route manifests, which first produced phantom 404s and silently-null payloads (§5.12).

| Probe not run | Why | Residue |
| --- | --- | --- |
| Real card payment (J4) | Operator deferral; `04` U04-3 still owns it | 1 real charge — none taken here |
| Modal render in a browser at 360–430 px with the on-screen keyboard up | This host's Chrome writes no PNG (`02` §5.8) and there is no Playwright/Puppeteer/jsdom in `package.json` | None — U06-1 |
| Turnstile challenge solved by a human | Needs an interactive browser (the widget only authenticates a real visitor) | None — U06-2 |
| Production `/api/checkout` with live keys | Would create a real Stripe session | None |

## 1. Scope

**Owns.** Plan §1 **S5 × L5 (client half) and S6 × L3 (intake half)**: `components/Modals.tsx` (`CheckoutPreview`), `components/TurnstileWidget.tsx`, `app/api/checkout/route.ts` up to and including the provider call, `lib/validate.ts`, `lib/abuse.ts`, `lib/rateLimit.ts`, `lib/rateStore.ts`, `lib/ip.ts`, `lib/flags.ts`.

**Does not own.** The provider session itself and its modes (`07`); anything that happens after the provider says "paid" (`08`); who owns an element and what a reclaim costs (`09` — `04` §7 R04-1/R04-2 already settled the quote derivation); the mail the receipt triggers (`10`); the API shape of `POST /api/checkout` as a contract (`11`).

**Paths inspected.** `app/api/checkout/route.ts` whole (374 lines); `components/Modals.tsx:39-503`; `components/Modal.tsx:88-108`; `components/TurnstileWidget.tsx` whole; `lib/validate.ts` whole; `lib/abuse.ts` whole; `lib/rateLimit.ts`, `lib/rateStore.ts`, `lib/ip.ts`, `lib/flags.ts` whole; `lib/pricing.ts:90-130`; `lib/reservations.ts:37-54`; `app/page.tsx:100-161,196-210,400-440`; `lib/env.ts`; `lib/stripe.ts:18-35`.

## 2. Actors

The ten-actor checklist, restricted to the intake half.

| Actor | Applies | What this phase must check for them |
| --- | --- | --- |
| Anonymous visitor | yes | Every rejection states what to fix, next to the field that caused it, without losing what was typed |
| Paying customer | yes | One click → one `Payment` row → one resumable URL; an interrupted attempt is never silently orphaned |
| Defending holder | no — `09` | — (their stake is what the intake prices against, `04` §3) |
| Losing bidder | no — `09` | — |
| Operator | yes | Can they tell a rejected buyer from an abandoned one, and is a dead provider visible without a support ticket? |
| Attacker | yes | Rate limits, honeypot, Turnstile, and whether any rejection leaks server state |
| Crawler / unfurl bot | n/a | The form is client-only; nothing here is crawlable |
| Email recipient | partly — `10` | The address the form collects becomes the receipt recipient — intake decides what is a valid address |
| Payment provider | yes | Whether the app hands out a dead URL, and whether a provider failure is recoverable by the buyer |
| Future maintainer | yes | Whether `validate.ts` is the single source of truth for what is a legal input |

## 3. Intended behaviour

Entering a claim costs money and the form is the gate. The client validates the shape of what was typed (`lib/validate.ts` is imported by the modal for `domainFromUrl`/`domainFromSocial`, `components/Modals.tsx:14`), the server re-validates authoritatively and never trusts a client-supplied domain (`app/api/checkout/route.ts:160-163`: "Identity (Phase 1): canonical domain comes ONLY from the validated URL/handle. A caller-provided startup.domain is ignored"). The rejection order is deliberate and cheapest-first — paused flag, rate limit, honeypot, attestation, Turnstile, required fields, amount shape, input shape (`route.ts:109-156`). A rejection is supposed to be *field-scoped*: `validateCheckoutInput` returns `{ error, field }` (`lib/validate.ts:87-123`) and the modal renders `field`-tagged messages under the input while leaving `serverErr` null (`Modals.tsx:273-276`).

Idempotency is meant to make a retry safe: the key is minted per submit (`Modals.tsx:250-253`), the server resolves it **before any mutable operation** (`route.ts:167-176`), a matching retry returns the stored payment plus a resumable URL, and key reuse with a different payload is refused with `IDEMPOTENCY_CONFLICT` (`route.ts:88-96`). A concurrent duplicate loses the unique race and is *replayed*, never 500'd (`route.ts:331-347`). A provider failure is retryable, never a dead link: `resumeCheckoutUrl` returns null instead of a dev URL for a live payment, and the caller answers 502 (`route.ts:39-74,363-366`).

Abuse controls: 5 attempts per IP per hour (`route.ts:116-119`), a honeypot that answers with a deliberately opaque 400 (`route.ts:127-129`), and Turnstile — enabled strictly by the presence of `TURNSTILE_SECRET`, and **failing closed when enabled** (`lib/abuse.ts`). Payments are globally pausable: `paymentsLiveServer()` returns false for everyone when `PAYMENTS_LIVE=false`, and in production requires `PAYMENTS_LIVE === "true"` *and* a configured provider (`lib/flags.ts:14-20`), while the client copy keys off `NEXT_PUBLIC_PAYMENTS_LIVE` plus `NEXT_PUBLIC_VERCEL_ENV` (`lib/flags.ts:22-27`, `Modals.tsx:180,294-321`).

## 4. The path, walked

1. **Open.** `/?el=Li` (or `?el=Li&stake=6`) opens `CheckoutPreview` with an amount the app minted; an app-minted amount keeps tracking the live quote until the buyer edits it (`components/Modals.tsx:182-192`; `04` §4.5).
2. **Type.** The buyer picks Product URL or @ Social, fills name and pitch, optionally an email, and an amount (`type="number"`, `min={1}`, `Modals.tsx:410`). Every keystroke clears any field-scoped server message (`Modals.tsx:339,352,367,383`).
3. **Attest.** The 18+/ownership checkbox must be ticked; the submit button is `disabled={submitting || !attest}` (`Modals.tsx:484-486`).
4. **Submit.** `submit()` (`Modals.tsx:227`) returns immediately if any client gate is unmet (§7 R06-1), otherwise POSTs `/api/checkout` with `{ elementSym, amountUsd, email?, path, honeypot, attest, turnstileToken, idempotencyKey, startup: { url, linkType, domain, title, pitch } }` (`:236-256`). The Turnstile token comes from the widget's callback, falling back to the hidden `cf-turnstile-response` input (`:231-235`).
5. **Server gates.** Paused → 403; rate limit → 429; honeypot → opaque 400; attest → 400 `field:"attest"`; Turnstile → 400; required fields → 400; amount shape → 400; `validateCheckoutInput` → 400 `field` (`route.ts:109-156`).
6. **Quote.** Identity comes from the validated URL/handle; the symbol is canonicalised against the inventory (`route.ts:157-163`). Under a per-element advisory lock inside a money transaction, the server releases expired reservations, re-reads every stake, prices off the first non-hidden non-zero row, classifies the amount, checks the hold, finds-or-creates the startup and writes the `Payment` row (`route.ts:180-329`).
7. **Answer.** `200 { paymentId, checkoutUrl, provider, reservation? }` (`route.ts:368-374`); `CHECKOUT_STARTED` is audited (`route.ts:355-361`).
8. **Irreversible point.** Nothing irreversible happens here — no money moves at intake. But one thing becomes *sticky*: the `Payment` row and, on a TAKE, the 15-minute `ClaimReservation` (`route.ts:304-327`). From this point the element can refuse the next buyer (409 `RESERVATION_CONFLICT`) while the row that caused it is invisible to them.
9. **Provider hop.** The client does `window.location.href = json.checkoutUrl` (`Modals.tsx:284`) — a full page load, so no modal state survives it.

**4.1 After the fix pass.** The deltas from the walk above; §7 carries the per-finding fix and §5.13 the verification.

- **Steps 3-4 (submit).** The gates are no longer a silent boolean chain: `submitBlocked()` (new `lib/checkoutFace.ts`) returns the first failing gate *with* its field and sentence and the modal renders it, so no press of Continue ends without text. The idempotency key is minted once per attempt signature and kept for the modal session, so step 9's full page load is no longer the only thing that can preserve one. A widget whose script never loaded now says so.
- **Step 5 (server gates).** The order is now: paused 403 → partial-provider warning → `clientIp` → JSON parse → honeypot → attest → Turnstile → `elementSym`/`idempotencyKey`/`amountUsd` → email shape (`400 field:"email"`) → `validateCheckoutInput` → symbol canonicalisation → fingerprint → idempotency lookup and replay → rate limit → element lookup. The throttle therefore counts new attempts only (R06-2), and an address receipts cannot use never reaches a write (R06-10).
- **Steps 7-8 (answer).** A duplicate submit answers with the create path's envelope — `200 { paymentId, checkoutUrl, provider, reservation? }` with `guaranteedTake: true` on a live hold — or, for a row that is no longer `PENDING`, `{ paymentId, status, error }`. A provider failure is a 502 that now carries `paymentId`, so the retry reaches the row the first attempt wrote. And `cancelUrl` (`?canceled=<sym>`) has the reader step 1 lacked, so the element, not just the board, is where the buyer lands.

## 5. Live evidence

2026-09-15, this host, scratch DB, isolated dev server on 3206 (`npx next dev -p 3206`), all requests `POST /api/checkout` with a JSON body written to a file and sent with `--data-binary`, `Content-Type: application/json`.

### 5.1 The rejection matrix, verbatim

Case bodies are named by what they vary; every other field was valid (`elementSym:"Li"`, a fresh `idempotencyKey`, `attest:true`, `startup.url:"https://acme-lab.dev"`, `title:"Acme Lab"`, `pitch:"A lab bench in the cloud"`).

| # | Case | HTTP | Body (verbatim) |
| --- | --- | --- | --- |
| 02 | `amountUsd: 0` | 400 | `{"error":"Whole dollars only."}` |
| 03 | `amountUsd: 4` on a free element | 409 | `{"error":"First stake is $5+.","code":"BELOW_FLOOR","takeLead":5}` |
| 04 | `amountUsd: 5.5` | 400 | `{"error":"Whole dollars only."}` |
| 05 | `startup.url: "https://example.com"` | 400 | `{"error":"That domain is not allowed.","field":"url"}` |
| 06 | `startup.url: "acme-lab"` | 400 | `{"error":"Enter a full URL starting with https://","field":"url"}` |
| 07 | `startup.url: "@a"`, `linkType:"social"` | 400 | `{"error":"Enter a valid @handle (letters, numbers, dots, underscores).","field":"url"}` |
| 08 | `startup.title: "A"` | 400 | `{"error":"Name must be at least 2 characters.","field":"title"}` |
| 09 | 33-character title | 400 | `{"error":"Name must be 32 characters max.","field":"title"}` |
| 10 | `startup.pitch: "x"` | 400 | `{"error":"Pitch must be at least 2 characters.","field":"pitch"}` |
| 11 | 141-character pitch | 400 | `{"error":"Pitch must be 140 characters max.","field":"pitch"}` |
| 12 | `attest: false` | 400 | `{"error":"Please confirm you own or may promote this URL.","field":"attest"}` |
| 13 | `honeypot: "bot"` | 400 | `{"error":"Something went wrong. Try again."}` |
| 14 | `idempotencyKey: "short"` | 400 | `{"error":"idempotencyKey is required."}` |
| 15 | `elementSym: "Zzz"` | 404 | `{"error":"Element not found."}` |
| 16 | `amountUsd: 12` on an element whose leader holds $12 | 409 | `{"error":"$12 is taken — add $1 more to stand clear of the tie.","code":"TIE","takeLead":13}` |
| 17 | `amountUsd: 13` on that element | 200 | `{"paymentId":"cmt9k8…","checkoutUrl":"/pay/cmt9k8…","provider":"dev","reservation":{"reservedTotal":13,"expiresAt":"2026-09-15T…Z","guaranteedTake":true}}` |
| 18 | a second buyer taking #1 while 17's hold is live, `amountUsd: 19` for a different domain | 409 | `{"error":"This element has a held take quote at $13. Refresh for a new quote.","code":"RESERVATION_CONFLICT","reservedTotal":13,"expiresAt":"…"}` |
| 19 | Turnstile enabled (`TURNSTILE_SECRET` set), no token | 400 | `{"error":"Bot check failed. Try again."}` |
| 20 | Turnstile enabled, `turnstileToken:"bogus-token"` (real `siteverify` round-trip) | 400 | `{"error":"Bot check failed. Try again."}` |
| 21 | six attempts from one IP inside the hour | 429 on the 6th | `{"error":"Too many checkout attempts. Try again later."}` |
| 22 | `PAYMENTS_LIVE=false` | 403 | `{"error":"Payments are paused — join the waitlist.","waitlist":true}` |
| 23 | Stripe mode, provider call fails (fake key) | 502 | `{"error":"Payment provider unavailable. Try again."}` |

Case 12 is unreachable from the shipped modal (the button is disabled until attest, `Modals.tsx:485`) — it is a direct-API result and is listed because `07`/`14` care that the gate is server-side.

### 5.2 What the client renders for each of those, derived from the code that receives them

`Modals.tsx:265-281` is the only consumer. Four branches, checked in order:

1. `409 && typeof json.takeLead === "number"` → `setPriceMoved(takeLead)` **and** `serverErr = json.error` (`:267-269`) → the gold banner **"Price moved to $5 — continue?"** with a **`Use $5`** button (`:436-443`), plus the red `serverErr` line and the toast carrying the same string.
2. `json.code === "RESERVATION_CONFLICT" && json.expiresAt` → `serverErr = "${json.error} Held until HH:MM."` with a 12-hour locale time (`:270-272`).
3. `typeof json.field === "string" && typeof json.error === "string"` → the message renders **under that input** in red-700 and `serverErr` is set to null (`:273-276`, `:356-397`; the one-element-per-id fix is `05` §7 R05-1/R05-4 and is cited, not re-reported).
4. otherwise → the bare `serverErr` line (`:278`).

Every failure branch also fires `onDone(json.error ?? "Checkout failed — retry when ready.")` (`:280`), so the message appears **twice** — inline and as a toast — and the toast outlives the modal. Branches 1, 2 and 4 override "Something went wrong. Try again." only when the server sent an `error`, so the honeypot (case 13) and the rate limit (case 21) both reach the buyer as the same opaque sentence, and case 13's sentence is also the client's own generic fallback for a malformed body.

### 5.3 Observed UI text per server reason (the matrix the plan asked for)

| Server reason (case) | Status | What the buyer sees | Where it renders |
| --- | --- | --- | --- |
| `Whole dollars only.` (02, 04) | 400 | `Whole dollars only.` | generic `serverErr` + toast (`Modals.tsx:278`) |
| `First stake is $5+.` + `takeLead: 5` (03) | 409 | **"Price moved to $5 — continue?"** + `Use $5` + red `First stake is $5+.` | price-move banner + `serverErr` (`:267-269`) |
| `$12 is taken — add $1 more…` + `takeLead: 13` (16) | 409 | **"Price moved to $13 — continue?"** + `Use $13` + red `$12 is taken — add $1 more to stand clear of the tie.` | same branch |
| held-quote conflict (18) | 409 | `This element has a held take quote at $13. Refresh for a new quote. Held until 17:42.` | `serverErr` (`:270-272`) |
| `That domain is not allowed.` (05) | 400 | `That domain is not allowed.` | under the Product URL field (`:356`) |
| `Enter a full URL starting with https://` (06) | 400 | `Enter a full URL starting with https://` | under the field, **with `aria-invalid`** |
| `Enter a valid @handle…` (07) | 400 | `Enter a valid @handle (letters, numbers, dots, underscores).` | under the Product URL field, though the tab says *Social handle* |
| `Name must be at least 2 characters.` (08) | 400 | same | under Startup name |
| `Pitch must be 140 characters max.` (11) | 400 | same | under One-line pitch |
| `Please confirm you own or may promote this URL.` (12) | 400 | only the toast: `field` and `error` are both strings, so branch 3 above stores `serverField = { field: "attest", message }` and sets `serverErr` to null — but no input tests `field === "attest"` (`:356,371,390,410`), so the message is set and never rendered. Nothing is highlighted | toast only (R06-4) |
| `Something went wrong. Try again.` (13, honeypot) | 400 | `Something went wrong. Try again.` | generic + toast |
| `idempotencyKey is required.` (14) | 400 | `idempotencyKey is required.` | generic + toast (a server bug would read as buyer error) |
| `Element not found.` (15) | 404 | `Element not found.` | generic + toast |
| `Bot check failed. Try again.` (19, 20) | 400 | `Bot check failed. Try again.` | generic + toast |
| `Too many checkout attempts. Try again later.` (21) | 429 | same | generic + toast |
| `Payments are paused — join the waitlist.` (22) | 403 | the waitlist panel replaces the form entirely | `Modals.tsx:294-321` |
| `Payment provider unavailable. Try again.` (23) | 502 | same sentence + toast | generic + toast |

### 5.4 Idempotency

| Probe | Result |
| --- | --- |
| Same key, same body, second call | 200 `{"paymentId":"…","status":"paid"}` (the row was paid by then) |
| Same key, different amount | 409 `{"error":"This idempotency key was already used for a different checkout.","code":"IDEMPOTENCY_CONFLICT"}` |
| Same key, different element | 409 `IDEMPOTENCY_CONFLICT` |
| Same key again on a fresh IP | 200 — the replay survives a new IP |
| Two concurrent identical bodies (`&`) | **both 200, same `paymentId`**, bodies differ: the winner's carries `provider` + `reservation.guaranteedTake`, the loser's is `{"paymentId":…,"status":"pending","checkoutUrl":"…"}`. DB: exactly one `Payment` row for the key |
| Replay after the IP's 5/hour quota was spent | **429** — the limiter (`route.ts:117`) is evaluated before the key lookup (`route.ts:175`) |

### 5.5 A paid key replayed from a spent IP

Sequence on one scratch DB: 6 sequential `POST /api/checkout` calls from one IP with distinct keys → `200, 200, 409, 409, 429, 429`. Replaying the **paid** key of the first call from a *different* IP → 200 with the stored pending/paid status. The same replay from the spent IP would be answered 429 before the key is read.

### 5.6 Provider down, and what is left behind

`07` case: Stripe mode with a fake key. `POST /api/checkout` → **502** `{"error":"Payment provider unavailable. Try again."}`. A DB read immediately after shows the `Payment` row **already exists and is `pending`**, with `providerRef` null and `providerCheckoutUrl` null; the response says nothing about it, so the buyer has no handle on it. Because the modal mints the key per submit (`Modals.tsx:250-253`) and a full page load follows any success (`:284`), a buyer who reloads gets a **new** key and a **new** row.

### 5.7 Abandonment and resume

| Step | Behaviour |
| --- | --- |
| Buyer abandons at the provider | `Payment` stays `pending`; on a TAKE the `ClaimReservation` expires 15 min after creation (`lib/reservations.ts:11-17`) and is lazily released (`:59-68`) |
| The same key arrives again | `resumeCheckoutUrl` returns the stored `providerCheckoutUrl`, or mints the dev URL `/pay/{id}` and stores it (`route.ts:51-58`) |
| Their own abandoned hold blocks their retry? | No — `reservationConflict` returns no conflict for the reservation's own `startupId` (`lib/reservations.ts:49`) |
| Another buyer's hold blocks them | Yes: 409 `RESERVATION_CONFLICT` while the hold is live, 15-minute worst case |
| Buyer comes back later with no key | A new `Payment` row for the same domain and element; the old row is never swept (see `08` §6 for the row-shape story) |
| Stripe cancel URL | `/` + `?canceled=<SYM>` (`route.ts:66`) |

### 5.8 The cancel deep link has no reader

`grep -rn "canceled" --include=*.ts --include=*.tsx` → the only three hits are the `cancelUrl` construction in `route.ts:66` and the two `cancel_url` names inside `lib/stripe.ts`. `app/page.tsx:100-161` handles `?paid`, `?unsub`, `?el`+`?stake`+`?r` and then calls `history.replaceState`; there is no `canceled` branch. A buyer who cancels at Stripe therefore lands on a normal board with the parameter silently rewritten away.

### 5.9 The paused surface is client-only

With a production process (`VERCEL_ENV=production`, `PAYMENTS_LIVE` unset): `POST /api/checkout` → 403 `{"error":"Payments are paused — join the waitlist.","waitlist":true}`. `GET /` → neither the string "Payments are paused" nor "waitlist" appears in the HTML; the pause is enforced by `paymentsLiveClient()` in the browser (`Modals.tsx:180,294`). A visitor with JS disabled or a pre-hydration screamer sees a normal, purchasable board.

### 5.10 Rate limiting, store and IP source

`lib/rateLimit.ts` + `lib/rateStore.ts`: 5/60 min per `checkout:${ip}`; `clientIp` reads the forwarded headers (`lib/ip.ts`). Observed counts are in §5.4/§5.5; a 10/hour `waitlist:${ip}` limiter sits on the paused surface (`app/api/waitlist/route.ts`).

### 5.11 Turnstile, verified against the real endpoint

With `TURNSTILE_SECRET` set on the isolated server, a no-token and a bogus-token submission both produce 400 `{"error":"Bot check failed. Try again."}` after a live `siteverify` round-trip. With the secret absent, `turnstileEnabled()` is false and `verifyTurnstile` returns true without calling out (`lib/abuse.ts`), which is why the production checklist's §3b rule ("`TURNSTILE_SECRET` must stay unset until the widget is mounted") is load-bearing rather than cosmetic.

### 5.12 The client half was never exercised in a browser here

No browser automation exists in this repo (`package.json` has no Playwright, Puppeteer, jsdom or Testing Library) and this host's Chrome writes no PNG (`02` §5.8). §5.3's "what the buyer sees" is therefore derived from the render code with the response bodies of §5.1 — except for the verbatim sentences, which are copy-pasted from the probe log, and the modal's own static copy, which is read from source. The one visual question that matters (does the keyboard cover the button on a phone) is U06-1.

### 5.13 Fix verification

2026-09-15, this worktree, after the §11 fix pass. The DB-gated suites need a Postgres the default `npm test` run does not have, so the run below was pointed at a scratch container of its own (`periodic-test-pg`, `postgres:16-alpine`, host port 55433, migrated `0000`–`0006`) through `DATABASE_URL`. No shared database and no other container's database was touched, and nothing was written outside the fixture rows the suites clean up themselves.

- `npm run typecheck` — clean. `npm run lint` — `No ESLint warnings or errors`.
- `npm test` against that database — **577 passed, 6 failed, 0 skipped** (583 cases). The 6 failures are pre-existing and unrelated to this pass: `lib/claimFace.test.ts` (1 case) and `lib/legalMeta.test.ts` (5) anchor multi-line source assertions on `\n`, which cannot match the CRLF this Windows checkout writes (`core.autocrlf=true`); they fail identically on the untouched tree.
- `lib/checkoutFace.test.ts` 20/20 and `lib/checkoutIntake.test.ts` 16/16 — the new cases. `lib/routes.test.ts` 12/12, including the rewritten throttle case, which is the only *executed* proof of the R06-2 order: five new keys answer `200×5` then `429`, a malformed receipt address costs no attempt, and a replay of the first key after the quota is spent returns that first call's body unchanged.
- Still not measured: a DOM-level run of the modal (U06-1) and a real card payment (`04` U04-3). The client half is pinned by pure-function cases over `lib/checkoutFace.ts` plus source assertions at the call sites, not by rendering.

## 6. Failure and edge matrix

| Trigger | Current behaviour | What the user sees | What the operator sees | Acceptable? |
| --- | --- | --- | --- | --- |
| Amount 0 or non-integer | 400 before any write | `Whole dollars only.` inline + toast | nothing (no log, no audit row) | yes for the message; no counter for the operator |
| Amount below the floor | 409 `BELOW_FLOOR` + `takeLead` | "Price moved to $5 — continue?" | nothing | no — R06-3 |
| Amount ties a rival | 409 `TIE` + `takeLead` | "Price moved to $13 — continue?" | nothing | no — R06-3 |
| Blocked domain | 400 `field:"url"` | red text under the field, `aria-invalid` | nothing | yes |
| Malformed URL / handle | 400 `field:"url"` | red text under the field | nothing | yes (the tab may say Social; the label is "Product URL" — R06-5) |
| Empty form, press Continue | **no request at all** | nothing happens | nothing | no — R06-1 |
| Social handle typed without `@` | **no request at all** | nothing happens | nothing | no — R06-1 |
| `field:"attest"` rejected server-side | 400 | message stored in a slot no input renders; toast only | nothing | no — R06-4 |
| Startups with a webhook/JS URL | `normalizeUrl` rejects credentials and non-public hosts (`lib/validate.ts:40-58`) | red text under the field | nothing | yes |
| Turnstile enabled, widget blocked by the network | 400 bot-check | `Bot check failed. Try again.` with no visible widget and no retry hint | `console.warn`? none — only the 400 | no — R06-6 |
| Honeypot tripped (incl. autofill) | opaque 400 | `Something went wrong. Try again.` | nothing | partly — R06-6 |
| Rate limit | 429 before the key lookup | `Too many checkout attempts. Try again later.` | nothing | no — R06-2 |
| Provider down | 502, `Payment` row already written | `Payment provider unavailable. Try again.` | nothing until someone reads the DB | no — R06-7 |
| Buyer cancels at Stripe | `?canceled=SYM` written | normal board, no acknowledgement | nothing | no — R06-8 |
| Buyer abandons, returns | new key, new row, old row orphaned | — | orphan `pending` rows accumulate | no — R06-7 |
| Two simultaneous submits | one row, one session (Stripe `Idempotency-Key: pt_checkout_${paymentId}`, `lib/stripe.ts:59+`), two different 200 bodies | one checkout | — | yes on money; R06-9 on the body |
| Element unknown | 404 | `Element not found.` + toast | nothing | yes |
| Payments paused | 403 + waitlist panel | waitlist form | nothing | yes (server-side), §5.9 for the HTML |
| Email `"@"` | accepted as an address (`route.ts:147`) | no client error (direct API only) | a receipt to a nonsense address | no — R06-10 |

**After the fix pass** (§5.13), the rows above that cited a finding read:

| Trigger | Behaviour now | What the buyer sees |
| --- | --- | --- |
| Empty form, press Continue | the client gate answers before any request | the sentence for the first missing field, under that field (R06-1) |
| Social handle typed without `@` | same gate, reported against the url field | `Enter a valid @handle (letters, numbers, dots, underscores).` under the `Social handle` label (R06-1, R06-5) |
| Malformed URL or handle | client gate, then the server's own sentence if it still gets through | the label's sentence, tab-aware (R06-5) |
| Amount below the floor, or tying a rival | 409 as before | the server's sentence alone — no "Price moved" and no `Use $N` (R06-3) |
| Amount genuinely re-quoted | 409 `PRICE_MOVED` | "Price moved to $N — continue?" with `Use $N` (R06-3) |
| `field:"attest"` rejected | 400 as before | the shared error line under the form instead of a slot nothing renders (R06-4) |
| Turnstile widget never loads | the client gate holds the submit and says so; a request that skips it still meets the server's Turnstile gate, opaque to a bot | the widget's own sentence in the form: reload or use another network (R06-6) |
| Rate limit | the limiter runs after the key lookup and counts new attempts only | a replay of a stored key still returns its session; a sixth **new** attempt → 429 (R06-2) |
| Provider down | 502 carries `paymentId`, and the modal keeps the key that reached the row | `Payment provider unavailable. Try again. Your reference: <id>.` — retrying resumes that row (R06-7) |
| Buyer cancels at Stripe | `?canceled=SYM` re-opens the checkout for that element | "Not paid — nothing was charged. Your claim is still here." plus that element's modal (R06-8) |
| Two simultaneous submits | one row, one session, same envelope kind | one checkout (R06-9; the concurrent loser cannot see a reservation the winner has not committed — §11) |
| Email `"@"` | 400 `field:"email"` before any write | `That email doesn't look right.` under the receipt field (R06-10) |
| Honeypot tripped (incl. autofill) | unchanged, and deliberately opaque | `Something went wrong. Try again.` (R06-6, §9 Q4) |

## 7. Findings

### R06-1 — An untouched or handle-only form submits nothing, silently

- **Severity.** P1
- **Category.** ux
- **Evidence.** `components/Modals.tsx:228` — `if (badUrl || badEmail || badTitle || badPitch || !domain || !attest || clientErr || submitting) return;` — the early return has no message and the submit button's only gate is `disabled={submitting || !attest}` (`:485`). The form is `noValidate` (`:330`), so the browser's own `required` messages never fire either. `badUrl` is false for an empty field (`:146`, `url.length > 0 && …`), and `domain` is null until a `://` URL or an `@`-prefixed handle is present (`:150-157`), so **the two most common first clicks** — empty form, or a social handle typed without `@` — produce no request and no text at all.
- **Reproduction.** Open the stake modal on any element, type `yourhandle`, tick the checkbox, press Continue. Nothing happens: no request in the network tab, no message, no focus move. Same with an untouched form.
- **Proposed fix.** Give the early return a reason: compute the failing gate and `setServerField`/`setClientErr` with the same sentence the server would send (`Enter a full URL starting with https://`, `Enter a valid @handle …`), or drop `!domain` from the guard and let the server answer 400 `field:"url"` (it already does, case 06/07). Test: a DOM-level test that a click with `url === ""` renders a message; `lib/checkoutFace.test.ts` would be the natural home, and no such suite exists today (U06-1).
- **Fix.** `submit()` in `components/Modals.tsx` now opens with `if (submitting) return;` and then one gate — `submitBlocked()` in the new `lib/checkoutFace.ts` — whose verdict is *always* rendered: a field-scoped sentence under `url`/`title`/`pitch`/`email`, or the shared error line when the failing gate has no field of its own. `!domain` (a handle typed without `@`) is reported against `url` with the Social tab's sentence instead of returning. Test: `lib/checkoutFace.test.ts` (a rejected submit always yields text; an untouched form names its first field; the gate's order), `lib/checkoutIntake.test.ts` (the gate is the last statement before the request, `return;` appears twice). The DOM half of U06-1 is unchanged.
- **Status.** fixed

### R06-2 — The retry of a payment the buyer already owns is quota-gated

- **Severity.** P2
- **Category.** money
- **Evidence.** `app/api/checkout/route.ts:116-119` (limiter) precedes `:175-176` (key lookup); probe §5.5 — 5 attempts from one IP exhaust the hour, after which a replay of a **paid** key is answered 429 with `Too many checkout attempts. Try again later.`.
- **Reproduction.** Submit three valid checkouts and two rejected ones from one IP, pay one of them, then replay the paid key: 429. The buyer is told to try later and shown no link to the session they already paid for.
- **Proposed fix.** Evaluate the idempotency lookup before the limiter (a replay writes nothing, so it needs no quota), or exempt a request whose key already resolves to a row. Test: a case in the checkout suite asserting that a replay of a stored key succeeds after the quota is spent.
- **Fix.** `app/api/checkout/route.ts` now resolves `prisma.payment.findUnique({ where: { idempotencyKey } })` and calls `idempotentReplay()` **before** the limiter, so `checkout:${ip}` counts new attempts only; a replay writes nothing and answers from the stored row. Test: `lib/routes.test.ts` — five new keys answer `200` then a sixth is `429`, a malformed receipt address costs no attempt, and a replay of the first key after the quota is spent returns that first call's body unchanged (§5.13, executed against a scratch Postgres).
- **Status.** fixed

### R06-3 — Two different 409s are both announced as "Price moved"

- **Severity.** P3
- **Category.** ux
- **Evidence.** `components/Modals.tsx:267-269` branches on `res.status === 409 && typeof json.takeLead === "number"` alone. The server sends exactly that shape for a floor violation (`route.ts` classify → `BELOW_FLOOR` + `takeLead`, probe case 03) and for a tie (`TIE` + `takeLead`, probe case 16). So a newcomer who typed $4 is told **"Price moved to $5 — continue?"** — nothing moved, $5 was always the floor — and a rival who typed exactly $12 is told the price moved when they simply hit a tie.
- **Reproduction.** On a free element send `amountUsd: 4`; on a $12 leader send `amountUsd: 12`. Identical banner, different causes.
- **Proposed fix.** Branch on `json.code`: keep "Price moved" for `PRICE_MOVED`, use the server's sentence alone for `BELOW_FLOOR` and `TIE`, and only offer `Use $N` when the new figure is genuinely the quote. Test: two client cases pinning the banner text per code.
- **Fix.** `checkoutRefusal()` in the new `lib/checkoutFace.ts` keeps the "Price moved" banner and the `Use $N` button for `json.code === "PRICE_MOVED"` with a numeric `takeLead` and nothing else: `BELOW_FLOOR` and `TIE` print the server's own sentence (`First stake is $5…`, `Someone holds the lead — bid $N or more.`) with no new price to accept. `Modals.tsx` renders the banner from that mapping and `onAmount(priceMoved)` only ever receives the re-quoted figure. Test: `lib/checkoutFace.test.ts` (per-code cases, plus the two codes that must *not* quote a price), `lib/checkoutIntake.test.ts` (the banner and `onAmount` wiring). §9 Q1 is answered by this: the rule is stated, not implied.
- **Status.** fixed

### R06-4 — The server's attestation rejection is stored where nothing renders it

- **Severity.** P3
- **Category.** ux
- **Evidence.** `app/api/checkout/route.ts:130-132` returns `field:"attest"`; `components/Modals.tsx:273-276` stores it as `serverField` with `serverErr` null; the four renderers test only `field === "url" | "title" | "pitch"` and the email input tests `badEmail` (`:356,371,390,410`). No branch tests `"attest"`, so the message is **set and never displayed** — the buyer sees only the toast, which disappears.
- **Reproduction.** Direct API call with `attest:false` shows the response; the modal path is unreachable from the shipped UI because the button is disabled, so this is a latent-contract bug rather than a live dead end: enabling the button, or a future caller sending `attest` as a string (`attestValid` accepts both), produces a message nobody shows.
- **Proposed fix.** Render any unmatched `serverField` as a generic `serverErr`, which is the one branch that cannot fall through. Test: a case that a `field:"attest"` response produces visible text.
- **Fix.** `checkoutRefusal()` renders a field-scoped sentence only when `FIELD_RENDERERS` knows a node for that field (`url`, `title`, `pitch`, `email`); any other `field` — `attest` included — falls through to the shared error line, as does a body with no `error` at all. `serverField` is only set for a rendered field, so nothing can be stored where nothing draws. Test: `lib/checkoutFace.test.ts` (`attest` and `message`-shaped bodies both produce text; each renderer field keeps its own), `lib/checkoutIntake.test.ts` (one `co-<field>-error` node per renderer, `fieldHasRenderer` branch).
- **Status.** fixed

### R06-5 — A social-handle rejection is printed under the Product URL label

- **Severity.** P3
- **Category.** ux
- **Evidence.** `lib/validate.ts:87-123` returns `field:"url"` for both the product-URL branch and the handle branch (`:101-110`); the modal's error node for `field:"url"` is the one under `Product URL` (`Modals.tsx:340-362`), whose label is chosen by `tab` (`:341`) but whose message is fixed client-side to `Enter a full URL starting with https://` when `badUrl` is true (`:358`) — so a visitor on the **@ Social** tab who types `@a` is told to enter a full URL.
- **Reproduction.** Switch to @ Social, type `@a`, press Continue → `Enter a valid @handle (letters, numbers, dots, underscores).` renders under the label "Social handle" (correct) — but the *client* gate fires first for other handle shapes and prints the URL sentence under the same label.
- **Proposed fix.** Make the client's fallback sentence depend on `tab`, and keep the server's sentence authoritative. Test: one case per tab.
- **Fix.** The client's url/handle sentence is now a function of the tab (`urlMessage(tab)` in the new `lib/checkoutFace.ts`): `Enter a full URL starting with https://` on `Product`, `Enter a valid @handle (letters, numbers, dots, underscores).` on `@ Social` — the same sentence the server sends for that branch (`lib/validate.ts:101-110`), so a client-side bail and a server 400 read alike under the same label. The server's sentence still wins whenever it answers. Test: `lib/checkoutFace.test.ts` (one case per tab, plus the empty-field case that stays quiet), `lib/checkoutIntake.test.ts` (the url node reads the message from that function).
- **Status.** fixed

### R06-6 — A blocked challenge script or an autofilled honeypot gives one opaque sentence

- **Severity.** P3
- **Category.** ux
- **Evidence.** `components/TurnstileWidget.tsx:76-83` — if `api.js` fails to load the widget calls `onToken(null)` and **renders nothing**; the server then rejects with `Bot check failed. Try again.` (probe cases 19-20). The honeypot field is `name="website"` (`Modals.tsx:461-469`) — the classic password-manager autofill target — and its rejection is the deliberately opaque `Something went wrong. Try again.` (`route.ts:127-129`, probe case 13).
- **Reproduction.** Block `challenges.cloudflare.com` in the browser and submit; or let a manager fill the hidden `website` input.
- **Proposed fix.** Surface the two states differently *to the buyer* while keeping them opaque to bots: when the widget never loaded (a flag the widget can raise), show "The human check could not load — reload or use another network." Keep the opaque 400. Test: a client case for the widget-failure branch; the honeypot stays deliberately indistinguishable and is worth a counter instead of a message.
- **Fix.** `components/TurnstileWidget.tsx` takes an `onLoadFail` callback, raises it (and keeps the widget's own `failed` state) when `api.js` never loads, and renders its own sentence in the form — `The human check could not load — reload or use another network.` — while still handing the server a null token, so the 400 stays `Bot check failed. Try again.` for a bot. `submitBlocked()` reports the state against no field when the widget itself failed, and the shared error line when the server rejected. The honeypot is untouched and still deliberately opaque; the counter it asks for stays open (§9 Q4). Test: `lib/checkoutIntake.test.ts` (widget + modal wiring, the childless ref div), `lib/checkoutFace.test.ts` (`humanCheckFailed` produces text with no field).
- **Status.** fixed

### R06-7 — A provider failure leaves a `Payment` row the buyer cannot reach

- **Severity.** P2
- **Category.** money
- **Evidence.** Probe §5.6 — 502 `Payment provider unavailable. Try again.` with the `Payment` row already written (`route.ts:287-300` precedes `resumeCheckoutUrl` at `:363-366`); the key is minted per submit and lives only in that request (`Modals.tsx:250-253`), and the success path leaves the modal by full page load (`:284`). §5.7 — an abandoned attempt is indistinguishable from a rejected one from the outside.
- **Reproduction.** Stripe mode, unreachable provider: POST once, then POST again with a fresh key. Two `pending` rows, one element, no URL the buyer can use, no mail.
- **Proposed fix.** Answer the 502 with the `paymentId` (and a resume endpoint or a `?resume=<id>` link) so an interrupted buyer can re-enter the same row; and give abandoned `pending` rows a sweep (`08` §6 owns the row-shape story, `13` owns the cron). Test: a case asserting the 502 body carries the id and that a second POST with it resumes rather than inserts.
- **Fix.** Both 502s (`route.ts`, the create path and the replay path) now carry `{ error, code: "PROVIDER_UNAVAILABLE", paymentId }`, and `Modals.tsx` prints `Your reference: <id>.` under the message. The modal mints one key per attempt signature and clears it **only** once a checkout has actually started, so the submit that hit the provider failure keeps its key: pressing Continue again resolves to the same `PENDING` row, and a provider that is back answers from that row instead of forking a second one. The durable per-browser key is still a product decision (§9 Q2) and the sweeper is still `13`'s. Test: `lib/checkoutIntake.test.ts` (both ids in the route, `crypto.randomUUID()` once, key retained on refusal and cleared on success).
- **Status.** fixed

### R06-8 — The Stripe cancel URL is written and read by nothing

- **Severity.** P2
- **Category.** money
- **Evidence.** `app/api/checkout/route.ts:66` sets `cancelUrl: ${origin}/?canceled=${element.symbol}`; §5.8 — no reader exists anywhere in `app/`, `components/` or `lib/`; `app/page.tsx:100-161` handles every other deep link and then replaces the URL state.
- **Reproduction.** Pay nothing and cancel at the provider: the buyer lands on the board with no acknowledgement of the element, the amount or the reserved hold; their `Payment` row stays `pending` and, on a TAKE, the element keeps refusing rivals for up to 15 minutes on their behalf.
- **Proposed fix.** Handle `?canceled`: re-open the checkout modal for that symbol with a short "Not paid — your quote is still held for N minutes" line (the reservation's `expiresAt` is in the DB, not the URL, so the copy must be conservative), or at minimum clear the parameter and explain that nothing was charged. Test: a page-level case that `?canceled=Li` opens the modal or shows the notice.
- **Fix.** `app/page.tsx` now handles `?canceled=<sym>`: it resolves the symbol with the reader already on the page, re-opens that element's checkout (`setCheckoutEl` + `setCheckoutCanceled(true)`) and shows the conservative line `Not paid — nothing was charged. Your claim is still here.`; the parameter is folded away by the same `replaceState` branch. `CheckoutPreview` takes `canceled` and renders `CHECKOUT_MSG.canceled`, which can afford the extra sentence about the reservation because the modal re-reads the pending row's own hold (15 minutes, `lib/reservations.ts:14-18`) — the page-level toast deliberately promises nothing about a hold it has not read. Test: `lib/checkoutIntake.test.ts` (route `cancelUrl` → page branch → modal prop, and the page block quotes no hold duration).
- **Status.** fixed

### R06-9 — Concurrent submits answer one payment with two different bodies

- **Severity.** P3
- **Category.** correctness
- **Evidence.** Probe §5.4 — two identical concurrent POSTs: both 200, same `paymentId`, but the winner's body carries `provider` and `reservation.guaranteedTake` while the loser's is the `idempotentReplay` shape (`route.ts:88-104`) without either. The contract (and `11`) cannot say what a duplicate submit returns.
- **Reproduction.** Fire two identical requests in parallel; diff the two bodies.
- **Proposed fix.** Have the replay path return the same envelope as the create path (it can read the reservation it just lost the race for), or document the duplicate shape as the contract. Test: a concurrency case asserting the two bodies are byte-identical.
- **Fix.** `idempotentReplay()` now answers the duplicate submit with the create path's envelope kind — `{ paymentId, checkoutUrl, provider, reservation? }`, with `guaranteedTake: true` on a reservation it can still read from the row — instead of a bare `{ paymentId, checkoutUrl, reused: true }`; a row that is no longer `PENDING` answers `{ paymentId, status, error: "This checkout is already <state> — nothing was charged again." }`, and a fingerprint mismatch is a `409 IDEMPOTENCY_CONFLICT` rather than someone else's checkout. Residual, recorded in §11: the loser of a genuine race still cannot see a reservation the winner has not committed, so byte-equality holds for a replay of a *committed* row (the executed case in `lib/routes.test.ts`) and not across two truly simultaneous first submits. Test: `lib/checkoutIntake.test.ts` (the replay envelope), `lib/routes.test.ts` (replay equals the first body).
- **Status.** fixed

### R06-10 — Any string containing `@` is accepted as the receipt address

- **Severity.** P3
- **Category.** data
- **Evidence.** `app/api/checkout/route.ts:147` — `typeof body.email === "string" && body.email.includes("@") ? body.email.trim() : null`. The client's regex (`Modals.tsx:147,205`) is the only real check, and direct callers bypass it; the address is stored on `Startup.email`/`Payment.email` and is what `lib/email.ts` sends receipts and outbid notices to (`10` §5.3).
- **Reproduction.** `POST /api/checkout` with `email: "@"` → 200 and a row whose `email` is `"@"`.
- **Proposed fix.** Reuse one address validator server-side (the regex already in the modal, or a shared `isEmail`) and reject with `field:"email"`. Test: a case per malformed address.
- **Fix.** `lib/validate.ts` exports one address validator (`isEmail`, `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`) which `validateProfileInput` reuses; `app/api/checkout/route.ts` refuses anything else with `400 { error: "That email doesn't look right.", field: "email" }` before the fingerprint and before any write, and `Modals.tsx` renders that sentence under the receipt field (`co-email-error`) while the waitlist form uses the same helper. Test: `lib/checkoutFace.test.ts` (`emailShapeBad` agrees with `isEmail` on every case), `lib/checkoutIntake.test.ts` (one sentence, both files), `lib/routes.test.ts` (the 400, and that it costs no rate-limit attempt).
- **Status.** fixed

## 8. Acceptance criteria

- [x] Every rejection a buyer can cause is visible: no submit path returns without text (§7 R06-1; pinned by `lib/checkoutFace.test.ts` and the source assertions in `lib/checkoutIntake.test.ts` — a DOM-level suite is still missing, U06-1)
- [x] A 409 is announced as what it is — a floor, a tie or a moved price (§7 R06-3; `checkoutRefusal()` keys on `json.code`, not on `takeLead`)
- [x] A retry after an interruption reaches the payment the buyer already has, and the 502 body carries its id (§7 R06-2, R06-7; the limiter runs after the key lookup and both 502s carry `paymentId`)
- [x] Cancelling at the provider produces an acknowledgement on the board (§7 R06-8; `?canceled` re-opens that element's checkout with a notice that promises nothing the page has not read)
- [x] Field-scoped server messages always have a renderer; `field:"attest"` cannot vanish (§7 R06-4; a field with no node becomes the shared error line)
- [x] The domain, not the client's `startup.domain`, is the identity (`route.ts:157-163`; probe case 05/06/07 show the server rejecting what the client would have sent)
- [x] One key, one `Payment` row, one provider session under concurrent submits (§5.4; Stripe `Idempotency-Key` at `lib/stripe.ts:59+`)
- [x] Turnstile fails closed when enabled and is skipped only when unset (`lib/abuse.ts`; §5.11)
- [x] The paused flag is enforced server-side first (`route.ts:109-111`; §5.1 case 22) — the HTML copy gap is §5.9, and `05` §9 Q2 does not cover it
- [x] A provider failure never hands out a dead dev URL for a live payment (`route.ts:39-74,363-366`; probe case 23)

## 9. Open questions

1. Should a first claim below $5 quote the floor as a *price* (today's "Price moved to $5") or state the rule ("First stake is $5+")? *Recommendation: state the rule; the current copy implies the board moved when it did not (§7 R06-3).* **Answered 2026-09-15: adopted** — only `PRICE_MOVED` quotes a price and offers `Use $N`; `BELOW_FLOOR` and `TIE` print the server's own sentence, so a first claim below the floor now reads as the rule it is (§7 R06-3).
2. Should the checkout form keep a durable key per (browser, element, domain) so an interrupted attempt resumes instead of forking a row? That is a product decision about how much state a browser may hold, not a bug; today the answer is "none" (§7 R06-7). *Still open. The pass shortens the gap without taking the decision: one key lives for the whole modal session and is cleared only once a checkout has actually started, and the 502 carries the `paymentId`, so the interruption the probe hit resumes inside the same visit. A key that survives a reload is the operator's call.*
3. Is the paused surface allowed to be client-only (§5.9)? A crawler or a JS-less visitor is shown a purchasable board that no submit can complete. *Recommendation: render the paused copy server-side when the flag is off — it is one `paymentsLiveServer()` call in the page.* *Not taken in this pass: it is a page-render change on the surface `05`/`17` own, and no finding in §7 asks for it.*
4. Should a honeypot trip be counted (an audit row or a metric) even though the buyer must not be told? Today nothing records it, so an autofill false positive is invisible to the operator (§7 R06-6). *Still open, and unchanged: the pass gives the *challenge-script* failure a visible sentence, and deliberately leaves the honeypot silent and uncounted.*

## 10. Cross-references

- **Settled and cited, not re-reported.** `05` §7 R05-1/R05-4 (one error node per id, red-700) — the modal's error nodes are the fixed shape; `05` §7 R05-8 (`/pay/[paymentId]` is a provider-mode gate with the simulator in `PaySimulator.tsx`) — the modal footer's "🔒 Secure payment via Stripe" sentence (`Modals.tsx:501`) is the same copy class and is **not** re-opened here; `04` §7 R04-1/R04-2 (`lib/stakeQuote.ts`, `prices.boardComplete`, `validateTake` on TAKE) — this doc prices nothing of its own; `05` §7 R05-7 (report and waitlist intake send mail) — `10` verifies that chain.
- **Neighbours.** `07` owns everything after `checkoutUrl` is handed out (the mode table, the simulator reach, the 502's provider half). `08` owns what happens to the `pending` rows this doc leaves behind. `10` owns the address `R06-10` lets through. `11` owns the response shape `R06-9` shows diverging. `13` owns the sweeper `R06-7` asks for. `14` owns the abuse posture of the intake.
- **Tests that already pin this surface.** `lib/routes.test.ts` (DB-gated checkout cases, including the rewritten throttle case), `lib/pricing.test.ts`, `lib/stakeQuote.test.ts`, `lib/abuse` cases; the modal itself still has no DOM suite (U06-1), so the fix pass's client half is pinned by `lib/checkoutFace.test.ts` (the decisions) and `lib/checkoutIntake.test.ts` (the call sites and the route's gate order) instead.
- **Plan.** §1 S5/S6, §2 batch 2 spec 06, §4 severity and evidence rules.

## 11. Change log

- 2026-09-15: first draft, authored 2026-09-15 against `9681bdcbff2435ef258224c52000e0f8d6089f5c` from the §5 probes (scratch Postgres, isolated dev server on 3206, 23 rejection cases + 6 idempotency probes); nothing fixed, no code, config, test or migration touched, no real payment attempted.
- 2026-09-15 (working tree): fix pass for R06-1…R06-10. New `lib/checkoutFace.ts` holds every client decision the four gates take — the tab-aware url sentence, the field shapes, the submit gate and the refusal mapper (including which 409s may quote a price) — with `lib/checkoutFace.test.ts` (20 cases) and `lib/checkoutIntake.test.ts` (16 cases, `readFileSync` assertions on the call sites and the route's gate order) over it, because the repo has no DOM suite (U06-1). `app/api/checkout/route.ts`: the idempotency lookup and `idempotentReplay()` moved ahead of the throttle, the replay answers with the create path's envelope kind, both 502s carry `paymentId`, and a malformed receipt address is a `400 field:"email"` through the new `isEmail` in `lib/validate.ts`. `components/Modals.tsx`: one attempt key per signature, cleared only once a checkout starts; the submit gate always renders; the refusal mapper, the tab-aware url line, the `co-email-error` node, the price-moved banner and the Turnstile failure wiring all read from `lib/checkoutFace.ts`. `components/TurnstileWidget.tsx`: `onLoadFail` plus its own visible sentence. `app/page.tsx`: the `?canceled=<sym>` reader. `lib/routes.test.ts`: the throttle case rewritten to spend the quota with new keys and then prove a replay still answers. Verification in §5.13 (typecheck, lint, 583 cases against a scratch Postgres; no DOM run, no real payment). No dependency, no migration, no schema change; the paused surface (§9 Q3) and the honeypot counter (§9 Q4) are deliberately untouched.

## 12. UNKNOWN log

| Id | Unknown | What settles it |
| --- | --- | --- |
| U06-1 | What the modal actually looks like and does on a phone — whether the on-screen keyboard covers `Continue to checkout`, and whether the four client-gate silent bails are noticeable in practice | A browser run at 360×640 and 390×844 with the keyboard raised, opening the stake modal, typing only a handle, and pressing Continue; then a DOM-level suite (`@testing-library/react` + jsdom) for the unit half — neither tool is in `package.json` today. **Half settled 2026-09-15:** the silent-bail half is no longer an unknown — the four gates are pure functions with 36 cases over them (§5.13), so an untouched form, a handle without `@` and a bad address all produce text by construction. The keyboard half still needs the browser |
| U06-2 | Whether a real visitor's Turnstile challenge ever fails in normal use on the production host (rate of `Bot check failed.`) | The production 400 rate for `/api/checkout` — provider console (Vercel logs) filtered on that response; client-side, a `turnstile` error-callback counter. **Still open**, and now two distinct states to count: the challenge that fails after loading, and the script that never loads (the widget's own sentence, §7 R06-6) |
| U06-3 | Whether `?canceled=Li` is reached by real buyers often enough to matter (its finding is a code fact either way) | Vercel request logs for `GET /?canceled=*` over a week of live payments, or a Stripe session list filtered on `cancel_url`. **Code half closed 2026-09-15:** the reader exists (§7 R06-8), so the log question now measures how often the notice is seen rather than whether the parameter is dead |
| U06-4 | Whether any password manager in the wild fills the `name="website"` honeypot for this form | A production counter on the honeypot branch (none exists) — the settling change is the counter, which is code, so this stays an operator call. Unchanged by the fix pass, which left the honeypot deliberately opaque (§9 Q4) |
