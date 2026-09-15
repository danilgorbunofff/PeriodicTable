# 06 — Checkout before payment

| Field | Value |
| --- | --- |
| Phase · batch | 06 · 2 |
| Status | draft |
| Date reviewed | 2026-09-15 |
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

## 7. Findings

### R06-1 — An untouched or handle-only form submits nothing, silently

- **Severity.** P1
- **Category.** ux
- **Evidence.** `components/Modals.tsx:228` — `if (badUrl || badEmail || badTitle || badPitch || !domain || !attest || clientErr || submitting) return;` — the early return has no message and the submit button's only gate is `disabled={submitting || !attest}` (`:485`). The form is `noValidate` (`:330`), so the browser's own `required` messages never fire either. `badUrl` is false for an empty field (`:146`, `url.length > 0 && …`), and `domain` is null until a `://` URL or an `@`-prefixed handle is present (`:150-157`), so **the two most common first clicks** — empty form, or a social handle typed without `@` — produce no request and no text at all.
- **Reproduction.** Open the stake modal on any element, type `yourhandle`, tick the checkbox, press Continue. Nothing happens: no request in the network tab, no message, no focus move. Same with an untouched form.
- **Proposed fix.** Give the early return a reason: compute the failing gate and `setServerField`/`setClientErr` with the same sentence the server would send (`Enter a full URL starting with https://`, `Enter a valid @handle …`), or drop `!domain` from the guard and let the server answer 400 `field:"url"` (it already does, case 06/07). Test: a DOM-level test that a click with `url === ""` renders a message; `lib/checkoutFace.test.ts` would be the natural home, and no such suite exists today (U06-1).
- **Status.** open

### R06-2 — The retry of a payment the buyer already owns is quota-gated

- **Severity.** P2
- **Category.** money
- **Evidence.** `app/api/checkout/route.ts:116-119` (limiter) precedes `:175-176` (key lookup); probe §5.5 — 5 attempts from one IP exhaust the hour, after which a replay of a **paid** key is answered 429 with `Too many checkout attempts. Try again later.`.
- **Reproduction.** Submit three valid checkouts and two rejected ones from one IP, pay one of them, then replay the paid key: 429. The buyer is told to try later and shown no link to the session they already paid for.
- **Proposed fix.** Evaluate the idempotency lookup before the limiter (a replay writes nothing, so it needs no quota), or exempt a request whose key already resolves to a row. Test: a case in the checkout suite asserting that a replay of a stored key succeeds after the quota is spent.
- **Status.** open

### R06-3 — Two different 409s are both announced as "Price moved"

- **Severity.** P3
- **Category.** ux
- **Evidence.** `components/Modals.tsx:267-269` branches on `res.status === 409 && typeof json.takeLead === "number"` alone. The server sends exactly that shape for a floor violation (`route.ts` classify → `BELOW_FLOOR` + `takeLead`, probe case 03) and for a tie (`TIE` + `takeLead`, probe case 16). So a newcomer who typed $4 is told **"Price moved to $5 — continue?"** — nothing moved, $5 was always the floor — and a rival who typed exactly $12 is told the price moved when they simply hit a tie.
- **Reproduction.** On a free element send `amountUsd: 4`; on a $12 leader send `amountUsd: 12`. Identical banner, different causes.
- **Proposed fix.** Branch on `json.code`: keep "Price moved" for `PRICE_MOVED`, use the server's sentence alone for `BELOW_FLOOR` and `TIE`, and only offer `Use $N` when the new figure is genuinely the quote. Test: two client cases pinning the banner text per code.
- **Status.** open

### R06-4 — The server's attestation rejection is stored where nothing renders it

- **Severity.** P3
- **Category.** ux
- **Evidence.** `app/api/checkout/route.ts:130-132` returns `field:"attest"`; `components/Modals.tsx:273-276` stores it as `serverField` with `serverErr` null; the four renderers test only `field === "url" | "title" | "pitch"` and the email input tests `badEmail` (`:356,371,390,410`). No branch tests `"attest"`, so the message is **set and never displayed** — the buyer sees only the toast, which disappears.
- **Reproduction.** Direct API call with `attest:false` shows the response; the modal path is unreachable from the shipped UI because the button is disabled, so this is a latent-contract bug rather than a live dead end: enabling the button, or a future caller sending `attest` as a string (`attestValid` accepts both), produces a message nobody shows.
- **Proposed fix.** Render any unmatched `serverField` as a generic `serverErr`, which is the one branch that cannot fall through. Test: a case that a `field:"attest"` response produces visible text.
- **Status.** open

### R06-5 — A social-handle rejection is printed under the Product URL label

- **Severity.** P3
- **Category.** ux
- **Evidence.** `lib/validate.ts:87-123` returns `field:"url"` for both the product-URL branch and the handle branch (`:101-110`); the modal's error node for `field:"url"` is the one under `Product URL` (`Modals.tsx:340-362`), whose label is chosen by `tab` (`:341`) but whose message is fixed client-side to `Enter a full URL starting with https://` when `badUrl` is true (`:358`) — so a visitor on the **@ Social** tab who types `@a` is told to enter a full URL.
- **Reproduction.** Switch to @ Social, type `@a`, press Continue → `Enter a valid @handle (letters, numbers, dots, underscores).` renders under the label "Social handle" (correct) — but the *client* gate fires first for other handle shapes and prints the URL sentence under the same label.
- **Proposed fix.** Make the client's fallback sentence depend on `tab`, and keep the server's sentence authoritative. Test: one case per tab.
- **Status.** open

