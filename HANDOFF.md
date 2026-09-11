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
once fired" — that is **stale**. It has fired: exactly **2 `schedule` runs**,
both `success`:

- `2026-09-10T14:39:33Z`
- `2026-09-10T17:51:34Z`

But that is **3 h 12 m apart**. In a window that should hold ~20 ticks, 2
landed. The timer is not dead — it is throttled into uselessness, which is
normal for GitHub scheduled workflows (best-effort, de-prioritised; a `*/10`
expression on a low-traffic repo will never hold cadence). Do not design around
it.

**Not launch-blocking** because receipts and outbid mail are sent **inline** at
webhook time — the outbox is the *retry* path, and previews render nowhere in
v1. A late tick delays a retry; it never silences first-time mail. Treat the
in-repo cron as the fallback and the external pinger as the real schedule.

**Fix (one dashboard action, user-side):** a free 10-minute pinger such as
cron-job.org. Verified ready for it — both paths accept a plain **GET** with
header `Authorization` set to a bearer token taken from the `CRON_SECRET`
env var, and need no body; a deliberately wrong secret returns **401 on
both**, so a 200 is real proof:

- `https://www.periodictable.lol/api/jobs/outbox`
- `https://www.periodictable.lol/api/jobs/screenshot`

`vercel.json` carries only `crons` entries (daily 04:00 outbox, 04:30
screenshot); that access model belongs in the reference section next to the
pinger.


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
      `CRON_SECRET`), reported **non-fatally** — a missing `WHOP_API_KEY` must not
      500 public browsing, which needs none of the guard's nine vars. Wiring the
      guard into startup is all-or-nothing and would brick the public site over an
      operator-only gap.
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
      passing test. 280 passed (280), 19 files.
- [ ] Turnstile keys not set — bot checks **silently pass** (`lib/abuse.ts`:
      `verifyTurnstile` returns `true` outright when `TURNSTILE_SECRET` is unset).
      Surfaced by `/api/jobs/config`; the only thing that would have caught it
      before was the never-called `requireProdEnv()`.
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
      **not** on a Vercel cron: a cron run produces a response nobody reads, and
      `ok: false` is a signal for a monitor to alert on. 5 integration tests in
      `lib/reconcile.test.ts`.
- [ ] **No `PENDING` expiry sweeper** (reservations self-expire, so none is
      needed yet). Money reversals are now handled — see the 2026-09-11 entries
      above. The `CANCELED` enum value is still never written (stale Phase 2
      comment).
- [ ] Grid/stats failure honesty: a blocked API must show error panels, never a
      fake all-`Unclaimed $5` / zeros
- [ ] A11y/mobile sweep + a real browser/axe E2E (today: static string tests only)
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
  2026-09-11: **280 passed (280), 19 files, 0 skipped, ~3.2s** — three different
  counts appear in older revisions of this doc (200/215/241/256); 280 is the
  current total, and the same suite without a DB reports `223 passed | 57
  skipped`, so **57 is the number of tests a DB-less green run is not
  exercising**. `prisma migrate deploy`
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

1. **Set up the independent 10-min pinger** (§2) — or accept the daily backstop.
   **Add `/api/jobs/config` and `/api/jobs/reconcile` to the same URL list**
   (bearer `CRON_SECRET`): both reports are only worth having if something calls
   them. `reconcile` answers `ok: false` when a paid payment's stored provider
   figure contradicts the charge, so alert on that — and on a non-2xx from
   either path.
2. Then resume `doc/PROD-READINESS-CHECKLIST.md` in order:
   - §4b: Vercel Cron Jobs tab visual check; outbox lifecycle / `ADMIN_TOKEN` retry
   - §5: Turnstile, Upstash, `ADMIN_TOKEN`, **stats HIDDEN sums (deliberate — see
     above)**, honest error panels, board sorting, click salt
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