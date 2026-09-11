# Handoff — periodictable.lol prod launch

> Last updated: **2026-09-10** (verified against live prod at 12:45Z).
> The step-by-step checklist lives in `doc/PROD-READINESS-CHECKLIST.md` and is
> the authority for *how* to verify each item. This file is the *state of the
> world*: what is done, what is broken, what is next.
>
> Work continues on another PC: `git clone`, copy `.env` values from a safe
> place (never commit `.env`), `npm ci`.

---

## Read this first — what is still open

### 1. ✅ RESOLVED — fake demo claims removed from prod (2026-09-10)

Prod *was* showing **10 claimed elements, 12 stakes, $410 "staked"**, all of it
seed/demo data. `/api/stats` now returns:

```json
{ "elementsTotal": 122, "claimedElements": 0, "unclaimedElements": 122, "stakeCount": 0, "totalStakedUsd": 0 }
```

`/api/activity` returns `[]`, and `/api/elements/C` returns an empty `stakes`
list at `pool: 0` — the real `takeLead: 5` floor is no longer hidden behind a
$50 demo leader. The elements table and its 122 rows are untouched.

**What was actually there** (the table originally in this doc listed wrong
amounts — adyen was $24, not $31; squareup $9, not $18):

| Element | Leader shown | Amount |
| --- | --- | --- |
| C | `stripe.com` (adyen.com #2, squareup.com #3) | $50 |
| Au | `coinbase.com` | $88 |
| DM | `anthropic.com` | $66 |
| Pt | `coinbase.com` | $42 |
| U | `huggingface.co` | $39 |
| Si | `nvidia.com` | $34 |
| Fe | `supabase.com` | $21 |
| O | `cloudflare.com` | $15 |
| H | `cloudflare.com` | $12 |
| He | `cloudflare.com` | $10 |

**Corrections to the original write-up of this item** (it was wrong on both
counts that mattered):

- The data did **not** come from `mocks/startups.ts` (`MOCK_STAKES`, which is
  local demo only). The prod seeder is **`prisma/launch-seed.ts`** — its 12
  stakes match the live ladder exactly. It writes **9** domains, not 6, and 0 of
  them ever had an email, a `Payment`, or a manage token.
- A cleanup tool **did** exist: `launch-seed.ts --fresh` already implemented an
  FK-safe wipe. It is blanket, though — it clears `Report`/`EmailLog` too — so
  the scoped script below supersedes it.

**The tool that did it: `scripts/clear-demo-data.ts`**
(`npm run db:clear-demo`) — **dry run by default**; writing needs
`-- --apply --allow-remote`. It is provenance-guarded: a demo domain is only
deleted while it still looks exactly as the seed left it (no email, no payment,
no manage token/session, no operator moderation). Any deviation aborts the
**entire** run rather than half-deleting. It computes the dry-run plan by
executing the real statements inside a transaction and rolling back, so a dry
run also proves the delete ordering is FK-valid. Element aggregates are
recomputed through the shared `rankStakes`/`assertLedgerInvariants` path, never
ad hoc. `lib/demoData.test.ts` guards the domain allowlist against drift from
both seeder files.

Deleted 59 rows: `firstClaim` 10, `report` 2, `clickEvent` 5, `stake` 12,
`activityLog` 12, `outboxEvent` 9, `startup` 9. `Payment` and `WaitlistEntry`
were both empty — no real payment or signup was ever at risk.

⚠️ **Trap found while doing this, still live:**

**The local `.env` `DATABASE_URL` points at the production Neon database.**
Running `npm run seed` or `npm run db:migrate` from this laptop mutates prod.
Prefer `db:clear-demo`'s dry run as the pattern for anything touching data.

Backup taken immediately before the cleanup (verified complete, contains all 9
startups and 12 stakes): `prod-backup-20260910-213853.sql` in the session
artifacts folder.

### 2. 🟠 The 10-minute worker timer fires, but nowhere near every 10 minutes

`.github/workflows/outbox-tick.yml` is registered on `main`, `state:active`,
cron `*/10 * * * *`. The original version of this section said it had "never
once fired"; a later one recorded only 2 runs. Both are **stale**. As of
2026-09-11T05:09:52Z it has fired **6 `schedule` runs, all `success`**:

| fired (UTC) | gap from previous |
| --- | --- |
| `2026-09-10T14:39:33Z` | — |
| `2026-09-10T17:51:34Z` | 3 h 12 m |
| `2026-09-10T20:15:55Z` | 2 h 24 m |
| `2026-09-10T22:37:58Z` | 2 h 22 m |
| `2026-09-11T00:31:23Z` | 1 h 53 m |
| `2026-09-11T05:09:52Z` | 4 h 38 m |

**The timer is proven to work, and that is the part that was actually in
doubt.** In a 14 h 30 m window that should hold ~87 ticks, 6 landed — about
**7 %**. So do not design around the cadence; but do not treat it as dead
either. The 05:09 run's log confirms a *scheduled* run really does the job end
to end, not just start up:

```
{"ok":true,"claimed":0,"completed":0,"failed":0}     # /api/jobs/outbox
{"ok":true,"checked":0,"updated":0,"failed":0}       # /api/jobs/screenshot
```

`claimed:0` means the queue was empty, which is the expected steady state, not a
failure. Before this, only a **manual dispatch** had ever returned `ok:true` —
which proves auth but says nothing about whether the timer runs. Now a real
`schedule`-triggered run has authenticated to production and drained. GitHub's
scheduler is best-effort and de-prioritised, so a `*/10` expression on a
low-traffic repo will never hold cadence; ~2.4 h is what to expect.

**Not launch-blocking** because receipts and outbid mail are sent **inline** at
webhook time — the outbox is the *retry* path, and previews render nowhere in
v1. A late tick delays a retry; it never silences first-time mail. Worst case
observed is ~4 h 38 m of retry latency, with the daily `vercel.json` backstop
(04:00/04:30) as a floor. Adding the external pinger tightens that to 10 min;
skipping it is a defensible choice, not a risk.

**Fix (one dashboard action, user-side):** a free 10-minute pinger such as
cron-job.org. All four job paths accept a plain **GET** with header
`Authorization` set to a bearer token taken from the `CRON_SECRET` env var
(older pingers can use `?secret=<CRON_SECRET>` on the URL instead) and need no
body:

- `https://www.periodictable.lol/api/jobs/outbox`
- `https://www.periodictable.lol/api/jobs/screenshot`
- `https://www.periodictable.lol/api/jobs/config`
- `https://www.periodictable.lol/api/jobs/reconcile`

**Read the status code this way** (verified over real HTTP in production
semantics on 2026-09-11):

| code | meaning |
| --- | --- |
| `200` | authenticated **and** healthy |
| `401` | bad or absent secret — auth is checked *before* any health is computed, so an unauthenticated caller cannot learn which variables are missing |
| `503` | authenticated, but the check failed: a required production env var is missing/invalid (`config`), or a paid payment's stored provider figure contradicts the charge (`reconcile`) |

The reasoning that used to sit here — "a wrong secret returns 401, so a 200 is
real proof" — only ever proved *liveness*. It could not detect a real failure,
because both reports answered **200 with `ok: false` in the body**, and a
status-code-only pinger (cron-job.org's free tier fails a job on non-2xx only,
with no body/keyword inspection) can never read a body. A missing
`TURNSTILE_SECRET`, or a genuine money contradiction, would have left the pinger
green forever. Both routes now answer `503` in exactly those cases. The
advisory findings (`ADMIN_TOKEN`, Upstash) deliberately keep answering `200`:
they describe degradation worth reading, not paging, and a monitor that fired on
them every 10 minutes would be muted before the real failure ever arrived.

`vercel.json` carries only `crons` entries (daily 04:00 outbox, 04:30
screenshot). `config` and `reconcile` stay **out** of it — a Vercel cron's
response goes to a log nobody reads — but as of 2026-09-11 both are on the
**GitHub tick** (`.github/workflows/outbox-tick.yml`), which *does* alert: a
non-2xx fails a step, the run goes red, and GitHub notifies the owner. Nothing
called either route before that — no workflow, no `vercel.json` entry, no script,
only tests and docs — so the sole reader for a money contradiction was a URL
nobody requested. That makes the independent pinger no longer the *only* way to
cover them; it now buys **cadence** and nothing else. Expect the tick's `config`
step to be **red until `TURNSTILE_SECRET` is set** — that is a `required`
finding, so `503` is the correct answer, not a broken workflow. Both diagnostic
steps carry `if: !cancelled()` so neither can suppress the other, and neither is
skipped by a failure above them. That access model belongs in the reference
section next to the pinger.


### 3. ✅ `main` is green, and two real prod bugs were found and fixed today

- Post-merge run `34475469983` on `main` = **success**, `Tests 241 passed (241)`,
  **0 skipped**.
- **Preview pipeline was dead in prod, now fixed.** The screenshot worker probed
  `image.microlink.io` — a host with **no DNS record**. Every job failed, backed
  off and burned out at `attempts=5`. Rewrote it to use Microlink's JSON API,
  validate the returned host, and widened the CSP to `https://*.microlink.io`;
  `backfill` now **re-arms** burned-out rows. Proven with 4 dispatches
  (`checked 9 → 6 → 2 → 0`; 9/9 rows completed) and a live `200 image/png` fetch.
- **A takedown could be silently undone, now fixed.** The moderate route cleared
  `previewImgUrl` on HIDE, but the worker's write was unconditional and a probe
  takes ~7 s — so a job that started *before* a takedown landed *after* it and
  re-attached a preview to a HIDDEN listing. Now writes go through
  `attachPreview()` (guarded on `moderationState: "VISIBLE"`), plus the same
  guard in `scripts/backfill-previews.ts`, plus a regression test. This is what
  turned `main`'s CI red — the DB test had always passed *because* the pipeline
  was broken, so the bug was invisible until previews started working.

---

## Where things stand (verified live 2026-09-10)

**Done and proven**
- [x] Deployed on Vercel (`periodic-table`, auto-deploys `main`); main CI green
- [x] Neon Postgres connected — **122 elements live**
- [x] Custom domain live: `periodictable.lol` → 308 → `www.periodictable.lol`
- [x] Security headers + CSP live in prod (`next.config.mjs`, prod-only block)
- [x] All 6 read APIs 200 on the custom domain
- [x] Payments **safely paused**: `POST /api/checkout` → `403` (waitlist)
- [x] **Migrations baselined.** Prod's schema had been applied with `db push`, so
      `_prisma_migrations` did not exist and Prisma reported all 5 migrations as
      *unapplied* — the next `prisma migrate deploy` in a build would have replayed
      `0000_baseline` over live tables and failed. All 5 are now marked applied via
      `prisma migrate resolve --applied`, and `prisma migrate deploy` reports
      **`No pending migrations to apply.`** Migration files are authoritative again.
- [x] **Demo/seed listings cleared from prod** (§1) — 59 rows across 7 tables;
      `/api/stats` → 0 claimed, 0 stakes, $0; checked with
      `scripts/clear-demo-data.ts` (`npm run db:clear-demo`, dry run first)
- [x] Resend domain `periodictable.lol` verified (DNS via GoDaddy, mail rows intact)
- [x] Resend key **deleted + recreated** after a chat exposure; direct-API test
      delivered to an inbox (landed in Gmail *spam* — expected for a bare test
      from a fresh domain; real receipts carry proper content + one-click
      unsubscribe headers)
- [x] Job auth verified on prod: both `/api/jobs/*` → `401` unauthenticated,
      `{"ok":true,…}` with the bearer; `CRON_SECRET` matches GitHub ↔ Vercel
- [x] Preview/screenshot pipeline fixed and proven end to end (§3 above)
- [x] Takedown-vs-preview race fixed + regression test (§3 above)
- [x] `vercel.json` daily backstop (outbox 04:00, screenshot 04:30)
- [x] v1 product decision: **a listing is set at checkout and is final** (listing
      edits deferred to v2; nothing user-facing promises a manage flow)

**Known broken / unproven**
- [ ] 🟠 **GitHub cron is throttled to hours, not 10 min** (§2)
- [x] **Addressed 2026-09-10 (Stage 1): the guard was inert in two ways.**
      `requireProdEnv()` still has **zero runtime call sites** (only
      `lib/env.test.ts`), *and* `REQUIRED_PROD_ENV` (`lib/env.ts:37`) was **read by
      nothing** — `requireProdEnv` validated a second, hand-written list inside
      `getMissingProdEnv`. The two happened to agree, but the doc comment named
      `REQUIRED_PROD_ENV` as authoritative, so it was decorative and free to drift.
      It is now the single source: `getMissingProdEnv` derives from it,
      `PROD_ENV_REASONS` is a `Record<RequiredProdEnvKey, string>` (adding a var
      without a reason is a **compile error**), and `lib/env.test.ts` asserts the
      report's `required` findings equal the list exactly — so a second list
      cannot silently reappear.
- [x] **Correction — `ADMIN_TOKEN` unset is a lockout, not a leak.** `adminAuth`
      (`lib/jobs.ts`) fails **closed** with 403 even in dev ("a leaked dev database
      is never one missing header from mutation"). Its absence is an **operator
      availability** gap (no triage / outbox retry), not exposure.
- [ ] **Stage 2, deferred deliberately: actually *calling* `requireProdEnv()`.**
      The gaps are now *visible* via **`GET /api/jobs/config`** (bearer
      `CRON_SECRET`). The report answers **503** when a *required* var is
      missing and **200** when only the advisories are (`ADMIN_TOKEN`, Upstash),
      which are listed in the body either way. Counting advisories as failure —
      the behaviour until 2026-09-11 — would have turned every optional gap into
      a monitor that fires every 10 minutes and gets muted before the real
      failure arrives. Reporting stays **non-fatal to the public site**: a
      missing `WHOP_API_KEY` must not 500 public browsing, which needs none of
      the guard's nine vars. Wiring the guard into startup is all-or-nothing and
      would brick the public site over an operator-only gap.
- [x] **Fixed 2026-09-11:** the webhook **ignored money reversals**, and the
      handoff's summary of the amount handling was **backwards**. Refunds,
      chargebacks, and disputes matched neither `paid` nor `failed`, so they fell
      to the `!paid && !failed` branch and were recorded as `IGNORED` /
      `unrelated-event` with **HTTP 200** — the network handed the buyer's money
      back while the stake stayed on the board, in the pool, and on the tile
      face. Now: `whopPayloadReversal` classifies 7 statuses and 11 event types,
      is checked **before** the paid check, and `reversePayment`
      (`lib/settle.ts`) unwinds the stake under the same per-element advisory
      lock as settle, writes `Payment.status = REFUNDED` + `refundedAt`, logs the
      public `kind: "refund"` activity row with a negative delta, and audits
      `PAYMENT_REVERSED`. Redelivery cannot subtract twice (`providerEventId`
      dedupe), and a reversal that arrives while the payment is still `PENDING`
      closes it, so a late paid delivery cannot apply a stake for money that
      already went back. Amounts are deliberately **not** validated on this path:
      the unwind uses our own checkout-time `payment.amountUsd`, which is the
      only figure the ledger ever used — so a partial refund still unwinds the
      full charge it recorded (money must never leave paid-for inventory behind).
      Declining refunds is still published policy (`app/legal/[slug]/page.tsx`,
      `components/Modals.tsx`); this path exists because a chargeback is not a
      policy you can decline. 6 integration tests + a 12-case signal suite, all
      falsified by reverting the branch ordering.
- [x] **Fixed 2026-09-11:** a fully reversed stake kept **the crown and the
      price**. The zeroed row still sorted first, so a charged-back bidder kept
      `isLeader: true` on the tile face forever — and `takeLeadPrice(0)` returns
      **$1**, not the $5 floor, so an all-reversed element advertised a $1
      takeover. Rows can never be deleted (`ClickEvent.stakeId` is required, plus
      `FirstClaim`), so "not bidding" is now a **first-class ledger state**:
      **`amountUsd > 0` is the canonical eligibility rule**, applied in
      `rankStakes` (`lib/pricing.ts`) and mirrored in every reader — checkout
      (the authoritative price), element detail, the elements grid, search, OG
      images, the element page, and `Modals.tsx`. `assertLedgerInvariants` now
      requires **no** leader row *and* `currentLeaderId === null` when nothing
      live bids. Side effect worth knowing: a refunded bidder now counts as a
      newcomer again and pays the $5 first-join floor instead of a $1 top-up.
      A `PAID` payment with no stake row is a `ledger-invariant:` terminal error
      rather than a silent no-op. Regression coverage in `lib/pricing.test.ts`
      and `lib/webhook.test.ts`; both falsified.
- [ ] `UPSTASH_REDIS_REST_URL` / `_TOKEN` are **not** in `REQUIRED_PROD_ENV`, so
      even a wired-up `requireProdEnv()` would not catch the degraded rate
      limiter. `/api/jobs/config` does, as a `degraded` advisory.
- [x] **Fixed 2026-09-10:** `app/api/activity/route.ts` republished the `domain`
      and `city` of a HIDDEN listing — an identity leak that defeated the whole
      point of concealment. The feed now excludes hidden domains (resolved via
      `Startup.moderationState`; `ActivityLog` only stores a denormalized domain,
      no FK). `UNLISTED` is deliberately **kept** — it is still shown on tiles and
      element pages, so concealing it there would hide nothing. Regression coverage
      added to `lib/moderation.test.ts`, and confirmed to fail without the filter.
- [x] **Fixed 2026-09-10:** `app/elements/[sym]/page.tsx` printed
      `{stakeCount} stakers · ${totalPoolUsd} pool` directly above a table built
      from filtered stakes, contradicting itself. The table still excludes hidden
      rows, and a disclosure row now explains that the totals include them.
- [ ] `app/api/stats/route.ts` and `Element.stakeCount`/`totalPoolUsd` **still sum
      hidden money — this is deliberate policy, not a bug.** Three independent
      source comments say so (`lib/moderation.ts`, `app/api/elements/route.ts`,
      and the moderate route: "Financial history is NEVER touched"). Aggregates
      carry no identity; the feed did. Explicit decision this session: keep the
      money, hide the listing.
- [x] **Fixed 2026-09-10:** `app/api/checkout/route.ts` charged a
      hidden-**inclusive** take-lead price while `app/api/elements/[sym]/route.ts`
      displayed a hidden-**excluded** one. Buying at the advertised price was then
      classified as a mere join — no reservation, and the money did not buy the
      lead the page promised. Checkout now prices off the first non-HIDDEN stake,
      matching the display side. `existingTotals` (the no-tie guard) is
      deliberately left **complete** — a collision with a hidden row is still a
      collision in the ledger ranking. Regression coverage in
      `lib/moderation.test.ts` asserts the advertised price is the price that takes
      the lead, and was confirmed to fail without the fix.
- [x] **Fixed 2026-09-11:** `app/api/elements/route.ts` returns unfiltered
      `pool`/`count` beside a filtered `leader`. Previously recorded here as a
      "self-inconsistent tile" — **that consequence was wrong**, and the
      correction matters more than the fix. `leader` is filtered to
      `DIRECT_STATES` + `amountUsd > 0`, and it alone drives the tile face;
      `pool` is never read by any client, and `count`'s single consumer was
      `contested: t.count > 1` in `app/page.tsx` — while `.contested` had **zero
      readers repo-wide** (declared in `lib/api.ts` and `components/Tile.tsx`,
      assigned once, never read). Nothing on screen ever paired the two fields,
      so no tile was inconsistent. The real defect was latent: `contested` was
      derived from the hidden-**inclusive** `count`, so any future render of it —
      the obvious "contested" badge — would have made a tile with one visible
      leader advertise that a **concealed** stake existed, the same leak fixed in
      `app/api/activity/route.ts` on 2026-09-10. The dead plumbing is removed and
      the constraint recorded on the type and at the payload site. `pool`/`count`
      stay unfiltered and stay in the payload: that is the deliberate
      "aggregates keep the money" policy, pinned by
      `lib/moderation.test.ts` (`expect(tile?.pool).toBe(52)` with a HIDDEN stake
      inside the 52), so filtering them would contradict the policy and break a
      passing test. 303 passed (303), 21 files (2026-09-11).
- [ ] Turnstile keys not set — bot checks **silently pass** (`lib/abuse.ts`:
      `verifyTurnstile` returns `true` outright when `TURNSTILE_SECRET` is unset).
      Surfaced by `/api/jobs/config`; the only thing that would have caught it
      before was the never-called `requireProdEnv()`. It is a **`required`**
      finding, so as of 2026-09-11 that route answers **503** for it — putting a
      pinger on the URL (§2) is what converts a silent bot-check bypass into an
      alert, which is why the two changes shipped together.
- [ ] Upstash not set — rate limits are per-instance memory, bypassable on
      serverless (`lib/rateStore.ts` fails open: warns once, continues). Surfaced
      by `/api/jobs/config` as a `degraded` advisory.
- [x] **Fixed 2026-09-11:** `audit()` **swallowed its own failure inside a
      transaction** — and inside one that is not a non-blocking write. Postgres
      aborts the whole transaction on any failed statement, so the failure did
      not "continue anyway"; it surfaced on the *next* statement as **25P02**
      ("current transaction is aborted, commands ignored until end of transaction
      block"). 25P02 is neither retryable nor diagnosable, so a **retryable
      serialization conflict became a hard 500 for the buyer**, with the real
      cause hidden in a "non-blocking" log line. `audit()` now rethrows when
      handed a `tx` client and keeps the swallow only outside a transaction, so
      the transaction can be retried intact. Two tests in `lib/routes.test.ts`
      pin both halves (the in-transaction one asserts on the audit write's own
      `P2003`, and explicitly asserts the message is **not** 25P02).
- [ ] Whop contract **still guessed** (`lib/whop.ts`): endpoint shape, signature
      header, payment-id location, paid event types. Needs signed fixtures.
- [x] **Fixed 2026-09-11:** Webhook **does not trust** the amount it is told —
      this was previously listed backwards. Every money path uses our own
      checkout-time `payment.amountUsd`; the provider's figure only cross-checks
      it and is stored as audit metadata. The real gap was narrower: an
      **absent** provider amount was **indistinguishable from a verified one**,
      because `validateWhopMoney` returned `null` in both cases — so a charge
      nothing had cross-checked looked exactly like one that had been. It now
      returns a three-state `WhopMoneyCheck` (`ok` / `absent` / `rejected`) rather
      than `string | null`, and `absent` settles while recording the delivery as
      `amount-unverified:provider-stated-none`. `providerAmount` /
      `providerCurrency` are no longer write-only — see the reconciliation entry
      below.
- [x] **Fixed 2026-09-11:** **no reconciliation** of `providerAmount` vs
      `amountUsd` — both columns were written on every paid settle and read by
      nothing. **`GET /api/jobs/reconcile`** is now the reader. It reports
      `paidTotal`, a **`divergent`** count, and an advisory **`unverified`**
      count. `divergent` is a PAID payment whose stored provider figure
      contradicts the charge; it is impossible by construction, since the webhook
      rejects contradictions before settling — which is exactly why a hit must be
      loud: it means the acceptance rule, or a path that bypassed it, is wrong.
      `unverified` is a charge paid on our own checkout figure alone, disclosed
      rather than treated as a defect, because providers may legitimately state
      no amount. Two details are load-bearing: both questions are asked through
      the **same predicates the live webhook uses** (`providerAmountAgrees` /
      `providerCurrencyAgrees`, now exported from `lib/whop.ts`) — a second copy
      of the rule would bless a figure the webhook itself rejects — and the
      comparison runs in **TypeScript, not SQL**, because the first draft
      compared the enum column to `'PAID'` (the column holds `'paid'`) and would
      have failed every call. Read-only, `jobAuth`, echoes identifiers and
      amounts only, so it is safe to run from the pinger. It is deliberately
      **not** on a Vercel cron: a cron run produces a response nobody reads,
      which is why it belongs on the pinger's URL list instead. A divergent row
      is answered as **503**, because the status code is the only channel a
      status-code-only pinger can read — reporting the failure inside a 200 body
      made it undetectable (fixed 2026-09-11). The advisory `unverified` block
      keeps answering 200 on purpose, so the report cannot be muted before the
      divergent case ever fires. 5 integration tests in
      `lib/reconcile.test.ts` assert the status follows `ok`, not a fixed 200.
- [ ] **No `PENDING` expiry sweeper** (reservations self-expire, so none is
      needed yet). Money reversals are now handled — see the 2026-09-11 entries
      above. The `CANCELED` enum value is still never written (stale Phase 2
      comment).
- [x] **Fixed 2026-09-11** — Grid/stats failure honesty: a blocked API must show
      error panels, never a fake all-`Unclaimed $5` / zeros. The bug was wider
      than this line implied. With `/api/stats` down, `app/page.tsx` rendered
      "🧪 **0** elements live · 💰 **$0** in bids · **122** unclaimed" as plain
      fact — and `?? 122` was the sneakiest part, because it is *plausible*, so
      nothing looked broken. With `/api/elements` down, `tiles ?? []` left the
      `claims` map empty and every tile fell back to `claim?.price ?? 5`, i.e.
      the page advertised the entire periodic table as free. Both fixed by
      making the page distinguish *unknown* from *zero*:
      `lib/liveState.ts` maps `(hasData, error)` to
      `loading | ok | stale | unavailable`; `components/StatsCard.tsx` now takes
      `{ stats?, stale? }` and renders `—` until real numbers exist (no `= 0` /
      `= 122` defaults); `components/LiveDataNotice.tsx` draws a blocking panel
      in place of the grid when tiles are unavailable, and a "last known"
      marker when SWR is serving last-good data after a failed refresh. 10 tests
      in `lib/liveState.test.ts` cover the truth table, the copy contract, and
      three source pins that fail if `?? 0` / `?? 122` / `= 0` defaults return.
      Measured: **290 passed (290), 20 files** (was 280/19). Note this only bit
      on first load or hard failure — SWR retains last-good data on a refresh
      error, which is why `stale` is a separate state from `unavailable`.

      **Verified in a real browser**, not just by reading source — which was
      worth doing, because the first placement was wrong in a way no test here
      can catch. The marker was originally at `bottom-[18px] left-1/2`, which is
      exactly where `components/FooterBar.tsx` already sits at the same z-layer
      (`--z-cards: 40`); same z, later in DOM, so the legal links painted over
      the Retry button and swallowed its clicks. Overlap detection needs
      geometry, and this repo has no React/jsdom test infra, so it is invisible
      to the static-scan idiom. Moved to `bottom-[72px]`, which clears the 44px
      FABs (62px) on mobile and the footer (51px) on desktop; re-measured at
      1440×900 and 390×844 with the aborts armed. Method, if this needs redoing:
      `next dev` against the **local** test DB, then
      `agent-browser network route "**/api/elements*" --abort` (plus `/api/stats`)
      to force the failure — first load gives `unavailable`, and arming the
      aborts *after* a healthy load and waiting out the 30s refresh gives
      `stale`. Confirmed: blocked stats render `— / — / —` instead of
      `0 / $0 / 122`; blocked tiles replace 123 `$5 Unclaimed` tiles with the
      panel (the one remaining `$5` is the hero's "Claim an element · from $5",
      which is true regardless); Retry clears the warning once routes are
      removed.
- [x] A11y/mobile sweep + a real browser/axe E2E (today: static string tests only).
      Done against a real browser + axe-core 4.12.1 on `/`, `/s/[domain]`,
      `/elements/[sym]` (incl. all four exotic faces), `/legal/about`,
      `/legal/rules`, `/pay/[paymentId]`, at 1280px **and** 390px. Two real
      failures found and fixed: the `.lol` in the `/s/[domain]` wordmark pill
      (`text-sm` = 14px normal text, so the decorative `money` hue's 3.25:1 fails
      the 4.5:1 floor — now `text-moneyink`), and the dev pay simulator's `#999`
      muted text on white (2.84:1 — now `#666`). Both are pinned in
      `lib/a11y.test.ts`. Also verified by hand rather than waved off: the
      homepage pill is `text-[22px] font-bold` = large text, so its `money` hue is
      legal at the 3:1 floor; the four modal `text-money` headings are 20px/700 =
      large text at 3.25:1, legal; and axe's "background gradient" incompletes on
      `/s/[domain]` resolve to 10.14:1 (7.25:1 for white-on-navy) once measured
      against the gradient stops. Remaining incompletes are the `aria-hidden`
      decorative `bg-sym` watermarks — not real text.
- [ ] **`/pay/[paymentId]` renders its "DEV SIMULATOR" UI in production.** The
      *API* it calls (`POST /api/dev/pay`) is correctly 403'd whenever Whop is
      configured, so no payment can be settled from it — but the **page** has no
      guard (there is no `middleware.ts` at all), so anyone hitting
      `periodictable.lol/pay/anything` sees internal dev tooling and a checkout
      that cannot work. Found during the a11y sweep. Low severity (no data
      exposure), and the fix is a product/routing call rather than a one-liner —
      the page is `"use client"`, so gating on `getProviderMode()` needs either a
      server wrapper that calls `notFound()` or a new `middleware.ts`.
- [ ] `EMAIL_FROM` is `info@periodictable.lol`; the plan is `hi@…` — align when
      convenient (both work, same verified domain)
- [ ] Vercel dashboard Cron Jobs tab should list both daily jobs (visual check)

**Environment traps — do not lose time on these**
- **Local tests silently skip the DB suites.** Without a DB the gate in
  `lib/testDb.ts` skips them silently (`223 passed | 57 skipped`, measured
  2026-09-11). A green local run is **not** proof the integration path works —
  that is exactly how the takedown bug sat unnoticed in `main`. Let CI be the DB
  oracle. **You can be the oracle locally too**, and it is cheap: run a throwaway
  Postgres in Docker, then point tests at it without touching `.env` (which holds
  the prod Neon URL) —
  `docker run -d --name pt-test-pg -p 55432:5432 -e POSTGRES_USER=testu -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=pttest postgres:16-alpine`,
  then run `npx prisma migrate deploy`, then vitest, both with `TEST_DATABASE_URL`
  pointed at that container (standard `postgresql` URL scheme, user `testu`,
  password `testpw`, host `localhost`, port `55432`, db `pttest`). Spelled out
  rather than pasted because this file passes through a secret scrubber that
  redacts anything shaped like a credential-bearing URL — which is exactly how
  earlier edits to this doc got silently mangled. Measured that way on
  2026-09-11: **303 passed (303), 21 files, 0 skipped, ~7.5s** — older
  revisions of this doc carry stale counts (200/215/241/256/280); 303 is the
  current total, and the same suite without a DB reports `223 passed | 57
  skipped`, so **57 is the number of tests a DB-less green run is not
  exercising**. The suite now runs **test files serially**
  (`fileParallelism: false` in `vitest.config.ts`): every DB-backed file shares
  one database, and the outbox is a *single global queue* whose claim order is
  `nextAttemptAt` across all rows — in parallel, one file's worker or inline
  drain picks up another file's fixtures. That produced rare (~1 in 4 runs),
  load-dependent failures with nothing to do with the product, which is worse
  than a slow gate: a flaky gate is not a gate. Do **not** reach for
  `--maxWorkers` to speed it up; ~7.5s buys a suite that passed **13 consecutive
  times** (`0` outbox rows leaked across all 13). **One caveat, found while
  re-running it on 2026-09-11:** across 10 further runs, one failed *a single
  test* (`lib/routes.test.ts`, `prisma.startup.findMany`) with `Can't reach
  database server at localhost:55432`. That is a client-side TCP blip to the
  Docker-published port, **not** the fixture-stealing class above and not an
  assertion: the container stayed `Up` with `RestartCount 0`, and Postgres
  logged **no** refused or exhausted connection (`max_connections` 100, 6 in
  use, no `too many clients`). The identical command then passed 9 of 10 times,
  so **read a lone connection error as infrastructure and re-run before
  investigating**. If it ever does recur, the knob is a smaller test pool
  (`?connection_limit=1` on `TEST_DATABASE_URL`) — **not** re-enabling
  `fileParallelism`, which is what makes files steal each other's fixtures.
  `prisma migrate deploy`
  followed by `prisma migrate diff --from-schema-datasource … --to-schema-datamodel …`
  on that fresh DB returns "No difference detected", which independently proves
  the migration baseline is sound.
- **`npm run lint` is fast and clean on macOS** (`✔ No ESLint warnings or errors`,
  verified 2026-09-10). An earlier revision of this doc claimed lint *hangs* —
  that was a different machine (Windows, repo path containing a comma). Ignore it.
  Use `npm run typecheck` + `npm run test:ci` for a fast local gate.
- ⚠️ **The local `.env` `DATABASE_URL` points at the production Neon database.**
  `npm run seed` and `npm run db:migrate` run straight against prod from this
  laptop. Anything that writes rows should be dry-run-first and guarded the way
  `scripts/clear-demo-data.ts` is.
- **`migrate deploy` is now safe to run in a build** (baselined, §Done and proven).
  It also worked over Neon's **pooled** URL, so the usual `directUrl` advice for
  serverless is not currently required here — but the datasource still has no
  `directUrl`, so if a *future* migration ever fails on advisory locks, that is
  the first thing to add (`DIRECT_URL` + `directUrl = env("DIRECT_URL")`).
- **`package.json`'s `build` is only `next build`** — it does *not* run migrations.
  `prisma migrate deploy` exists as `db:deploy`. If the Vercel project's Build
  Command is an override (`prisma migrate deploy && next build`), it is a dashboard
  setting and invisible from this repo — check it before assuming either way.
- CI runs on `push` to `main` **and** `pull_request`. **The post-merge `push` run
  can fail even when the PR run passed** — always re-check `main` after merging.
- Secrets must never be pasted into chat. A Resend key leaked that way once and
  had to be rotated (delete → recreate → update Vercel → redeploy).

---

## What is next, in order

1. **The independent 10-min pinger is now optional** — decided 2026-09-11.
   Coverage is closed without it: `/api/jobs/config` and `/api/jobs/reconcile`
   are on the GitHub tick as of that date (which alerts), so the two diagnostics
   are no longer unwatched. What the pinger would still buy is **cadence**: the
   GitHub timer is proven to fire and authenticate (6 schedule runs, all green)
   but at ~7 % of the requested rate, gaps 1 h 53 m–4 h 38 m, so worst-case
   retry latency stays 4 h 38 m and the daily `vercel.json` backstop is the
   accepted floor.
   If you do set it up, all **four** job URLs go on the same list, bearer `CRON_SECRET`
   (or `?secret=<CRON_SECRET>` if the pinger cannot set headers): the two worker
   paths plus `/api/jobs/config` and `/api/jobs/reconcile`. Alert on **any
   non-2xx** — `200` now means authenticated *and* healthy. `config` names any
   missing required production env; `reconcile` names a paid payment whose
   stored provider figure contradicts the charge. Both used to report those
   failures inside a 200 body, which a status-code-only pinger cannot see
   (fixed 2026-09-11); the advisory findings they also carry still answer 200 on
   purpose, so the monitor is not muted before the real failure fires.
2. Then resume `doc/PROD-READINESS-CHECKLIST.md` in order:
   - §4b: Vercel Cron Jobs tab visual check; outbox lifecycle / `ADMIN_TOKEN` retry
   - §5: Turnstile, Upstash, `ADMIN_TOKEN`, **stats HIDDEN sums (deliberate — see
     above)**, honest error panels (code landed 2026-09-11 — the §5 pass is now a
     visual check of the blocked-API panels, not a build), board sorting, click
     salt
   - §4c: receipt / outbid / unsubscribe **hand tests with two real inboxes**
   - §6: hand journeys J1–J8
   - §7: GO / NO-GO
3. **LAST:** `PAYMENTS_LIVE=true` + `NEXT_PUBLIC_PAYMENTS_LIVE=true` + Whop live
   keys + webhook `https://www.periodictable.lol/api/webhooks/whop` registered →
   redeploy → $1 live claim → refund/keep → announce. The refund leg is no longer
   a manual no-op: a real provider reversal now unwinds the stake, so confirm
   four things at once — the stake is back to $0 / **no leader** (tile face
   clears, take-lead price returns to the $5 floor), a negative `refund` row
   appears in the activity feed, an audit row `PAYMENT_REVERSED` exists, and
   `Payment.status` is `REFUNDED` with `refundedAt` set. Migration `0005` must be
   applied by the Vercel Build Command before that test, or the reversal path
   writes to a column that does not exist.
4. Product decision to make explicitly: v1 currently **renders no previews**
   (nothing in `.tsx` reads `stake.preview`; only `Avatar.tsx` renders `logoUrl`).
   The pipeline works and the CSP allows it — decide whether v1 shows them.

---

## Reference

- Live: https://www.periodictable.lol · Vercel project: `periodic-table`
  (Build Command must include `prisma migrate deploy`)
- Git: `main` is the deploy branch. Recent: `28b2cd5` (#8) ← `e85859f` (#7) ←
  `048f3ca` (#6) ← `107d05d` (#5) ← `63b1914` (#4) ← `17e7177` (#3)
- Env vars (values in Vercel only, never in the repo): `DATABASE_URL`,
  `WHOP_API_KEY`, `WHOP_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL`,
  `RESEND_API_KEY`, `EMAIL_FROM`, `CLICK_SALT`, `TURNSTILE_SECRET`,
  `NEXT_PUBLIC_TURNSTILE_SITEKEY`, `CRON_SECRET`, `PAYMENTS_LIVE`,
  `NEXT_PUBLIC_PAYMENTS_LIVE`, `ADMIN_TOKEN`, `UPSTASH_REDIS_REST_URL`,
  `UPSTASH_REDIS_REST_TOKEN`, `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` (optional)
- Money smoke tests:
  - `BASE_URL=https://www.periodictable.lol bash scripts/rehearse-release.sh paused`
  - `BASE_URL=http://localhost:3100 ADMIN_TOKEN=… WHOP_WEBHOOK_SECRET=… bash scripts/rehearse-release.sh live`
- Full local gate: `npm ci` → `prisma migrate deploy` (local DB) → `npm run lint` →
  `npm run typecheck` → `TEST_DATABASE_URL=… npm run test:ci` (must be 0 skipped) →
  `npm run audit:prod` → prod-env gate fail-without / pass-with secrets
- Prod data check: `curl -s https://www.periodictable.lol/api/stats`
- Registrar: GoDaddy. `A @ → 216.198.79.1` (Vercel-assigned),
  `CNAME www → periodictable.lol.`. **Mail rows (`MX`, `email`,
  `secureserver` DKIM) belong to GoDaddy mail — do not touch.**
  Resend and GoDaddy mail coexist (different DKIM/SPF hostnames, no conflict).