### R06-6 — A blocked challenge script or an autofilled honeypot gives one opaque sentence

- **Severity.** P3
- **Category.** ux
- **Evidence.** `components/TurnstileWidget.tsx:76-83` — if `api.js` fails to load the widget calls `onToken(null)` and **renders nothing**; the server then rejects with `Bot check failed. Try again.` (probe cases 19-20). The honeypot field is `name="website"` (`Modals.tsx:461-469`) — the classic password-manager autofill target — and its rejection is the deliberately opaque `Something went wrong. Try again.` (`route.ts:127-129`, probe case 13).
- **Reproduction.** Block `challenges.cloudflare.com` in the browser and submit; or let a manager fill the hidden `website` input.
- **Proposed fix.** Surface the two states differently *to the buyer* while keeping them opaque to bots: when the widget never loaded (a flag the widget can raise), show "The human check could not load — reload or use another network." Keep the opaque 400. Test: a client case for the widget-failure branch; the honeypot stays deliberately indistinguishable and is worth a counter instead of a message.
- **Status.** open

### R06-7 — A provider failure leaves a `Payment` row the buyer cannot reach

- **Severity.** P2
- **Category.** money
- **Evidence.** Probe §5.6 — 502 `Payment provider unavailable. Try again.` with the `Payment` row already written (`route.ts:287-300` precedes `resumeCheckoutUrl` at `:363-366`); the key is minted per submit and lives only in that request (`Modals.tsx:250-253`), and the success path leaves the modal by full page load (`:284`). §5.7 — an abandoned attempt is indistinguishable from a rejected one from the outside.
- **Reproduction.** Stripe mode, unreachable provider: POST once, then POST again with a fresh key. Two `pending` rows, one element, no URL the buyer can use, no mail.
- **Proposed fix.** Answer the 502 with the `paymentId` (and a resume endpoint or a `?resume=<id>` link) so an interrupted buyer can re-enter the same row; and give abandoned `pending` rows a sweep (`08` §6 owns the row-shape story, `13` owns the cron). Test: a case asserting the 502 body carries the id and that a second POST with it resumes rather than inserts.
- **Status.** open

### R06-8 — The Stripe cancel URL is written and read by nothing

- **Severity.** P2
- **Category.** money
- **Evidence.** `app/api/checkout/route.ts:66` sets `cancelUrl: ${origin}/?canceled=${element.symbol}`; §5.8 — no reader exists anywhere in `app/`, `components/` or `lib/`; `app/page.tsx:100-161` handles every other deep link and then replaces the URL state.
- **Reproduction.** Pay nothing and cancel at the provider: the buyer lands on the board with no acknowledgement of the element, the amount or the reserved hold; their `Payment` row stays `pending` and, on a TAKE, the element keeps refusing rivals for up to 15 minutes on their behalf.
- **Proposed fix.** Handle `?canceled`: re-open the checkout modal for that symbol with a short "Not paid — your quote is still held for N minutes" line (the reservation's `expiresAt` is in the DB, not the URL, so the copy must be conservative), or at minimum clear the parameter and explain that nothing was charged. Test: a page-level case that `?canceled=Li` opens the modal or shows the notice.
- **Status.** open

### R06-9 — Concurrent submits answer one payment with two different bodies

- **Severity.** P3
- **Category.** correctness
- **Evidence.** Probe §5.4 — two identical concurrent POSTs: both 200, same `paymentId`, but the winner's body carries `provider` and `reservation.guaranteedTake` while the loser's is the `idempotentReplay` shape (`route.ts:88-104`) without either. The contract (and `11`) cannot say what a duplicate submit returns.
- **Reproduction.** Fire two identical requests in parallel; diff the two bodies.
- **Proposed fix.** Have the replay path return the same envelope as the create path (it can read the reservation it just lost the race for), or document the duplicate shape as the contract. Test: a concurrency case asserting the two bodies are byte-identical.
- **Status.** open

### R06-10 — Any string containing `@` is accepted as the receipt address

- **Severity.** P3
- **Category.** data
- **Evidence.** `app/api/checkout/route.ts:147` — `typeof body.email === "string" && body.email.includes("@") ? body.email.trim() : null`. The client's regex (`Modals.tsx:147,205`) is the only real check, and direct callers bypass it; the address is stored on `Startup.email`/`Payment.email` and is what `lib/email.ts` sends receipts and outbid notices to (`10` §5.3).
- **Reproduction.** `POST /api/checkout` with `email: "@"` → 200 and a row whose `email` is `"@"`.
- **Proposed fix.** Reuse one address validator server-side (the regex already in the modal, or a shared `isEmail`) and reject with `field:"email"`. Test: a case per malformed address.
- **Status.** open

## 8. Acceptance criteria

- [ ] Every rejection a buyer can cause is visible: no submit path returns without text (§7 R06-1; needs a DOM-level suite — none exists, U06-1)
- [ ] A 409 is announced as what it is — a floor, a tie or a moved price (§7 R06-3)
- [ ] A retry after an interruption reaches the payment the buyer already has, and the 502 body carries its id (§7 R06-2, R06-7)
- [ ] Cancelling at the provider produces an acknowledgement on the board (§7 R06-8)
- [ ] Field-scoped server messages always have a renderer; `field:"attest"` cannot vanish (§7 R06-4)
- [x] The domain, not the client's `startup.domain`, is the identity (`route.ts:157-163`; probe case 05/06/07 show the server rejecting what the client would have sent)
- [x] One key, one `Payment` row, one provider session under concurrent submits (§5.4; Stripe `Idempotency-Key` at `lib/stripe.ts:59+`)
- [x] Turnstile fails closed when enabled and is skipped only when unset (`lib/abuse.ts`; §5.11)
- [x] The paused flag is enforced server-side first (`route.ts:109-111`; §5.1 case 22) — the HTML copy gap is §5.9, and `05` §9 Q2 does not cover it
- [x] A provider failure never hands out a dead dev URL for a live payment (`route.ts:39-74,363-366`; probe case 23)

## 9. Open questions

1. Should a first claim below $5 quote the floor as a *price* (today's "Price moved to $5") or state the rule ("First stake is $5+")? *Recommendation: state the rule; the current copy implies the board moved when it did not (§7 R06-3).*
2. Should the checkout form keep a durable key per (browser, element, domain) so an interrupted attempt resumes instead of forking a row? That is a product decision about how much state a browser may hold, not a bug; today the answer is "none" (§7 R06-7).
3. Is the paused surface allowed to be client-only (§5.9)? A crawler or a JS-less visitor is shown a purchasable board that no submit can complete. *Recommendation: render the paused copy server-side when the flag is off — it is one `paymentsLiveServer()` call in the page.*
4. Should a honeypot trip be counted (an audit row or a metric) even though the buyer must not be told? Today nothing records it, so an autofill false positive is invisible to the operator (§7 R06-6).

## 10. Cross-references

- **Settled and cited, not re-reported.** `05` §7 R05-1/R05-4 (one error node per id, red-700) — the modal's error nodes are the fixed shape; `05` §7 R05-8 (`/pay/[paymentId]` is a provider-mode gate with the simulator in `PaySimulator.tsx`) — the modal footer's "🔒 Secure payment via Stripe" sentence (`Modals.tsx:501`) is the same copy class and is **not** re-opened here; `04` §7 R04-1/R04-2 (`lib/stakeQuote.ts`, `prices.boardComplete`, `validateTake` on TAKE) — this doc prices nothing of its own; `05` §7 R05-7 (report and waitlist intake send mail) — `10` verifies that chain.
- **Neighbours.** `07` owns everything after `checkoutUrl` is handed out (the mode table, the simulator reach, the 502's provider half). `08` owns what happens to the `pending` rows this doc leaves behind. `10` owns the address `R06-10` lets through. `11` owns the response shape `R06-9` shows diverging. `13` owns the sweeper `R06-7` asks for. `14` owns the abuse posture of the intake.
- **Tests that already pin this surface.** `lib/routes.test.ts` (DB-gated checkout cases), `lib/pricing.test.ts`, `lib/stakeQuote.test.ts`, `lib/abuse` cases; the modal itself has no suite (U06-1).
- **Plan.** §1 S5/S6, §2 batch 2 spec 06, §4 severity and evidence rules.

## 11. Change log

- 2026-09-15: first draft, authored 2026-09-15 against `9681bdcbff2435ef258224c52000e0f8d6089f5c` from the §5 probes (scratch Postgres, isolated dev server on 3206, 23 rejection cases + 6 idempotency probes); nothing fixed, no code, config, test or migration touched, no real payment attempted.

## 12. UNKNOWN log

| Id | Unknown | What settles it |
| --- | --- | --- |
| U06-1 | What the modal actually looks like and does on a phone — whether the on-screen keyboard covers `Continue to checkout`, and whether the four client-gate silent bails are noticeable in practice | A browser run at 360×640 and 390×844 with the keyboard raised, opening the stake modal, typing only a handle, and pressing Continue; then a DOM-level suite (`@testing-library/react` + jsdom) for the unit half — neither tool is in `package.json` today |
| U06-2 | Whether a real visitor's Turnstile challenge ever fails in normal use on the production host (rate of `Bot check failed.`) | The production 400 rate for `/api/checkout` — provider console (Vercel logs) filtered on that response; client-side, a `turnstile` error-callback counter |
| U06-3 | Whether `?canceled=Li` is reached by real buyers often enough to matter (its finding is a code fact either way) | Vercel request logs for `GET /?canceled=*` over a week of live payments, or a Stripe session list filtered on `cancel_url` |
| U06-4 | Whether any password manager in the wild fills the `name="website"` honeypot for this form | A production counter on the honeypot branch (none exists) — the settling change is the counter, which is code, so this stays an operator call |
