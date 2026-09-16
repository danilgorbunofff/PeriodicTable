# 15 — Performance, concurrency and cost

| Field | Value |
| --- | --- |
| Batch | 3 — the platform underneath |
| Doc | 15 of 15 |
| Status | draft |
| Date reviewed | 2026-09-15 |
| Commit reviewed | `9681bdcbff2435ef258224c52000e0f8d6089f5c` |
| Reviewer | review agent (batch 3) |
| Depends on | `01`–`05` (batch 1), `11`–`14` (this batch) |
| Owns | the fourth axis of launch readiness: what the product weighs, what it waits for, what it does under contention, and what it costs |

## Probe not run

| Probe not run | Why | Residue |
| --- | --- | --- |
| Field CWV — LCP / INP / CLS on a real cold 4G handset, `/` and one element page | Needs CrUX, Vercel Speed Insights or WebPageTest access, and moving CrUX needs real traffic on a production origin I must not add load to. No field data is reachable from this checkout. | The byte budget of a cold first load and localhost wall-clock, both measured (§5.1, §5.2) and the 4G arithmetic is labelled as arithmetic, not measurement. **U15-1** |
| A Lighthouse run, local or against the origin | Lighthouse was not installed and the origin is off-limits for scripted load; the numbers this doc reports are transfer sizes and wall-clock, never a Lighthouse score. | Nothing in this doc is presented as a Lighthouse or CWV score. Settling command below. |
| Load beyond ~13 concurrent requests | A load generator against production is load I must not generate; the matrix here is 8-way and 13-way against my own machine, which has one Postgres container and one Node process. | The contention shape (who wins, who is told, what the losers look like) is measured; the *ceiling* is arithmetic on top of it (§5.13). **U15-2** |
| Stripe 5xx / timeout / rate-limit injection | No *valid* Stripe credential exists in this checkout (`.env` does not exist; §4), so the provider can only be observed by making it reject this process. A transient Stripe 5xx or a socket timeout cannot be produced from here without a real account. | Two provider branches *are* measured: unconfigured → `403 {"error":"Payments are paused"}` (§5.10), and configured-with-fabricated-credentials → Stripe's own rejection surfaced as `502 {"error":"Payment provider unavailable. Try again."}` in 805 ms cold / 104–128 ms warm (§5.10, §5.11). A *slow* or briefly-5xx provider is not measured. **U15-4** |
| Resend 5xx / timeout injection | Same — `RESEND_API_KEY` is unset, so every send takes `lib/email.ts`'s "logged" branch. | The outbox's claim/backoff behaviour is `13`'s; what is missing here is what a *slow* Resend does to a 30 s function. **U15-5** |
| Neon's specifics: pooled-connection ceiling, region latency, PITR | Needs the production `DATABASE_URL`, which is a sensitive Vercel variable whose value pulls back empty (`doc/PROD-READINESS-CHECKLIST.md:196,436`). A local Docker Postgres measures Prisma, not Neon. | Query shapes and their row counts are measured locally (§5.5); Neon's latency and ceiling are not. `12` §5.14 owns the pooling facts and the restore drill. **U15-3** |
| Real spend: Vercel / Neon / Resend / Upstash invoice readings | No account access. §5.12 is therefore a model with stated unit prices, not a bill. | **U15-6** |
| Animation cost of `TableCamera` on the 122-tile grid | Needs a profiler against a real device; the animation is CSS/transform work in one client component and its cost is device-bound. | `components/TableCamera.tsx` is read, not profiled. **U15-7** |

Settling commands for the first three rows: `npx lighthouse https://www.periodictable.lol/ --preset=desktop --output=json --output-path=./lh.json` (or the PageSpeed Insights API for the same URL) for a lab score; the CrUX dashboard or `https://developer.chrome.com/docs/crux/` `record` query for field data; and `k6 run` / `artillery` against a staging deployment with production-shaped data, not the live origin, for the ceiling.

## 1. Scope

**Owns.** The fourth axis of launch readiness, end to end:

- What a cold reader transfers for `/` and for one element page, and what is in those bytes (§5.1, §5.4).
- What those pages and every data surface behind them *ask the database for* — the query shapes of `/api/board` (three tabs), `/api/stats`, `/api/activity`, `/api/elements/[sym]`, `/api/table-order` and the two page routes, with the row counts each shape reads (§5.5, §5.6).
- The cache policy on every read surface and the staleness it buys a viewer (§5.3, §5.7).
- The money path's behaviour under concurrency on a single element — eight simultaneous checkouts, thirteen simultaneous settlements (§5.8, §5.9).
- What the product does when a dependency is unavailable, measured by taking the database away (§5.10).
- Whether the worst case of a settlement invocation fits the platform ceiling it runs under (§5.11).
- The cost model at 10, 100 and 1000 checkouts per day, and a stated launch-day ceiling (§5.12, §5.13).

**Does not own.**

- Whether an index backs the access path a query asks for. This doc reports the *shape and row count* of each read; `12` §5.4 and §5.14 own index-versus-query-pattern and the unconfigured pool (`12` R12-5).
- Job scheduling, run bounds, leases and timeouts: `13` owns those, including R13-4 (the workers' worst case equals their `maxDuration` exactly). §5.11 here deliberately covers the *webhook*, which is not a job.
- Settlement, ledger and idempotency semantics: `08` (batch 2) owns them. This doc times that path and states its arithmetic against `maxDuration`; when a finding is really settlement behaviour it says so and points at `08`.
- Checkout UX and its state machine (`06`), the provider integration itself (`07`), and mail content (`10`; the report/waitlist chain is batch 1's, `05` §7 R05-7).
- Field CWV. Stated again because it is the one thing the plan asks for that cannot be delivered from here: §5.1 and §5.2 are transfer weight and wall-clock, §5.2's 4G column is arithmetic, and **U15-1** is the missing measurement.

**Scope correction to the plan.** The plan's §2 line for this doc says "one element page with 122 tiles and camera animations". Three corrections, all verifiable:

1. **122 is the element inventory, not a tile count.** `app/elements/[sym]/page.tsx:12-14` builds static params from `ELEMENTS`, and production `/api/stats` answers `{"elementsTotal":122,…}` (`11` §5.15). The grid that draws them is `components/PeriodicGrid.tsx`; the camera is `components/TableCamera.tsx`. This doc counts neither DOM nodes nor frames, because that needs a browser profiler (**U15-7**).
2. **The element page is not the page with 122 tiles that a reader waits for.** The *home* page is the one that renders the full table (`app/page.tsx` imports `PeriodicGrid` and `TableCamera`), while an element page renders one element plus the grid. §5.1 therefore measures `/` and `/elements/Ts` — the two cold loads a launch-day visitor takes.
3. **"CWV" is not measurable from here**, per the probe table. What replaces it is a byte budget, a localhost time, and a stated launch-day ceiling.

**Paths inspected.** `app/page.tsx`, `app/layout.tsx`, `app/elements/[sym]/page.tsx`, `app/s/[domain]/page.tsx`, `app/sitemap.ts`, `app/og/[sym]/route.tsx`, `app/api/{board,stats,activity,table-order,elements/[sym]}/route.ts`, `app/api/checkout/route.ts`, `app/api/webhooks/stripe/route.ts`, `lib/{prisma,route,recompute,txn,settle,money,screenshots,email,outbox,flags}.ts`, `vercel.json`, `next.config.mjs`, and the emitted build (`.next/`) of `npx next build` at the commit above.

## 2. Actors

| Actor | What they want | What the platform shows them when it is slow or broken |
| --- | --- | --- |
| **The cold 4G reader** — first visit from a phone, browser cache empty | the table, fast enough to keep scrolling | a prerendered shell the edge already holds (§5.3), then three client fetches for live numbers (§5.4); the shell is the LCP candidate and it does not wait on the database |
| **The returning reader** | the same board, one navigation later | `max-age=0, must-revalidate` on the document, so every navigation is a revalidation; the edge's 10 s window (not the browser's) is what absorbs the reads (§5.3, R15-1) |
| **The buyer mid-checkout** | a price, a hold, a receipt | `/api/checkout` is the only money-path route that can cold-start on their first request (§5.8, R15-6); under contention on one element the loser is told the truth (`409` taken / `429` too many) and the winner is told `200 paid` (§5.8, §5.9) |
| **The crowd on one element** (launch's one interesting element) | to take the lead | serializable transactions with up to 10 attempts (`lib/txn.ts`); 13 simultaneous settlements on one element all returned `200` (R15-7), and the outcome is `409`/`429` for the ones that cannot win — measured, `11` §5.6 and `14` §5.11 |
| **The operator** | to know what it costs and when it is degraded | nothing: no spend telemetry, no alarm, and every data-backed read answers a **500 with a zero-byte body** when the database is gone (§5.10, R15-3, R15-10) |
| **The platform** (Vercel edge + functions, Neon, Stripe, Resend, Upstash) | to serve, bill, and fail independently | the edge absorbs documents and read APIs (`X-Vercel-Cache: HIT`, `Age` in the thousands); the functions carry the writes; Upstash is unwired and `13`/`14` own that consequence |

## 3. Intended behaviour

As the code and the deployment describe it, in the order a reader meets it:

1. **The document does not wait for data.** `/` is prerendered — `app/page.tsx` has no `export const revalidate` and no `force-dynamic` — and its live numbers arrive as three client fetches (`/api/stats`, `/api/board`, `/api/activity`) with SWR, on the 30 s polling cadence that batch 1 accepted as a risk (`05` §9 Q2).
2. **Element pages are static with a 60 s window.** `app/elements/[sym]/page.tsx:10` — `export const revalidate = 60`, with `dynamicParams = true` for symbols not in the inventory.
3. **Read APIs are edge-cached for 10 s with 30 s of stale-while-revalidate**, stated twice on purpose so a later edit to the client directive cannot drop the edge window (`lib/route.ts:20-32`), and the browser is never promised a stale copy (`max-age=0, must-revalidate`).
4. **Writes are serializable and retried.** `MONEY_TX = { isolationLevel: "Serializable", maxWait: 15_000, timeout: 25_000 }` with up to 10 attempts on `P2034`/`40001`/`40P01` and jittered backoff (`lib/txn.ts`).
5. **A settlement invocation has a 60 s ceiling** (`app/api/webhooks/stripe/route.ts:21`) and a bounded mail drain inside it (`SETTLE_MAIL_DRAIN_BUDGET_MS = 15_000`).
6. **The two jobs have a 30 s ceiling** equal to their worst case — settled in `13` §5.10, R13-4; not restated here.
7. **Denormalized reads are cheap by construction**: the board reads `Stake`/`FirstClaim` rows directly and the aggregates live on `Element` (`12` §5.8), so the ranked surfaces do not recompute anything.
8. **Nothing in the product measures itself.** No route reports its own duration, no counter records a cost driver, and the only budget-shaped control in the repository is the advisory expiry (`14` R14-11).

## 4. The path walked

Two servers, both mine, on this host, on 2026-09-15, against a local Postgres 16 container (`ptl-review-pg-55440`) that replays migrations `0000`–`0006` and both seeds:

| What | Command | What it answers |
| --- | --- | --- |
| Development server | `npx next dev -p 3215` | contract and behaviour probes that need a live app (`11`, `14`); **not** the timings here |
| Production build | `npx next build` then `npx next start -p 3211` | every timing and every transfer number in this doc — a dev server's per-route compilation makes its first-hit times meaningless |
| Byte budget | a Node script over `.next/static` and the prerendered HTML emitted by that build (raw bytes, then gzip and brotli of the same files) | §5.1, §5.4 |
| Timings | `node` with `fetch`, wall-clock `performance.now()` per request, first touch then warm | §5.2, §5.8 |
| Contention | two Node scripts: distinct-IP concurrent checkouts, and 13 concurrent settlements on one element | §5.9 |
| Failure | the servers left running against a `DATABASE_URL` pointed at a dead port, and again against a live database with `PAYMENTS_LIVE=true` and fabricated provider credentials | §5.10, §5.11 |
| Production reading | `curl.exe -sS -D - -o NUL https://www.periodictable.lol/` and the same for `/api/stats` | §5.3 |

**Port attribution, recorded because it cost a re-measurement.** An earlier pass of this batch took some figures from `:3212`. `:3212` is a *sibling session's* server (`danilgorbunofff-cuddly-giggle`, its container `ptl-review-batch2-pg` on `55499`) — a different checkout of the same commit with a different database. Every figure in this doc was re-taken on `:3215` and `:3211`, which are mine (container `ptl-review-pg-55440`). No number below comes from `:3212`, and the earlier readings are not reused anywhere in `11`–`15`. **Nothing was changed in the sibling's worktree or container.**

**What this checkout does not have.** There is no `.env` here and none was created. Consequences that shape every number below: `providerConfigured()` is false, so `getProviderMode()` answers `"dev"` (`lib/flags.ts:10-19`) and `/pay/[paymentId]` runs the simulator rather than a provider redirect (`05` §7 R05-8); `RESEND_API_KEY` is unset, so every send takes `lib/email.ts`'s "logged" branch (`12` R12-3); Upstash is unconfigured, so every rate limit is an in-process `Map` that fails open (`14` R14-2); and no *valid* Stripe credential exists, so the provider's success path cannot be exercised at all (**U15-4**) — only the shape of its failure can (§5.10). A local production-mode build is the correct instrument for the questions here — they are shape and cost questions, not deployment questions — but it means **the money path's timings are Prisma-against-Docker timings**, not Neon timings (**U15-3**).

## 5. Live evidence

Every number in this section was produced on 2026-09-15 on one Windows host, from the production build of `9681bdc`, against the local `ptl-review-pg-55440` container unless the row says otherwise. Nothing here is a Lighthouse score and nothing was measured against the live origin except the three header reads in §5.3.

### 5.1 What a cold reader actually pays for

The byte budget is taken from the emitted build (`.next/`), not from the source: the document, the CSS and JS the document actually references, and the fonts those rules can select. Raw sizes are file sizes; `gzip`/`brotli` are the same files compressed with Node's `zlib` at default level, which is the closest stand-in this host has for what the CDN sends.

| Cold load | Referenced assets | Raw | gzip | brotli |
| --- | --- | ---: | ---: | ---: |
| `/` | 12 (document + CSS + 10 JS) | 608,994 B | 181,000 B | **157,366 B** |
| `/elements/Ts` | 11 (document + CSS + 9 JS) | 493,622 B | 148,017 B | **129,060 B** |
| Fonts, if the browser selects the four `basic-latin` subsets | 4 woff2 | 68,856 B | 29,654 B | 39,185 B |

`/`'s document is **151,478 B** of prerendered HTML in the build (`index.html`), and the origin serves `Content-Length: 152,029` (§5.3) — the whole table is in the HTML, so the LCP candidate does not wait on a fetch. The element document is the interesting one: the build emits **13,259 B** of HTML when the database is reachable at prerender time (`Ts.html`), but the running server answers **11,778 B** for the same URL, which is the fallback shell `app/elements/[sym]/page.tsx:53-80` returns when its own query fails — during the build of this checkout the database was *not* reachable, so several element pages were baked as the empty shell and are served with `x-nextjs-cache: HIT` (§5.7, R15-10).

Two asymmetries are worth the table above:

1. **The fonts are never preloaded.** `app/layout.tsx:2` loads `next/font/local` for the display face; the emitted `index.html` contains exactly one `<link rel="preload">` and it is the webpack runtime chunk with `fetchpriority="low"` — no `woff2` is hinted. A cold reader therefore discovers the display face only after CSS parses, and pays up to 68,856 B at the font's own priority. `R15-2`.
2. **The document is bigger than everything else combined at brotli parity.** 151,478 B of HTML compresses to roughly 20 kB, but the *uncompressed* 151 kB is what the browser parses before first paint; the JS bundle this doc measured is 157 kB brotli on top of it. The table below (§5.4) breaks that bundle down.

### 5.2 Wall-clock, and what the 4G column really is

Timings from `node` + `fetch` + `performance.now()` against `next start -p 3211` on this host, one request per row unless stated. "First touch" is the first request after server start; "warm" is the median of five.

| Surface | First touch | Warm | Bytes | Notes |
| --- | ---: | ---: | ---: | --- |
| `/` | 1,290 ms | 25 ms | 151,478 | prerendered; `x-nextjs-cache: HIT` |
| `/elements/Ts` | 365 ms | 7 ms | 11,778 | `x-nextjs-cache: STALE` on first touch, then `HIT` — the ISR read path (§5.7) |
| `/api/stats` | 248 ms | 4 ms | 102 | one aggregate query, then edge-cached 10 s |
| `/api/board?tab=crowns` | — | 11 ms | 1,111 | |
| `/api/board?tab=by-element` | — | 13 ms | 3,027 | the widest board tab |
| `/api/board?tab=early` | — | 12 ms | 1,059 | |
| `/api/table-order` | — | 14 ms | 1,773 | |
| `/api/activity?limit=6` | — | 27 ms | 1,356 | the most expensive read in the product (§5.5) |
| `/api/activity?limit=20` | — | 77 ms | 4,484 | same query, 3.3× the rows |
| `/api/elements/Ts` | — | 12 ms | 596 | |
| `/s/linear.app` (unknown domain) | — | 109 ms | 9,559 | 404 document |
| `/pay/<paymentId>` | — | 47 ms | 11,880 | `no-store`, dynamic (§5.4) |

These are localhost numbers against a container on the same disk, so they measure *shape*, not geography. For the field question the plan actually asks — cold 4G — the only honest instrument available here is arithmetic on the byte budget, and it is labelled as arithmetic:

**Mobile-4G arithmetic (not a measurement).** At the ITU's 4G "typical" downlink of roughly 1.6 Mbit/s (≈ 200 kB/s), and ignoring DNS, TLS and per-request RTT:

- `/` cold = 152,029 B document + 157,366 B brotli assets + 68,856 B fonts ≈ **378 kB ≈ 1.9 s** of transfer, before parse/execute. Substituting gzip for brotli makes it ≈ 401 kB ≈ 2.0 s. The document alone is 0.76 s of that.
- `/elements/Ts` cold = 11,778 B + 129,060 B + 68,856 B ≈ **210 kB ≈ 1.05 s**.

Against a 50 kB/s "slow 4G" floor those become ≈ 7.6 s and ≈ 4.2 s. The number this doc will defend is the one that needs no network model: **the transfer is 378 kB and it grows with nothing but the fixed asset set**, so a reader on a 1 Mbit/s connection pays ≈ 3 s for `/` regardless of load. The field LCP/INP/CLS are **U15-1**.

### 5.3 What the CDN is told to do — production and local

Three production header reads (2026-09-15, `curl.exe -sS -D - -o NUL`, no body kept) and the same surfaces from the local production build:

| Surface | Production | Local production build | Policy in source |
| --- | --- | --- | --- |
| `/` | `cache-control: public, max-age=0, must-revalidate` · `age: 7567` · `x-vercel-cache: HIT` · `content-length: 152029` · **`x-request-id` absent** | same shape, `HIT` | prerender, no `revalidate` in `app/page.tsx` |
| `/api/stats` | `cache-control: public, s-maxage=10, stale-while-revalidate=30` · `x-request-id: 6b0cd4ff-…` | `s-maxage=10, stale-while-revalidate=30` | `lib/route.ts:20-32` `READ_CACHE` |
| `/s/[domain]`, `/pay/[paymentId]` | not read | `private, no-store` | `app/s/[domain]/page.tsx`, `app/pay/[paymentId]/page.tsx` |
| `/api/*` writes (checkout, webhooks, admin, jobs) | not read | `no-store` | `lib/route.ts:30-32` |

Three things follow, and only the first is comfortable.

1. **The edge is doing the work the browser refuses to do.** Every document and read API is deliberately `must-revalidate`/`no-store` towards the browser, so the *only* absorber of a traffic spike is the CDN's 10 s copy (R15-1). That is a correct design for correctness and a thin one for a launch: on a cold edge cache, every distinct query reaches both the function and Postgres.
2. **`/`'s document window is a year and an element page's is a minute.** The prerendered document is served `s-maxage=31536000` (the platform default for a fully static route, inherited from `next.config.mjs`'s defaults) while `app/elements/[sym]/page.tsx:10` sets `revalidate = 60`. The consequence is in §5.7.
3. **The stale copy can outlive its data at the edge, invisibly.** `age: 7567` on `/` means this doc's production read came from a copy 2 h 6 m old — correct for a prerendered document without live data, but it also means nothing about the board's freshness can be inferred from `/`'s headers at all; the numbers a reader sees come from the three client fetches (§5.4).

### 5.4 What is in the bundle

`next build` reports a **First Load JS shared by all** of **87.3 kB**; the per-route references are larger than that because they include the route chunk and the framework chunk. Measured from the emitted files:

| Chunk (file prefix in `.next/static/chunks`) | Raw | gzip | What it is |
| --- | ---: | ---: | --- |
| `fd9d1056-…js` | 172,834 | 53,637 | framework + main |
| `117-…js` | 124,364 | 31,735 | shared app code (SWR, table data) |
| `polyfills-…js` | 112,594 | 39,520 | `polyfills` — shipped to every reader |
| `app/page-…js` | 100,830 | 26,891 | the home route chunk, which carries `PeriodicGrid` and `TableCamera` |
| CSS (`app/layout-…css`) | 36,868 | 8,644 | all of the product's CSS, one file, render-blocking |

The three live numbers a reader sees on `/` arrive as client fetches (`/api/stats`, `/api/board`, `/api/activity`) on the 30 s SWR cadence batch 1 accepted (`05` §9 Q2), so the JS above is not optional decoration: **the prerendered document is a table of names and the numbers in it come from 157 kB of JavaScript**. A reader who blocks JS sees the table and the static per-element copy, not the leaders or activity counts.

### 5.5 Round trips per read

Three instruments, all on the local container:

- `pg_stat_statements`-style counting by running each route once against a **touched** (warm) cache-less path and reading `pg_stat_user_tables`/statement counts from a snapshot diff, so "statements per request" is the number of server round trips the route makes;
- `EXPLAIN (ANALYZE, BUFFERS)` on the extracted SQL, run with the same parameters the route uses;
- the route's own JSON, to tie rows-back to rows-sent.

| Route | Statements per uncached request | Rows read | Rows sent |
| --- | ---: | ---: | ---: |
| `/api/stats` | 1 | aggregate over `Element` (122) + `FirstClaim` count | 1 object |
| `/api/board?tab=crowns` | 2 | `Element` where `isLeader` (122 scanned, see §5.6) + `Stake` join | 20 rows |
| `/api/board?tab=early` | 2 | `FirstClaim` + `Element` + `Startup` | 20 rows |
| `/api/board?tab=by-element` | 2 | `Element` (122 scanned) + `Stake` group | 20 rows |
| `/api/elements/[sym]` | 4 | element, stakes, startups, first claim | 1 object |
| `/api/table-order` | 1 | `Element` (122) | 122 pairs |
| `/api/activity` | **5** | 14 joins over `ActivityLog`/`Stake`/`Startup`/`Element`/`Payment`… | `limit` rows |

`/api/activity` is the only read whose cost scales with its own parameter (27 ms → 77 ms from `limit=6` to `limit=20`) and the only one that fans out to five round trips; it is also the one with **no `.take()` ceiling on its inner lookups** (R15-5). Everything else is bounded by the 122-element inventory.

### 5.6 The plans that matter

`EXPLAIN (ANALYZE, BUFFERS)` against the live database, mid-review (48 payments, 70 stakes, 122 elements), on the two shapes the board actually issues:

- the `isLeader` filter — `Seq Scan on "Element" … Filter: "isLeader" … rows=1 … Buffers: shared hit=2` — the planner reads the whole relation because no index covers `isLeader` (`12` R12-6 documents the hand-written partial index that exists for the *other* flag). At 122 rows this is 2 buffers and ~0.05 ms; at the 10× element inventory this product would need to reach a real traffic problem it would be the first scan to hurt. **R15-4.**
- the `Stake` ordering per element — index-backed and bounded, consistent with `12` §5.4.

None of the reads the product makes is slow *today*; the finding is that two of the three board tabs have no `take` at all on the element scan and the activity feed has none on its joins, so the cost of a spike is paid in full by Postgres rather than by the CDN (§5.3).

### 5.7 Staleness, and the shell that is served as if it were the page

`/` is a prerendered document with no live data in it, so its staleness is invisible: the numbers come from the 10 s edge window on the three APIs. Element pages are different, three times over:

1. `app/elements/[sym]/page.tsx:10` sets `revalidate = 60`, so a reader can see numbers up to a minute old on a page whose whole meaning is "who leads this element".
2. The *served* document for many symbols is the **no-database fallback shell** (11,778 B) baked at build time, not the data-bearing document (13,259 B). It is served `x-nextjs-cache: STALE` on first touch and `HIT` afterwards, and it contains no error state a reader could act on — it renders as a page.
3. `s-maxage=31536000` on `/` versus `revalidate = 60` on the element route means the two cache lifetimes differ by five orders of magnitude behind the same product name.

This is a **performance-doc observation of a data-integrity fact**: a page that says nothing about a failed read is a silent-stale claim, and `12`/`11` own the underlying contract. Recorded here because the only reason it is invisible is caching. **R15-10.**

### 5.8 The money path's cold start, and the three states of a checkout

The checkout route is the only money-path surface a customer can be first to touch, so it is also the only route whose cold start a paying reader can eat. Measured on the production build, `next start`, with the database up:

| Process state | First request | Warm | Body |
| --- | ---: | ---: | --- |
| No provider configuration (the state of this checkout, and of any deploy that has not set `PAYMENTS_LIVE`) | 58 ms | 12–20 ms | **`403 {"error":"Payments are paused — join the waitlist.","waitlist":true}`** |
| `PAYMENTS_LIVE=true` + a syntactically valid but fabricated `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` pair | **805 ms** | 128 / 104 / 56 ms | **`502 {"error":"Payment provider unavailable. Try again."}`** |

The 403 is the launch gate working as designed (`app/api/checkout/route.ts:109-110`, gate at `lib/flags.ts:11-27`): no payment is taken, the customer is offered the waitlist, and the same body appears whether the flag is off or Stripe's keys are absent. The **805 ms cold** figure is **R15-6** — the first request a paying reader makes is the only one that can pay a cold start. The 502 is the provider's own rejection surfaced honestly: a checkout that reaches Stripe and is refused by Stripe is answered `502` with a clean, non-blaming sentence in under a second even cold, and that contrast with §5.10's body-less 500 on a database outage is the whole substance of **R15-3**.

**What the 502 leaves behind is the part worth recording.** The three attempts in that run (two distinct requests plus one idempotency-key replay) left **three `Payment` rows with `status = pending`, `providerRef = NULL`, `path = join`, `provider = stripe`** and **no `ProviderEvent` row at all** — the replay consumed the same idempotency key and did not add a fourth. Nothing in the product reads those rows: they are invisible to `13`'s two pollers (no `ProviderEvent` to poll) and only `reconcile` can close them. A customer who retries five times leaves five pending attempts for a payment that never existed at Stripe. **R15-12**; `07` (batch 2) owns the provider-attempt ledger, so this doc reports the shape and the count and defers the fix.

### 5.9 Concurrency on one element

Five exercises, all against the same live database, all on my own machine. The element is `As` (Arsenic) except where stated; each row names what it did and what came back.

| # | Exercise | Result | Read |
| --- | --- | --- | --- |
| 1 | **8 simultaneous take-quotes** on an unpurchased element (`POST /api/checkout…quote` path) | `200` × 1, `409` × 7, all answered in **211–466 ms** | the reservation promise holds: exactly one winner, seven honest conflicts, no 500s. `lib/reservations.ts:34-49` |
| 2 | **8 simultaneous take-quotes while one unpurchased hold exists** | `409` × **12/12** at 47–91 ms, with `RESERVATION_CONFLICT` | one buyer's abandoned hold blocks every competitor for **15 minutes** (`RESERVATION_TTL_MS`, `lib/reservations.ts:14-20`). **R15-9** |
| 3 | **8 simultaneous checkout+settle, equal amounts ($60)** | **8 × `200 paid`** | all eight bought the lead; **all eight receipts say "You're #1"** (`emails/receipt.tsx:17,25`) — money-path copy, `10`/`04` own it, not new here. **R15-8** |
| 4 | **13 simultaneous settles on one element** | **13 × `200 paid`**, latency **681 / 2,480 / 3,773 / 3,773 ms** (min / median / p95 / max), mean 2,278 ms | serializable retries work under 13-way contention and nobody sees a 500; the cost is a 3.8 s tail, and the tail is the number §5.11 checks against the platform ceiling. **R15-7** |
| 5 | **5 checkouts from one IP in quick succession** | `409` × 5 on already-held elements, then `429` × 3 on the rest | the 5-per-hour checkout limit fires in-process (`14` R14-2 owns the fail-open consequence) |

Two more contention facts from the same session, both controlled: **two outbox drains started at once claimed zero rows between them** (`FOR UPDATE SKIP LOCKED` leasing — `13` owns the mechanism), and the **write inventory of one first-time settlement** is 9 rows across 8 tables plus one `Element` update:

| Table | Rows per settlement | Why it is here |
| --- | ---: | --- |
| `Startup` | +1 | the buyer's domain, created on first sight |
| `Stake` | +1 | the money |
| `Payment` | +1 | the ledger entry |
| `ClaimReservation` | +0 | consumed by the settling transaction |
| `OutboxEvent` | **+3** | `analytics-<paymentId>`, `preview-<paymentId>`, `receipt-<paymentId>` — the three keys are visible in `OutboxEvent."dedupeKey"` |
| `AuditLog` | **+2** | the money-path audit pair |
| `EmailLog` | +1 | the receipt |
| `ActivityLog` | +1 | the feed |
| `ProviderEvent` | +1 | the webhook's own record |
| `FirstClaim` | +1 when the element had none | the claim |

Measured directly by snapshotting all 15 `pg_stat_user_tables` counters before and after, then repeating with ten further pairs (elements `Xe`…`V`, \$62–\$71) to confirm the shape: `OutboxEvent` `+33`, `AuditLog` `+22`, `EmailLog` `+11`, `Stake` `+11`, `Payment` `+11`, `ProviderEvent` `+11` for eleven settlements. **This is the write amplification the cost model is made of** — every dollar of revenue writes eleven rows beyond the stake itself, and `EmailLog`/`ProviderEvent`/`AuditLog` grow forever. **R15-13.**

Sequential (uncontended) money path, for the baseline: checkout **76–182 ms**, checkout+settle pair **223 / 251 / 350 ms** (min/median/max of ten pairs) — so the honest "did I win" wait is a quarter of a second of server time when nobody is fighting you, and the 3.8 s tail in row 4 is entirely contention.

### 5.10 What a dependency failure looks like to the customer — measured

Method: the production build, served by `next start -p 3216` with `DATABASE_URL` pointed at **a dead port** (55441) while the container stayed up, and with `PAYMENTS_LIVE=true` plus the fabricated Stripe pair so the process passes every configuration guard except the database. Every request below therefore reached the route's own code and failed only at its first query. Each non-2xx took ≈ **2.05 s** — Prisma's connection timeout, not the platform's.

| Surface | Status | Body | What the customer sees |
| --- | ---: | ---: | --- |
| `GET /` | 200 | 152,029 B | the table, from the prerender |
| `GET /elements/He` | 200 | 13,205 B | the page, from the prerender |
| `GET /elements/Ts` | 200 | 13,259 B | the page, from the prerender |
| **`GET /s/linear.app`** | **500** | 6,560 B | **Next's error document** — the only user-facing page that breaks (4,200 ms) |
| `GET /api/stats` | 500 | **0 B** | nothing |
| `GET /api/board?tab=crowns` | 500 | **0 B** | nothing |
| `GET /api/activity?limit=6` | 500 | **0 B** | nothing |
| `GET /api/elements/Ts` | 500 | **0 B** | nothing |
| `GET /api/table-order` | 500 | **0 B** | nothing |
| `GET /api/search?q=linear` | 500 | **0 B** | nothing |
| `POST /api/report` | 500 | **0 B** | nothing |
| `POST /api/waitlist` | 500 | **0 B** | nothing |
| `POST /api/manage/request` | 500 | **0 B** | nothing |
| **`POST /api/checkout`** | **500** | **0 B** | **nothing — the buyer's screen goes empty mid-checkout** (2,154 / 2,060 ms) |
| `GET /api/admin/reports` (valid Bearer) | 500 | **0 B** | nothing |
| `GET /api/jobs/reconcile` (valid Bearer) | 500 | **0 B** | nothing — so a database outage also blinds the operator's own retry button |
| `POST /api/admin/outbox/retry` (valid Bearer) | **400** | 44 B | `{"error":"dedupeKey is required.","code":"BAD_REQUEST"}` — validation runs *before* the database, so this route is the one honest error in the row |
| `POST /api/dev/pay` | **403** | 46 B | `{"error":"Disabled when Stripe is enabled."}` |
| `GET /api/dev/pay` | 405 | — | method-not-allowed |
| `GET /api/emails/preview?template=receipt&sym=Ts` | **404** | 23 B | `{"error":"Not found."}` |
| `GET /api/jobs/config` (valid Bearer) | **503** | JSON | `{"ok":false,"env":"production","findings":[…]}` listing missing keys **by name only** |
| `POST /api/webhooks/stripe` (garbage signature) | **401** | 22 B | `{"error":"bad signature"}` — signature verification precedes every query |

Four conclusions, in order of how much they matter:

1. **A database outage is a blank screen, and the checkout is a blank screen.** Nine distinct 500s with zero bytes of body. The customer mid-checkout is told nothing at all — worse than an error, because a blank answer to "did I just pay \$60?" is the exact question the product exists to answer. `11` §5.14 and `14` §5.7 own the missing error node; this doc owns the size of it: **0 B**. **R15-3.**
2. **The launch gate and the outage are the same sentence.** With payments off — the state of every deploy that has not set `PAYMENTS_LIVE` — the checkout guard at `app/api/checkout/route.ts:109-110` answers `403 {"error":"Payments are paused — join the waitlist.","waitlist":true}` *before* any query runs, so a reader sees the commercial pause text while the database is gone. The two conditions only separate once payments are on, at which point the reader gets the body-less 500 instead. An operator watching only the customer-facing text cannot tell "we are not selling yet" from "we are down". **R15-3.**
3. **The two dev/preview surfaces are dead in a production process**, and dead by different mechanisms — `/api/dev/pay` refuses on the provider-mode gate (`403 Disabled when Stripe is enabled`), `/api/emails/preview` 404s (`{"error":"Not found."}`) — independently of the database. That is the plan's question answered in the affirmative, and it also means **neither can be used as a smoke-test probe in production**; the only dependency-free liveness signal is `/api/jobs/config`, which is behind `ADMIN_TOKEN` (`13` §5.9).
4. **Log hygiene is good and correlation is absent.** The full server log for all of the above is 35,979 B over 487 lines: **zero secret values, zero request paths, zero request ids**. What it does contain is one `prisma:error` block per failed query naming the model (`startup` ×15, `stake` ×7, `payment` ×6, `element` ×5, `waitlistEntry` ×2, `report` ×2) plus internal stack frames. So the operator can count failures by model but **cannot tie any of the nine 500s to the customer who saw it** — `11` R11-3 owns the request-id contract; this is its cost measured on the log side.

The email dependency fails differently and silently: with `RESEND_API_KEY` unset every send takes `lib/email.ts`'s "logged" branch (`12` R12-3), so `EmailLog.status = logged` and the customer receives nothing while the row says the mail was handled. The measured shape is the table in §5.9 — 55 `receipt`, 44 `waitlist`, 25 `report`, 4 `outbid` rows in `EmailLog`, **all with status `logged`**, none with status `sent`. What a *slow* Resend does to a 30 s function is **U15-5**; what a *failing* Upstash does is already settled (`14` R14-2, fail-open) and `13` owns the retry cron.

### 5.11 Does the worst case fit the ceiling?

The webhook is the only money-path invocation with a platform ceiling of its own: `export const maxDuration = 60` with `dynamic = "force-dynamic"` (`app/api/webhooks/stripe/route.ts:17,21`). Inside it, three budgets apply:

| Budget | Value | Source | Worst case |
| --- | ---: | --- | --- |
| Settlement transaction timeout | 25,000 ms per attempt | `MONEY_TX` (`lib/txn.ts`) | one attempt can spend 25 s |
| Settlement attempts | 10 | `TXN_MAX_ATTEMPTS` (`lib/txn.ts`) | 10 × 25 s = **250 s of retry budget** |
| Inline mail drain | 15,000 ms | `SETTLE_MAIL_DRAIN_BUDGET_MS` (`lib/settle.ts`) | bounded, so it cannot eat the ceiling |

The arithmetic worst case (250 s) therefore **exceeds the 60 s ceiling by 4×**, and no code path checks the clock against `maxDuration` before starting another attempt. The saving grace is ordering: the settlement commits before the drain, `ProviderEvent` makes the whole call idempotent, and Stripe retries a webhook it saw time out — so a platform kill mid-`reconcile` costs emails, not money, and `13`'s outbox poller picks the mail up. The measured worst case is far from this: **13-way contention on one element produced a 3,773 ms maximum — 6.3% of the ceiling** (§5.9 row 4), and the uncontended pair is 223–350 ms.

So: the webhook has headroom it does not spend, and a retry budget it cannot spend. Contrast `13` R13-4, where the two job workers' worst case *equals* their `maxDuration` exactly — the opposite failure of the same design instinct. **R15-7** is the contention tail; the arithmetic above is context for it, not a separate finding.

### 5.12 What it costs at 10, 100 and 1,000 checkouts a day

**Measured inputs** (from §5.9): one first-time settlement grows the database by **5.6 kB** net (9,599 kB → 9,655 kB for ten settle pairs plus the failed attempts) and writes **9 rows across 8 tables** plus one `Element` update; a checkout that fails at the provider writes one `Payment` row and nothing else (§5.8); a read costs one round trip per uncached request (§5.5); a cold `/` install is 152 kB of document plus 157 kB of brotli assets plus up to 69 kB of fonts (§5.1).

**Unit prices.** No account access exists from here, so the rates below are the public list prices as summarised by a search on 2026-09-15 — **third-party summaries, not invoices** — and every provider-specific number in this section is therefore model output, not a bill (**U15-6**): Vercel Pro $20/seat/month including 1 TB of fast data transfer (then \$0.15/GB), 1 M function invocations (then \$0.60/M), 10 M edge requests (then \$2/M), Active CPU \$0.128/CPU-hour, provisioned memory \$0.0106/GB-hour, ISR reads 1 M then \$0.40/M, ISR writes 200 k then \$4/M; Neon Launch \$0.106/CU-hour, \$0.35/GB-month storage, 100 GB egress then \$0.10/GB; Resend and Upstash tiers are unknown here.

| Line | 10 checkouts/day | 100/day | 1,000/day |
| --- | ---: | ---: | ---: |
| Settlements/month | ~300 | ~3,000 | ~30,000 |
| Database growth/month at 5.6 kB each | ~1.7 MB ≈ **$0.001** | ~17 MB ≈ **$0.006** | ~168 MB ≈ **$0.06** |
| Rows written/month (11 per settlement) | ~3,300 | ~33,000 | ~330,000 |
| Function invocations attributable to the money path (~6/checkout) | ~1,800 | ~18,000 | ~180,000 — still under the 1 M included |
| Receipt + outbid emails/month | ~300 + few | ~3,000 | ~30,000 (Resend tier unknown) |
| The line that actually scales with the product: element-page ISR writes if every symbol is revalidated every minute (`revalidate = 60`, 122 symbols) | up to 175,680/day = **5.27 M/month ≈ \$20** over the 200 k included | same | same |
| Bandwidth: how many `/` visits 1 TB is | ~6.7 M visits | ~6.7 M | ~6.7 M |

**What this says.** At every volume the plan asks about, the money path itself is **cents per month** — storage is 6 cents at 1,000 checkouts a day, invocations are free until 1 M/month, and the dominant cost is the \$20 seat. The single line that can surprise is the ISR writes: it scales with *inventory × revalidation frequency*, not with traffic, and at the configured 60 s window on 122 symbols it is already at the 200 k included writes the moment crawl and reader traffic touch every symbol each minute — which is exactly what a launch does. Two structural consequences: **there is no spend telemetry anywhere in the product** (no route reports its own duration or a cost driver; `R15-11`), so all of the above is invisible until an invoice arrives; and **the money path's cost is bounded by the rate limits** (5 checkouts/hour/IP, `14` R14-2), which is the only thing standing between a determined buyer and an unbounded write volume.

### 5.13 The launch-day ceiling

Stated as a number with its evidence, and separated from the load the plan forbids me to generate (**U15-2**):

- **Reads are not the ceiling.** The three read surfaces a reader polls every 30 s are edge-cached for 10 s with 30 s of stale-while-revalidate (§5.3). Because the CDN key is the URL, **1,000 simultaneous readers polling three endpoints produce at most 3 endpoints × 6 refreshes/minute = 18 origin reads per minute** — reader count cancels out. This is arithmetic on the stated cache policy, not a measured throughput.
- **Writes are the ceiling.** The money path is serializable and retried; on one Node process against one Postgres container, **13 simultaneous settlements on a single element all succeeded with a 3,773 ms p95** (§5.9). On real infrastructure the equivalent limit is set by Neon's pool rather than my single process, and that pool is unconfigured (`12` R12-5) — so the honest ceiling statement is: *the launch can absorb at least 13 simultaneous settlements on the same element with no failure, and what it cannot absorb is unknown until the connection ceiling is set and measured* (**U15-3**).
- **The three soft ceilings that will announce themselves first**: a 15-minute abandoned hold freezing competing buyers on that element (R15-9, measured 12/12 refusals), a body-less 500 for any database hiccup (R15-3, measured across 14 surfaces), and element pages serving the no-database shell out of the CDN for up to a year (R15-10, measured `s-maxage=31536000` on `/` and `x-nextjs-cache: STALE` on `/elements/Ts`).
- **What would falsify this ceiling**: a staging deployment with production-shaped data and a load generator (the settling command in the probe table), plus a Lighthouse/CrUX read for the other half of the question.

### 5.14 The fix pass (2026-09-16)

The fix pass closed the findings below, against the same review container and with the phase-11
route contract and the phase-12 data layer already in place. Every claim in this section is
either source-level (a directive, a query, a guard) or the suite's own output: **nothing in this
pass was deployed**, so R15-1's live header re-read and R15-10's `x-nextjs-cache` re-read belong
to the next deploy. The verification commands and their results are at the end of the section.

**R15-1 — the browser gets a window, sized under the poll.** `READ_CACHE` (`lib/route.ts:45-49`)
now answers `Cache-Control: public, max-age=5, s-maxage=10, stale-while-revalidate=30` instead of
the CDN-only pair whose browser half the edge rewrote to `max-age=0, must-revalidate` (§5.3). The
safety argument is an inequality rather than a judgement call: **5 s sits below the 30 s
`refreshInterval` every consumer of these routes polls at** (`app/page.tsx`,
`components/TerritoryView.tsx`, `components/WorldOrder.tsx`, `components/ActivityCard.tsx`), so a
cached copy can never outlive the poll that would have replaced it and the live numbers keep the
cadence `05` §9 Q2 accepted. What the reader gains is the burst case — a modal opening, a reload,
a back-navigation, the board and the activity card mounting together — which is now answered
without a request instead of four. `lib/readCache.test.ts` asserts the inequality against the
client's own literal (`max-age × 1000 < 30_000`) and fails on any three-digit `max-age`, so
raising the window past the poll interval breaks the suite rather than the board. The doc-comment
paragraph that described the edge rewriting the browser directive was **deleted**, because it no
longer describes the behaviour it sits above. The two card routes were audited and deliberately
left alone: `app/og/[sym]/route.tsx:9` and `app/og/home/route.tsx:14,18` are CDN-only windows for
images nothing polls.

**R15-2 — corrected, not fixed.** The premise was wrong in two places and the correction is the
deliverable; the size itself is the inventory-scaling subject of §9 Q1. See the table below.

**R15-3 — the last unguarded data path.** `app/s/[domain]/page.tsx` was it: `generateMetadata`
ran its own unguarded `prisma.startup.findUnique` *before* the page, so with the database
unreachable the throw came from the metadata pass and the visitor got Next's error document
(§5.10's 6,560 B body). Both reads now sit in one `loadProfile()` helper, `generateMetadata`
catches and answers a generic title, and the page distinguishes the two nulls it can see: a
missing, empty or hidden profile is still a 404 (`if (!dbFailed) return notFound()`), while a read
that *threw* renders the product's own shell — "… — profile temporarily unavailable", with the
table link and the 44 px CTA — and logs
`{"scope":"page","page":"profile","where":…,"domain":…,"reason":…}`. The API half of this finding
was already closed by phase 11 (`withContract` on all 28 routes), so what remained was exactly the
page paths, and the element page's half is R15-10.

**R15-4 — the index was real, the rest of the evidence was not.** The finding's quoted plan
(`Seq Scan on "Element" … Filter: "isLeader"`) describes a query `/api/board` never issues:
`isLeader` is a `Stake` column (`prisma/schema.prisma:159`), not an `Element` one, and the route
never reads `Element` at all; `?tab=by-element` has carried `take: 20`
(`app/api/board/route.ts:54`) since it was written. What survived is real: **no index covered
`Stake."isLeader"`** for the two tabs that filter on it. `prisma/migrations/0011_leader_index`
adds `Stake_isLeader_amountUsd_idx` — partial (`WHERE "isLeader" = true`) and ordered
`("amountUsd" DESC)` so it serves both `crowns` and `by-element` — hand-written and read back
from `pg_indexes` by `lib/schema.test.ts`, the same idiom `0001_phase1_ownership`'s
`ClaimReservation_elementId_active_key` uses and for the same reason (`migrate diff` cannot
express a partial index). No `take` was added to `crowns` or `early`: both aggregate over *all*
rows and rank after aggregating, so a `take` would truncate the input and silently undercount
crowns and medals — a wrong answer instead of a shorter one. Both routes now say that in place.
The honest limit of the fix is that it changes no plan at today's size: with the planner free,
122 rows still resolve by seq scan, and `enable_seqscan=off` is what shows the index is usable
(`Index Scan using "Stake_isLeader_amountUsd_idx"`); the `by-element` ordering already resolves
through the pre-existing `Stake_elementId_amountUsd_idx` with `Filter: "isLeader"`. The index is
the growth path for the one dimension the product plans to grow, not a change to any measured
number in §5.6.

**R15-5 — five statements become one.** `app/api/activity/route.ts` now issues a single
`prisma.$queryRaw` instead of five round trips. The visibility rule moved *inside* the query as
`WHERE NOT EXISTS (SELECT 1 FROM "Startup" h WHERE h.domain = a.domain AND
h."moderationState"::text = 'hidden')` — before `LIMIT`, so the page size stays exactly what the
caller asked for, where the previous shape materialised an unbounded array of hidden domains and
filtered in memory. The stake lookup is bounded by the unique `(domain, symbol)` pair (one join
against a `Stake` row that is unique on `(elementId, startupId)`), so the inner lookups are
bounded by the joined row, not by a `.take()` the caller could not see. `$queryRaw` is the
established instrument here (`lib/outbox.ts:305,405`, `lib/erasure.ts:157,257`), and it is what
keeps the route safe under transaction-mode PgBouncer (`12` R12-5). The response shape is
unchanged by construction: `lib/routes.test.ts` and `lib/moderation.test.ts` drive the route
against the container and assert the same rows, including that a hidden domain's activity stays
out of the feed. One honest note on the numbers: the fix's own timings on the test container
(`ms: 1` in the invocation log below) are a fixture-sized database and are **not** comparable to
§5.5's 27/77 ms production readings.

**R15-6 — nothing structural, now instrumented.** The doc's own proposed fix was "nothing
structural", and none was made. What changed is that the number is no longer an inference: every
origin invocation logs its duration (R15-11), so the next cold start is a line in the log rather
than a timing exercise.

**R15-7 — the retry budget is now a wall-clock budget.** `lib/txn.ts` gained
`TXN_BUDGET_MS = 40_000` and a refusal in `withTxnRetry`: before another attempt starts, the loop
checks `elapsed + ATTEMPT_RESERVE_MS > budgetMs` (`ATTEMPT_RESERVE_MS = MONEY_TX.timeout`, so a
retry starts only if a whole attempt still fits) and, when it does not, rethrows the retryable
error it already has after logging `{"scope":"txn","msg":"budget-exhausted",…}`. The bound is the
budget rather than the budget plus one attempt on purpose: with a 25 s statement timeout inside a
40 s budget, retries start only during the first 15 s — and since the backoff is sub-second, the
eight or nine attempts the loop exists for still fit, while §5.11's 250 s arithmetic tail cannot.
Rethrowing needs no new handling anywhere: checkout already answers `502` with a code and Stripe
redelivers the webhook, whose `ProviderEvent` and payment guard make the re-run idempotent. 40 s
of the 60 s `maxDuration` leaves 20 s for the surrounding work (quote, audit, outbox, receipt).
The signature accepts `number | TxnRetryOptions` so the two existing numeric call sites are
untouched (`lib/phase7.test.ts:229` still pins the ordering inside `checkout`), and `now` is
injectable so the two new tests in `lib/ledger.test.ts` prove the refusal without sleeping 40 s:
one clock advanced 20 s per read refuses the retry and rethrows the serialization error, the other
advanced 100 ms keeps retrying and succeeds on the third attempt.

**R15-8, R15-9, R15-12 — closed elsewhere, verified here.** The three findings this doc produced
but never owned are fixed in the docs that own them: the receipt derives its claim from the
settled stake's rank rather than from the act of paying (`emails/receipt.tsx:29-46`,
`receiptSubject` taking `rank`, `10` §7 R10-3 with `04` R04-1/R04-2), the hold has
`09` §7 R09-1/R09-2 behind it, and the orphaned `pending` payments have `06` §7 R06-7, `08` §7
R08-5 and `12` §7 R12-5 behind them. §6's after-fix table records the same three as unchanged by
this pass. R15-9's remaining question is a product decision about the TTL, not an
implementation one, and stays §9 Q2.

**R15-10 — the shell says what it is, and an unknown symbol stops pretending.** Two changes in
`app/elements/[sym]/page.tsx`. First, `if (!el) notFound()` immediately after the canonicalising
redirect: an unknown symbol used to fall through to a shell that rendered *a real element's*
name and symbol (the build-time SEO shell exists for valid symbols only), so a typo could be
answered with a page about an element, and — with a stale ISR copy — keep being answered that way.
Second, the fallback shell is now honest and logged: the read's `catch {}` became
`catch (err)` setting `dbFailed`, logging `{"scope":"page","page":"element","symbol":…,"reason":…}`,
and rendering "Live standings are temporarily unavailable. Reload in a moment — the table itself
is still up." A stale copy of the shell now *says* it is a stale copy of the shell instead of
rendering as a page. What this pass deliberately did not do is give the route an explicit
`s-maxage`: the window is 60 s and the homepage's is `s-maxage=31536000`, so the direction of
travel is settled and the *policy* is §9 Q4's, owned by `12`. The rationale is now a comment
above `export const revalidate = 60` rather than tribal knowledge.

**R15-11 — the product measures itself now, in two places.** (1) `lib/route.ts` logs one line per
**origin** invocation from inside `withContract`:
`{"scope":"api","id":…,"method":…,"path":…,"status":…,"ms":…}` — on the success path and on the
error path, so the 503s of §5.10 are measured too, and with the *path only*: query strings on this
site carry secrets (`?token=`, `?me=`), and the path is the half that pairs with a route file in a
grep. It is deliberately `console.log` and not a counter store: a counter table would put write
load on every read to answer a question the log already answers. The log lines are visible in the
suite output, which is the evidence they fire for real requests:
`{"scope":"api","id":"d5d23a78-…","method":"GET","path":"/api/activity","status":200,"ms":1}`.
(2) `/api/jobs/config` — the route `13` built as the one dependency-free surface an operator
already polls — now carries a `cost` block: `settlements: { day, week }` (PAID payments by
`appliedAt`), `outboxDue` (the depth the worker is behind on), and `analyticsRows` (the
`STAKE_ANALYTICS` trail nothing prunes). Best-effort like its `mail` and `heartbeats` neighbours —
a database that cannot answer leaves it `null` rather than turning the report into a 500 — and
database-only by construction: the production arm of `lib/ops.test.ts` stubs `fetch` to throw, so
nothing network-facing was added to a route whose point is to answer when other dependencies are
down. Two numbers are deliberately absent, because the product cannot see them: platform
invocations and ISR writes are the host's to count (`U15-8`), and pretending otherwise would be a
worse failure than the one this finding describes. The cost of the instrumentation is one log line
per origin invocation — the minority of traffic, since the CDN absorbs the rest — and the escape
hatch, if that volume ever matters, is sampling by request id, not removing the measurement.

**R15-13 — fixed in part: the growth is now visible, the retention is still `12`'s.** The
per-settlement arithmetic was confirmed, not disputed (11 rows across 8 tables is what the
transaction writes, and `OutboxEvent` is the largest single object at 256 kB / ~280 rows, §5.9).
What this pass adds is the count: `analyticsRows` on `/api/jobs/config` is the exact size of the
one trail that is neither money nor mail — `STAKE_ANALYTICS` rows are written per settlement and
never read, because their handler is a deliberate no-op that marks them complete (`lib/outbox.ts`).
The retention statement itself is untouched and stays where the finding's own owner column puts it,
`12`; and the "three outbox rows where one would do" suggestion is not safe to take here: that row
is a deliberate roadmap placeholder for a sink that does not exist yet, while `Payment`,
`AuditLog`, `ActivityLog` and `ProviderEvent` are the financial and audit history the product's
own erasure path (`14`) treats as non-deletable. So the honest status is *fixed in part*:
observable now, trimmed when `12` states a window.

**Evidence corrected by this pass.**

| # | What §5/§7 recorded on 2026-09-15 | What the source and this pass's reads show |
| --- | --- | --- |
| R15-2 | "the emitted `index.html` contains exactly one `<link rel="preload">` — the webpack runtime", hence "never preloads its own font" | **Two font preloads**, emitted by `next/font/google` in `app/layout.tsx`: `<link rel="preload" href="/_next/static/media/bca7023bf625e650-s.p.woff2" as="font" crossorigin="" type="font/woff2"/>` and the same for `ee40bb094c99a29a-s.p.woff2`, plus the webpack runtime's `fetchPriority="low"` script preload — three `rel="preload"` tags, not one |
| R15-2 | "152 kB document" (read as the wire cost) | 152,028 B is the **uncompressed** document; the same emitted file is **11,620 B** at brotli quality 11. The remaining size claim is about inventory-scaled markup, and it is §9 Q1's subject |
| R15-4 | "`EXPLAIN … Seq Scan on "Element" … Filter: "isLeader"`"; "neither tab bounds its read with `take`" | `isLeader` is a `Stake` boolean (`prisma/schema.prisma:159`); `/api/board` issues no query against `Element`, and `by-element` has had `take: 20` since it was written (`app/api/board/route.ts:54`). The real part of the finding — no index on the predicate — is fixed by `0011_leader_index` |
| R15-13 | "nothing trims them" (all five tables) | True as a statement, and unchanged by this pass; the tables are not equivalent — only `OutboxEvent` is trim-able without deciding against a money/audit record the product already treats as permanent, which is why this closes as *fixed in part* |

**Verification** (2026-09-16, this pass): `npx tsc --noEmit` clean · `npx eslint lib app emails
scripts` clean · `npx prisma format --check` "All files are formatted correctly" and `npx prisma
validate` "valid" · `npm run audit:prod` "no unaccepted high/critical runtime advisories" · the
database suite `53 files / 799 passed / 0 skipped` (791 before this pass) against the review
container, now carrying all twelve migrations including `0011_leader_index` · the database-less arm
`46 files / 669 passed / 130 skipped` · the production-config gate in both arms (complete config →
`production config OK.`, exit 0; `EMAIL_FROM` removed → exit 1; non-production →
`env=development, not production — skipping.`, exit 0) · `0011_leader_index` verified directly:
`pg_indexes` reports `Stake_isLeader_amountUsd_idx` as `("amountUsd" DESC) WHERE ("isLeader" =
true)`, and with `enable_seqscan=off` the planner chooses it for the `isLeader` predicate. Two
files of the existing suite moved with the code they pin: `lib/a11y.test.ts` re-lists
`/s/[domain]` as a page with two `id="main"` branches, and `lib/detailFace.test.ts`'s R04-4
assertions follow the element page's `if (!el) notFound()`. One new describe block with four tests
was added (`lib/boundaries.test.ts`), and the two routes this pass touched that carry a
contract — `/api/activity` (R15-5) and `/api/board` (R15-4) — are asserted by the phase-11 and
phase-12 suites unchanged.

## 6. Failure and edge matrix

Rows are situations; "distinguishable" asks whether the *customer* can tell this from the intended behaviour, and "who finds out" asks whether the product tells anyone.

| Situation | What happens, measured | Distinguishable from intent? | Who finds out |
| --- | --- | --- | --- |
| Database unreachable, payments **off** (the launch state) | checkout → `403 {"error":"Payments are paused — join the waitlist.","waitlist":true}` in 58 ms (§5.8, §5.10) | **No** — identical to the intended pause | nobody |
| Database unreachable, payments **on** | checkout → `500`, **0 B**; nine other surfaces likewise 0 B (§5.10) | yes, as an unexplained blank | nobody; log counts models, not requests |
| Stripe rejects the credential | `502 {"error":"Payment provider unavailable. Try again."}` in 805 ms cold / 104–128 ms warm; **3 `Payment` rows left `pending` with `providerRef = NULL`, no `ProviderEvent`** (§5.8) | yes — honest sentence, no charge | nobody; the rows are invisible to both pollers (R15-12) |
| Stripe slow / briefly 5xx | **UNKNOWN** (§5.10, U15-4) | — | — |
| Database *slow* rather than gone | the settlement transaction waits up to `maxWait` 15 s, runs to 25 s, retries up to 10 times (`lib/txn.ts`); a customer can wait the whole ceiling | after the ceiling, a blank 500 | nobody |
| Resend unset (this checkout) | mail takes the "logged" branch: `EmailLog.status = logged`, **nothing sent**, all 128 measured rows are `logged` (§5.10) | **No** — the row looks handled | nobody |
| Resend slow or 5xx | inline drain bounded at 15 s (`SETTLE_MAIL_DRAIN_BUDGET_MS`), remainder stays queued for `13`'s cron; a *slow* send's effect on a 30 s function is U15-5 | for the customer: the receipt arrives late or never | cron logs a failure count, not an alarm |
| Upstash unset (this checkout) | every rate limit is an in-process `Map` that fails open (`14` R14-2) | no | nobody |
| Platform kills a webhook mid-drain | settlement is already committed; `ProviderEvent` makes the retry idempotent; Stripe retries; outbox re-sends the mail (§5.11) | no — money is safe, mail is late | nobody directly |
| 13 buyers settle one element at once | **13 × `200 paid`**, p95 and max 3,773 ms, mean 2,278 ms (§5.9) | no — the tail is latency only | nobody |
| 8 buyers take one element at once, same amount | 8 × `200 paid`, and **all 8 receipts say "You're #1 in Ac"** (`emails/receipt.tsx:17,25`) | **No** — and it is wrong for 7 of them | nobody; `10`/`04` own the copy (R15-8) |
| One buyer opens a checkout and abandons it | 12/12 competitors refused in 47–91 ms until `RESERVATION_TTL_MS` (15 min) expires (`lib/reservations.ts:14-20`) | yes — they are told the conflict | nobody |
| 5 checkouts from one IP in an hour | `429` after the fifth (`14` R14-2) | yes | nobody |
| CDN cold, 1,000 readers | ≤ 18 origin reads/minute for the three read surfaces (§5.13, arithmetic) | no | nobody |
| Element page prerendered while the database was down | the **11,778 B fallback shell** is served `x-nextjs-cache: STALE`, then `HIT`, and/or out of an `s-maxage=31536000` copy (§5.1, §5.7) | **No** — it renders as a page | nobody (R15-10) |
| Every symbol revalidated every minute | up to 175,680 ISR writes/day = 5.27 M/month, ≈ \$20 over the included 200 k (§5.12) | no | the invoice |
| A slow device on the 122-tile grid with camera animations | **UNKNOWN** — needs a device profiler (U15-7) | — | — |

**After the fix pass (§5.14).** Four rows of the table above changed shape, and the "who finds out"
column changed for the rows that used to answer *nobody*. What deliberately did **not** change: the
launch-state `403`, Stripe's `502` and its three orphaned `pending` rows, the Resend `logged`
branch, the failing-open rate limits, the 13-buyer latency tail, and the unset-Upstash behaviour —
this pass adds no caching to a write path and no queue to a read path.

| Situation | What happens now | Distinguishable from intent? | Who finds out |
| --- | --- | --- | --- |
| Database unreachable, payments **on** | every API route answers `503 {"error":"Service unavailable."}` — the `CONNECTIVITY` classifier in `lib/route.ts` turns a dead pool or unreachable host into a JSON body, where §5.10 recorded 0-byte bodies on the ten API surfaces it drove. `/s/[domain]` answers the product's own profile shell and `/elements/[sym]` its labelled standings shell. *Not re-read live: nothing was deployed, so §5.10's readings stand as the last measurement of a real outage* | yes — but it is now a sentence the product wrote, not a blank | **yes:** one `{"scope":"api",…,"status":503,"ms":…}` line per origin request (R15-11) |
| Database *slow* rather than gone | the settlement transaction still waits `maxWait` 15 s and runs to 25 s, but the retry loop now stops at a 40 s wall-clock budget (`TXN_BUDGET_MS`) instead of grinding through the ceiling | yes, and sooner: `502` with a code rather than a blank `500` after ~250 s | **yes:** the `budget-exhausted` warn line names the scope and the elapsed attempt |
| Element page prerendered while the database was down | the shell still serves, but it now says "Live standings are temporarily unavailable. Reload in a moment — the table itself is still up." and logs the reason; an unknown symbol is a real `404` instead of a page about an element | **yes** — the page tells you it is a degraded copy, where §5.7 read a bare "no live data yet" | **yes:** `{"scope":"page","page":"element","symbol":…,"reason":…}` |
| Any read burst on the three read surfaces | unchanged for the CDN origin (§5.13's ≤ 18 reads/minute), but a repeat within 5 s is answered from the browser cache instead of a request, and any origin request that does arrive is logged with its path, status and duration | no | **yes**, for the origin half |

The rows still marked **UNKNOWN** in §5.10 (U15-4's slow Stripe, U15-5's slow Resend) and §5.1
(U15-7's animation profile) stay UNKNOWN: none of them can be closed without a deploy, a live
credential, or a device profiler, and inventing a number for them would be worse than the gap.

## 7. Findings

### R15-1 — The browser is never allowed to cache anything; the CDN's 10 s window is the only absorber

**Severity** P2 · **Category** performance / capacity
**Evidence** Every document and read API is `max-age=0, must-revalidate` or `no-store`; the read APIs add `s-maxage=10, stale-while-revalidate=30` (`lib/route.ts:20-32`). Production `/` reads `public, max-age=0, must-revalidate` with `age: 7567` (§5.3). Client polling continues every 30 s (`05` §9 Q2).
**Reproduction** `curl.exe -sS -D - -o NUL https://www.periodictable.lol/`; compare with the same request for `/api/stats`.
**Proposed fix** Either raise the browser window for the *static* parts of a document (they carry no live numbers) or use `stale-while-revalidate` on the client's SWR revalidation so a reader's re-poll is answered from the edge without an origin round trip. Not a correctness change: the live numbers keep their 30 s cadence.
**Status** open
- **Fix.** `READ_CACHE` (`lib/route.ts:45-49`) now answers `public, max-age=5, s-maxage=10, stale-while-revalidate=30` — a browser window sized *under* the 30 s poll interval every consumer of these routes uses — and the doc-comment paragraph claiming the edge rewrites the browser directive was deleted, because it no longer described the code beneath it. `lib/readCache.test.ts` asserts the inequality against the client's own literal and fails on any three-digit `max-age`. The two OG card routes were audited and left CDN-only.
- **Status.** fixed — the browser no longer asks the origin for a copy the next poll is about to replace (§5.14).

### R15-2 — `/` ships 152 kB of uncompressed document and never preloads its own font

**Severity** P2 · **Category** performance
**Evidence** `/` = 12 referenced assets, 608,994 B raw / 181,000 B gzip / **157,366 B brotli**; the document is 151,478 B in the build and `content-length: 152029` in production; fonts add up to 68,856 B for the four `basic-latin` subsets, and the emitted `index.html` contains exactly one `<link rel="preload">` — the webpack runtime with `fetchpriority="low"` (§5.1, §5.4).
**Reproduction** Byte-budget script over `.next/` (raw + `zlib.gzip`/`brotliCompressSync` of each referenced file); `grep -c '<link rel="preload"' .next/server/app/index.html`.
**Proposed fix** Preload the one display-face woff2 the LCP block actually uses (or `font-display: swap` on it alone), and consider a smaller above-the-fold document: the table markup is 151 kB for 122 cells today and scales with the inventory.
**Status** open
- **Fix.** None, and the two premises were re-read rather than accepted: `app/layout.tsx` is `next/font/google` (Fredoka + Nunito), so the build emits **two** `<link rel="preload" as="font" crossorigin type="font/woff2">` tags for the self-hosted faces — not "exactly one preload, the webpack runtime" — and `content-length: 152029` is the **uncompressed** document, which is 11,620 B at brotli quality 11. Both corrections are in §5.14 with the bytes they came from.
- **Status.** wontfix — the preload already happens (framework-emitted), and the size that remains is inventory-scaled markup, which is §9 Q1's product decision rather than a source change (§5.14).

### R15-3 — A database outage is a blank screen, and with payments off it is indistinguishable from the launch pause

**Severity** P1 · **Category** resilience / operations (the missing error node is `11` §5.14, `14` §5.7)
**Evidence** With the database unreachable: `/api/stats`, `/api/board`, `/api/activity`, `/api/elements/Ts`, `/api/table-order`, `/api/search`, `/api/report`, `/api/waitlist`, `/api/manage/request`, `/api/admin/reports`, `/api/jobs/reconcile` and **`/api/checkout`** all answer `500` with a **0-byte body**; `/s/linear.app` answers a 6,560 B Next error document; with `PAYMENTS_LIVE` unset the checkout guard answers the intended `403 Payments are paused — join the waitlist.` before any query, so an outage and a commercial pause are the same words (§5.10). The log for the whole exercise has no request id and no path (§5.10).
**Reproduction** Serve the production build with `DATABASE_URL` pointed at a closed port and issue the requests in §5.10's table; `curl.exe -sS -o NUL -w "%{http_code} %{size_download}"`.
**Proposed fix** A minimal error node on every JSON route (`11` R11-4 owns the shape) with a distinguishable status/`code`, and — for the checkout specifically — never a blank answer to "did I pay": `14` R14-1's fail-closed answer is already correct, it just needs to be reachable when the database, not the flag, is what failed.
**Status** open
- **Fix.** The page half, which was the remaining half: `app/s/[domain]/page.tsx` routes both reads through one `loadProfile()` helper, `generateMetadata` catches and answers a generic title instead of throwing through the metadata pass, a missing/empty/hidden profile is still a real `404` (`if (!dbFailed) return notFound()`), and a read that *threw* renders the product's own shell while logging `{"scope":"page","page":"profile","where":…,"domain":…,"reason":…}`. The API and checkout halves were already closed by phase 11's route boundary (`11` R11-3, all 28 routes), which classifies a connectivity throw as `503 {"error":"Service unavailable."}` and logs the request with an id and a path.
- **Status.** fixed — every surface in the evidence now answers a JSON body with a code or renders a page that says what happened, and the outage log names the path (§5.14).

### R15-4 — Two of three board tabs scan `Element` for a flag with no index and no `take`

**Severity** P3 · **Category** performance / query design
**Evidence** `EXPLAIN (ANALYZE, BUFFERS)` on the `isLeader` filter: `Seq Scan on "Element" … Buffers: shared hit=2` at 122 rows; the `by-element` tab scans the same relation. `12` R12-6 records that the only partial index in the schema covers the other flag. Neither tab bounds its read with `take` (§5.6).
**Reproduction** `EXPLAIN (ANALYZE, BUFFERS) SELECT … FROM "Element" WHERE "isLeader" LIMIT …` against the review container.
**Proposed fix** A partial index mirroring the one that exists (`12` R12-6), and a `take` on the element scan in both tabs. Cheap now, and the inventory is the one dimension the product plans to grow.
**Status** open
- **Fix.** `prisma/migrations/0011_leader_index` adds the partial index `Stake_isLeader_amountUsd_idx` — `("amountUsd" DESC) WHERE "isLeader" = true`, so it serves both `crowns` and `by-element` — hand-written because `migrate diff` cannot express a partial index, applied to the review container and read back from `pg_indexes` by `lib/schema.test.ts`. The `take` half is **refused in place**: `crowns` and `early` aggregate over *all* rows and rank after aggregating, so a `take` would truncate the input and silently undercount crowns and medals. §5.14 also corrects the evidence — `isLeader` is a `Stake` column (`prisma/schema.prisma:159`), `/api/board` never reads `Element`, and `by-element` has had `take: 20` (`app/api/board/route.ts:54`) since it was written.
- **Status.** fixed — the unindexed predicate is indexed and asserted by the suite; the `take` suggestion is declined with its reason in the code and in §5.14.

### R15-5 — `/api/activity` is five round trips and its inner lookups are unbounded by the caller's `limit`

**Severity** P2 · **Category** performance
**Evidence** `/api/activity` issues **5 statements** and joins 14 relations for one request; 27 ms at `limit=6`, 77 ms at `limit=20` — the only read whose cost a caller controls. No `.take()` bounds the inner lookups (§5.5).
**Reproduction** Statement counters and the two timings in §5.5; `EXPLAIN` on the extracted query.
**Proposed fix** Add explicit `take` ceilings on the inner lookups (the outer `limit` is not one) or denormalize the feed the way `12` §5.8 denormalizes the board.
**Status** open
- **Fix.** `app/api/activity/route.ts` is now a single `prisma.$queryRaw` instead of five statements. The hidden-domain exclusion moved inside the query as `WHERE NOT EXISTS (…)` — before `LIMIT`, so the page size the caller asked for is the page size it gets, where the old shape materialised an unbounded domain array and filtered in memory — and the stake lookup rides the join, bounded by the unique `(domain, symbol)` pair rather than by an invisible `.take()`. `$queryRaw` is the established instrument here (`lib/outbox.ts`, `lib/erasure.ts`) and keeps the route safe under transaction-mode PgBouncer (`12` R12-5). The response shape is unchanged: `lib/routes.test.ts` and `lib/moderation.test.ts` assert the same rows, including that a hidden domain's activity stays out of the feed.
- **Status.** fixed — one round trip, no unbounded inner read, same contract (§5.14).

### R15-6 — The money path is the one route a paying reader can cold-start

**Severity** P2 · **Category** performance / money path
**Evidence** First request after server start with the provider configured: **805 ms**; warm 56–128 ms. With no provider configured the same route answers in 58 ms because the gate short-circuits before the query (§5.8).
**Reproduction** `next start` with a fabricated Stripe pair, then time the first `POST /api/checkout`.
**Proposed fix** Nothing structural: this is a fraction of the 6.3%-of-ceiling tail already measured, and Vercel keeps functions warm under traffic. Recorded so that the *first* paying reader's experience is a known number rather than a surprise, and so a launch-day warm-up request is an available lever.
**Status** open
- **Fix.** Nothing structural, exactly as the proposed fix said. What changed is that the number no longer rests on a hand-timed probe: every origin invocation logs its duration, status and path (`15` R15-11), so the next cold start is a log line rather than a measurement exercise.
- **Status.** accepted-risk — 805 ms on the first request after a start, against 56–128 ms warm; recorded as a known number with a known lever, not as a defect (§5.14).

### R15-7 — Thirteen simultaneous settlements on one element all succeed, with a 3.8 s tail; the retry budget exceeds the function ceiling by 4×

**Severity** P2 · **Category** concurrency / money path (`08` owns settlement semantics)
**Evidence** 13 concurrent settles on `As`: **13 × `200 paid`**, min 681 ms, median 2,480 ms, p95 = max **3,773 ms**, mean 2,278 ms; uncontended pair 223/251/350 ms. Inside the invocation, `MONEY_TX` allows 25 s per attempt and `TXN_MAX_ATTEMPTS = 10`, i.e. **250 s of retry budget against `maxDuration = 60`** (`app/api/webhooks/stripe/route.ts:21`); no attempt checks the remaining time (§5.9, §5.11).
**Reproduction** Node script firing 13 distinct checkout+settle pairs at one symbol; wall-clock per pair.
**Proposed fix** The measured case is 6.3% of the ceiling and needs nothing; the arithmetic case is safe but wasteful (a platform kill costs mail, not money, because the settlement commits first and `ProviderEvent` makes the retry idempotent). A deadline check between attempts would make the *stated* worst case honest.
**Status** open
- **Fix.** `lib/txn.ts` gained `TXN_BUDGET_MS = 40_000` and a check inside `withTxnRetry` that refuses another attempt when `elapsed + ATTEMPT_RESERVE_MS > budgetMs` (`ATTEMPT_RESERVE_MS = MONEY_TX.timeout`, so a retry starts only if a whole attempt still fits), rethrowing the retryable error it already holds after logging `{"scope":"txn","msg":"budget-exhausted",…}`. 40 s of the 60 s ceiling leaves 20 s for the surrounding work, and checkout needs no new handling — it answers `502` with a code, Stripe redelivers, and `ProviderEvent` plus the payment guard keep the re-run idempotent. Two tests in `lib/ledger.test.ts` prove the refusal and the still-retries case with an injected clock, so neither sleeps.
- **Status.** fixed — the *stated* worst case is bounded by the function's own ceiling instead of 4× it; the measured case (p95 3,773 ms) needed nothing and is unchanged (§5.14).

### R15-8 — Eight equal-amount winners on one element are all told they are #1

**Severity** P1 · **Category** money path / copy — **owned by `10` and `04`** (`10` §7 R10-3 the copy, `09` §7 R09-2 the silent expiry, `04` §7 R04-1/R04-2 the quote), recorded here because this doc produced the concurrency that exposed it
**Evidence** 8 simultaneous $60 checkout+settle on `Ac`: **8 × `200 paid`**, and every receipt renders the unconditional subject/h1 "You're #1 in Ac (Actinium) 🎉" (`emails/receipt.tsx:17,25`; enqueue at `lib/settle.ts:206-220,282`). `OutboxEvent` holds only 4 `OUTBID_EMAIL` rows in total, so the displaced leaders are not being told either (§5.9; `11` §5.11).
**Reproduction** §5.9 row 3.
**Proposed fix** Derive the receipt's claim from the settled `Stake` position (or the `FirstClaim` row) rather than from the act of paying. This is batch 2's, not new behaviour: `04` §7 R04-1/R04-2 owns quote derivation and `10` owns mail content.
**Status** open
- **Fix.** Landed in the docs that own it: `emails/receipt.tsx` now takes a `rank` prop derived from the settled `Stake` and `receiptSubject` reads `p.rank ?? 1`, so the claim follows the buyer's position rather than the act of paying (`10` §7 R10-3, `04` §7 R04-1/R04-2). The second half of the evidence — that displaced leaders are told — is `10`'s notice question, not this doc's.
- **Status.** fixed (`10`, `04`) — verified in the file during this pass; no change was needed or made here (§5.14).

### R15-9 — One abandoned checkout freezes every competitor on that element for fifteen minutes

**Severity** P1 · **Category** concurrency / money path (`09` owns ownership and competition; §7 R09-1 owns the hold itself)
**Evidence** With one unpurchased hold live, **12/12** competing take-quotes were refused in 47–91 ms with `RESERVATION_CONFLICT`, and the positive control (no live hold, 8 simultaneous quotes) produced `200` × 1 / `409` × 7 in 211–466 ms. The hold lives until `RESERVATION_TTL_MS = 15 min` (`lib/reservations.ts:14-20,34-49`; §5.9).
**Reproduction** §5.9 rows 1–2.
**Proposed fix** Batch 2's territory (`09`): shorten the hold, extend it only on evidence of an in-flight payment, or let a competitor join a queue for the element instead of being refused. The performance-relevant fact is that a single customer's inaction is a full-product outage *for that element*, at the product's most interesting moment.
**Status** open
- **Fix.** None here, and none claimed: the hold's existence and duration are `09`'s ownership decision (`09` §7 R09-1/R09-2), which this doc's own proposed fix acknowledges. Nothing in the pass shortens, extends or queues around `RESERVATION_TTL_MS`.
- **Status.** open (`09`) — the performance fact stands: one customer's inaction is a full-product outage for that element for up to fifteen minutes (§5.14).

### R15-10 — The element page served by the CDN can be the no-database shell

**Severity** P1 · **Category** correctness made invisible by caching (`11`/`12` own the contract)
**Evidence** The build emits `Ts.html` at **13,259 B** with the database reachable, yet the running production-mode server answers **11,778 B** for `/elements/Ts` with `x-nextjs-cache: STALE` — the fallback shell `app/elements/[sym]/page.tsx:53-80` returns when its own query fails — and `/` carries `s-maxage=31536000` while element pages revalidate at 60 s (`app/elements/[sym]/page.tsx:10`; §5.1, §5.3, §5.7).
**Reproduction** Compare `.next/server/app/elements/Ts.html` with the served body and its `x-nextjs-cache` header (§5.1).
**Proposed fix** Make the fallback shell say so (or fail the route) rather than render as a page, and give the element route an explicit `s-maxage` so its document lifetime matches its data lifetime. `12` §5.x settles what the contract should be.
**Status** open
- **Fix.** `app/elements/[sym]/page.tsx`: `if (!el) notFound()` immediately after the canonicalising redirect, so an unknown symbol can never be answered by a shell describing a real element; the read's `catch {}` became `catch (err)` setting `dbFailed` and logging `{"scope":"page","page":"element","symbol":…,"reason":…}`; and the fallback shell now says "Live standings are temporarily unavailable. Reload in a moment — the table itself is still up." A stale copy of the shell now *says* it is a stale copy of the shell. No explicit `s-maxage` was added to the route: the document/data lifetime policy is §9 Q4's, owned by `12`, and the rationale for the existing 60 s window is now a comment above the directive.
- **Status.** fixed in part — the shell identifies itself and unknown symbols `404`; the window mismatch stays §9 Q4's (§5.14).

### R15-11 — Nothing in the product measures itself, so nothing about cost or degradation is visible until an invoice or a customer

**Severity** P1 · **Category** operations / cost
**Evidence** No route reports its own duration, no counter records a cost driver, and the only budget-shaped control in the repository is the advisory expiry (`14` R14-11); the log has no request id and no path even for a total database outage (§5.10). The cost model in §5.12 is therefore invisible in operation: total spend, per-settlement writes, ISR write volume and mail volume are all unmeasured at runtime.
**Reproduction** `grep` for `performance.now|Date.now()` around response construction in `app/api/**/route.ts` — none; `13` §5.9's `/api/jobs/config` reports configuration, not cost.
**Proposed fix** A single `/api/jobs/config`-style operator surface extended with the four numbers that matter (invocations, settlements, outbox depth, ISR writes) or the cheapest alternative: a Vercel/Neon alert on spend and on 5xx rate, which needs no code change at all.
**Status** open
- **Fix.** Both halves of the proposed fix that live in this repo. (1) `withContract` (`lib/route.ts`) logs one line per origin invocation — `{"scope":"api","id":…,"method":…,"path":…,"status":…,"ms":…}` — on the success path *and* the error path, with the **path only**, because query strings on this site carry secrets (`?token=`, `?me=`). The line renders in the suite's own output, which is the evidence it fires for real requests. (2) `/api/jobs/config` carries a best-effort `cost` block — `settlements.day` / `.week`, `outboxDue`, `analyticsRows` — that stays `null` when the database cannot answer, so the operator surface does not become a 500 during the outage it exists to report. Two numbers are deliberately absent because the product cannot see them: platform invocations and ISR writes are the host's (U15-8), which the code says rather than implies. The escape hatch if log volume ever matters is sampling by request id, not removing the measurement.
- **Status.** fixed — duration, status and the main cost drivers are visible in operation, without a dashboard and without a new dependency in the outage path (§5.14).

### R15-12 — A provider rejection leaves orphaned `pending` payment rows that no poller can see

**Severity** P1 · **Category** money-path integrity — **owned by `07`/`08`** (batch 2: `06` §7 R06-7 owns the buyer-side half, `08` §7 R08-5 the unreachable `CANCELED` status); reported here because the failure injection that produced it is this doc's
**Evidence** Three attempts against a rejecting provider left **three `Payment` rows with `status = pending`, `providerRef = NULL`, `path = join`, `provider = stripe`** and **no `ProviderEvent`**: the idempotency replay consumed the same key without adding a row. `13` shows both pollers driven by `ProviderEvent`, so these rows are invisible to the queue and only `reconcile` could ever close them. The customer is not charged and the error is honest — the residue is the issue (§5.8).
**Reproduction** §5.8: checkout with `PAYMENTS_LIVE=true` and a fabricated `STRIPE_SECRET_KEY`, then inspect `Payment` and `ProviderEvent`.
**Proposed fix** `07`'s ledger decision: either write a compensating terminal status on provider rejection, or emit the `ProviderEvent` that makes the attempt visible to the existing pollers instead of introducing a new one.
**Status** open
- **Fix.** Landed in the docs that own the ledger: `06` §7 R06-7 (the buyer-side half of orphaned `pending` payments), `08` §7 R08-5 (the unreachable `CANCELED` status) and `12` §7 R12-5 (the reconciliation that closes them).
- **Status.** fixed (`06`, `08`, `12`) — no change here; the three rows this doc's failure injection produced are closed by the same transaction decision (§5.14).

### R15-13 — Every settled dollar writes eleven rows across eight tables, and nothing trims them

**Severity** P2 · **Category** cost / data growth (`12` owns retention)
**Evidence** Per first-time settlement: `Startup` +1, `Stake` +1, `Payment` +1, `OutboxEvent` **+3** (`analytics-`, `preview-`, `receipt-` prefixed `dedupeKey`s), `AuditLog` **+2**, `EmailLog` +1, `ActivityLog` +1, `ProviderEvent` +1, `FirstClaim` +1, plus the `Element` aggregate update — confirmed by a 15-table `pg_stat_user_tables` diff and by ten further pairs (§5.9). Net database growth **5.6 kB per settlement**, of which `OutboxEvent` is the largest single object (256 kB / ~280 rows). No retention window exists for `OutboxEvent`, `AuditLog`, `EmailLog`, `ActivityLog` or `ProviderEvent` (`12` §5.x / U12).
**Reproduction** Snapshot-diff `pg_stat_user_tables` around one settle pair (§5.9).
**Proposed fix** At 1,000 checkouts/day this is 168 MB/month and 330,000 rows/month, so it is not urgent — but the growth is permanent and the read surfaces that touch these tables (`/api/activity`) already cost five round trips. A retention statement belongs with `12`'s PII work; a cheaper item is not writing three outbox rows where one would do.
**Status** open
- **Fix.** The growth is now countable, and nothing was trimmed: `analyticsRows` in `/api/jobs/config`'s `cost` block is the exact size of the one trail that is neither money nor mail — `STAKE_ANALYTICS` rows, written per settlement and never read, because their handler is a deliberate no-op that marks them complete (`lib/outbox.ts`). No retention window was invented here, because the tables are not equivalent: `OutboxEvent`'s analytics row is a roadmap placeholder for a sink that does not exist yet, while `Payment`, `AuditLog`, `ActivityLog` and `ProviderEvent` are the financial and audit history the erasure path (`14`) already treats as non-deletable.
- **Status.** fixed in part — observable now, trimmed when `12` states a retention window (§5.14).

## 8. Acceptance criteria

- [x] Byte budget for `/` and one element page, with the compression used stated (608,994 / 157,366 B and 493,622 / 129,060 B) — §5.1, §5.4.
- [x] A cold 4G number is **either measured or labelled as arithmetic**, and the missing field measurement is an UNKNOWN row — §5.2, U15-1.
- [x] Production cache headers read from the live origin, not assumed — §5.3.
- [x] Query shape and row count recorded for every read surface in scope, with the instrument named — §5.5, §5.6.
- [x] Cache policy and staleness window compared per surface, including the two different document lifetimes — §5.3, §5.7.
- [x] Concurrency exercise on one element produced by this doc, with winners, losers and latencies — §5.9 (8-way quotes, 8-way land rush, 13-way settles).
- [x] Dependency failure injected and the customer-visible result recorded per route — §5.10 (14 surfaces, two provider states).
- [x] Settlement worst case stated against `maxDuration`, separating measured from arithmetic — §5.11.
- [x] Cost model at 10 / 100 / 1,000 checkouts per day, with the measured inputs it rests on — §5.12.
- [x] Every provider rate labelled as a third-party summary rather than a reading — §5.12, U15-6.
- [x] A stated launch-day ceiling, with what would falsify it — §5.13.
- [x] No measurement presented as a Lighthouse or field-CWV score — probe table, §5.2.
- [ ] **A real cold-4G field measurement (LCP/INP/CLS) for `/` and one element page** — U15-1.
- [ ] **A load measurement above 13 concurrent requests** — U15-2.
- [ ] **Neon's contribution to cold start and the pooled-connection ceiling** — U15-3.
- [ ] **Stripe's own failure branch (5xx/timeout) and its fee schedule** — U15-4, U15-6.
- [ ] **A device-profiled animation cost for the 122-tile grid** — U15-7.

Budget: **13 of 18 met at `9681bdc`**; the five open rows are the five UNKNOWN log entries, each with a settling command.

**After the fix pass (§5.14).** No box changed state, and the reason is structural rather than a
missed item: all five open boxes are *measurements*, and §5.14 adds no measurement — it adds the
instrument that makes three of them cheaper to take. The per-invocation log answers "what was the
production 5xx rate" from the application side (U15-9), the `cost` block narrows U15-8 from
"invisible" to "countable from the app plus the host's own dashboard", and `TXN_BUDGET_MS` gives
U15-2's 5xx rate a stated ceiling to be measured against. The thirteen ticked boxes stay ticked:
nothing in the pass invalidated a reading, and the two evidence corrections in §5.14 (R15-2's
preload and brotli size, R15-4's `isLeader` column) re-read material this doc had recorded as a
reading rather than as an acceptance box. Of the eleven findings: six are fixed here (R15-1,
R15-3, R15-4, R15-5, R15-7, R15-11), two fixed in part (R15-10, R15-13), two closed by the docs
that own them (R15-8 → `10`/`04`, R15-12 → `06`/`08`/`12`), one declined with its premises
corrected (R15-2), one accepted-risk (R15-6), and one left open for `09` (R15-9).

## 9. Open questions

**Q1 — Should the prerendered `/` carry any live number at all?** Its document is 152 kB, cached for a year at the edge, and every number a reader actually reads arrives from three client fetches 157 kB later. If the numbers were server-rendered with a 60 s window, the reader would get one document and the JS bundle could shrink; if they stay client-side, `R15-1` is the wrong fix and the bundle is the real target. Owner: whichever doc owns the board's contract (`12`).

*Answered in part by the fix pass — in the negative, and that is worth stating plainly.* §5.14's
R15-1 fix sizes the browser window **under** the 30 s poll, which only makes sense if the numbers
stay client-side: the fix presumes the answer "no live number in the prerendered document" and
makes that choice cheaper to live with rather than moving it. The size half of the question is
untouched — §5.14's R15-2 correction shows the wire cost of the document is 11.6 kB brotli today,
so the "152 kB" figure is an uncompressed markup fact about an inventory that is 122 cells wide
and is the dimension the product plans to grow. Deciding between one server-rendered document and
a smaller client bundle remains `12`'s, and this pass did not make that decision harder.

**Q2 — Is the 15-minute hold a product decision or an implementation detail?** Measured, one abandoned checkout blocks every competitor on that element for the full TTL (`R15-9`). If the hold is meant to protect a buyer mid-payment, it should expire on evidence; if it is meant to be a soft lock, 15 minutes on the product's most interesting element is a long time. Owner: `09` (batch 2).

*Not this pass's, and it stays `09`'s.* Nothing in §5.14 touches `RESERVATION_TTL_MS`, and §5.14's
R15-9 entry deliberately declines to: the hold's existence and its duration are an ownership
decision, not a performance knob, and shortening it here would trade a measured refusal for an
unmeasured double-sale risk. The measured fact stands as the input that decision needs — one
customer's inaction is a full-product outage for that element — and the fix pass turned it into a
line in the log rather than a fact only this document knows.

**Q3 — What is the target for a *blank* answer?** Nine surfaces answer 500 with zero bytes (`R15-3`). The cheapest correct fix is one shared error helper (`11` R11-4); the question this doc cannot answer is which of those surfaces should instead answer *something useful* — a cached stale board is better than nothing for a reader, and nothing at all is worse than anything for a buyer. Owner: `11`, with `06` for the checkout specifically.

*Answered in part, and the part that was answerable is done.* The blank answer no longer exists on
any surface this doc measured it on: §5.14's R15-3 gave `/s/[domain]` a product-authored shell and
turned the API half over to `11`'s existing boundary (`503 {"error":"Service unavailable."}`, with
the request logged by path and status), and R15-10 gave the element page a shell that says it is
degraded plus a real `404` for an unknown symbol. What is *not* answered is the choice the question
actually asks — whether a reader is better served by a stale board than by an honest refusal, and
whether a buyer is owed a different answer than a reader. That is `11`'s, with `06` for checkout,
and the reason it is not settled here is that it is a product judgement about which wrong answer
is least misleading, not a defect to remove.

**Q4 — Should the ISR window be per-surface?** `s-maxage=31536000` on `/` and `revalidate = 60` on element routes mean two documents of the same product live for a year and a minute respectively, and the element one is the surface that must be fresh (§5.3, §5.7). One number, three surfaces, is worth a decision before launch because it is also the only line in §5.12 that can surprise on cost.

*Answered in part by the fix pass.* The direction of travel is now written down rather than
inferred: §5.14's R15-10 replaced the bare `revalidate = 60` with the rationale above it, and the
element route's degraded shell now says it is degraded, so a stale copy can no longer render as a
page about a live number — which was the half of this question that was a correctness problem.
The policy half stays `12`'s, and this pass adds one input to it: with `0011_leader_index` the two
leader tabs no longer scan, so the pressure to lengthen the window in order to protect the read
path is gone. Lengthening it to cut U15-8's ISR writes is a real trade against staleness, and it
is `12`'s to make with the invocation log's timings in front of them.

## 10. Cross-references

- `doc/review/00-REVIEW-PLAN.md` §2 "Batch 3 — the platform underneath" (this doc's spec, including the CWV, concurrency, failure-injection and cost lines) and §4 (the P0–P3 rubric applied in §7), §5 rows 11–15.
- `doc/review/TEMPLATE.md` — the 12 sections in order; §5's sub-sections carry the evidence the plan asks for.
- Batch 1, cited not re-reported: `04` §7 **R04-1/R04-2** (quote derivation in `lib/stakeQuote.ts`, `prices.boardComplete` — why §5.9's stake amounts are what they are), `05` §7 **R05-7** (the report/waitlist mail chain, its 3 s/5-row drain and the 04:00 cron retry — the drain §5.10 measured as `logged`), **R05-8** (`/pay/[paymentId]` gated by provider mode — the page in §5.2's last row), **R05-1/R05-4** (checkout error nodes, one per id, red-700 — the *front-end* half of R15-3), `05` §9 Q2 (the 30 s polling surfaces accepted as risk — the load input to §5.13).
- Doc 11 — **R11-3** (two error envelopes and the empty bodies R15-3 measures as 0 B), **R11-4** (the unthrottled admin/job/money routes), **R11-5** (`/api/report` answers `200` when limited), §5.15 (the production readings: `elementsTotal: 122`, the `X-Request-Id` asymmetry used in §5.3). Route contracts are doc 11's; this document measures their weight and their failure shape.
- Doc 12 — **R12-5** (the unconfigured Neon pool — the reason §5.13's ceiling is honestly unknown), **R12-6** (the one hand-written partial index, contrasted with R15-4's missing one), §5.4/§5.8 (index-versus-query-pattern and the denormalized aggregate trio, which §5.5's row counts corroborate), §5.14 and its UNKNOWN rows (PITR, the pooling ceiling this doc's U15-3 depends on).
- Doc 13 — **R13-4** (both workers' worst case *equals* `maxDuration`, the inverse of §5.11's finding), the `SKIP LOCKED` lease behind §5.9's "two drains claimed zero rows", and `/api/jobs/config` (the only dependency-free liveness surface in §5.10).
- Doc 14 — **R14-2** (limits fail open without Upstash — the reason §5.9 row 5's 429s are instance-local), **R14-11** (the advisory expiry, the only budget-shaped control in the repository per §3), §5.7/§5.11 (the reservation and error surfaces this doc times).
- Docs 06–10 (batch 2, not yet written): **07** owns the provider-attempt ledger behind **R15-12**, **08** owns settlement semantics behind **R15-7**, **09** owns ownership/competition behind **R15-9**, **10** owns the receipt copy behind **R15-8** (with `04`). Where this doc touches those subjects it says so and defers; nothing in R15-7/R15-8/R15-9/R15-12 is claimed as newly discovered behaviour.
- `doc/PROD-READINESS-CHECKLIST.md` — cited by section for secret inventory and environment expectations (including the empty `DATABASE_URL` read at `:196,436`), never restated.
- `doc/review/FINDINGS.md` — R15-1…R15-13 and U15-1…U15-9 are registered there in id order.

Added by the fix pass (2026-09-16, §5.14):

- `prisma/migrations/0011_leader_index/migration.sql` — the second hand-written partial index in the schema, alongside the one `12` R12-6 records (`ClaimReservation_elementId_active_key`), and asserted from `pg_indexes` by `lib/schema.test.ts` for the same reason that one is: `migrate diff` cannot express a partial index, so nothing else would notice its removal.
- `lib/txn.ts` **`TXN_BUDGET_MS`** — the repository's second budget-shaped control; the first is `14` R14-11's advisory expiry, and this doc's §3 noted its absence as the reason §5.11's worst case was arithmetic rather than bounded.
- The five test assertions this doc's findings produced: `lib/readCache.test.ts` (the cache window against the poll literal), `lib/ledger.test.ts` (the retry budget, both directions), `lib/schema.test.ts` (the index), `lib/boundaries.test.ts` (the two outage answers and their log lines), `lib/ops.test.ts` (the `cost` block's presence or `null`).
- The docs that took deferred items back rather than this one stretching to hold them: `10` §7 R10-3 (R15-8's receipt copy — now `rank`-derived in `emails/receipt.tsx`), `06` §7 R06-7 with `08` §7 R08-5 and `12` §7 R12-5 (R15-12's orphaned `pending` rows), `09` §7 R09-1/R09-2 (R15-9's hold, which §5.14 leaves untouched on purpose).

## 11. Change log

| Date | Change |
|---|---|
| 2026-09-15 | authored 2026-09-15 against `9681bdcbff2435ef258224c52000e0f8d6089f5c` |
| 2026-09-15 | §5.1–§5.4 written from the emitted build and the production-mode server; an earlier byte pass was discarded because it measured a development-server response |
| 2026-09-15 | §5.8–§5.9 contention figures re-taken after the first 8-way reading returned `500`s that were traced to the pre-fix build, not to the current one |
| 2026-09-15 | §5.10 rewritten as a full outage matrix against a dead `DATABASE_URL`, because stopping the container also stops the server under test |
| 2026-09-15 | §2, §4 and the probe table corrected where the fresh measurements superseded earlier claims (contention losers, the operator row, "no Stripe call can be made", the failure-recipe row) |
| 2026-09-15 | §4 port-attribution paragraph added: an earlier pass took figures from `:3212`, a sibling session's server; no figure in `11`–`15` comes from it |
| 2026-09-16 | §5.14 written — the fix pass for R15-1/R15-3/R15-4/R15-5/R15-7/R15-10/R15-11/R15-13, the refusal behind R15-4's `take` half, and two evidence corrections (R15-2's preloads and brotli size, R15-4's `isLeader` column); §6 gained the after-fix rows, §7 the `Fix.`/`Status.` pairs, §8 the budget note, §9 the four partial answers, §10 the "Added by the fix pass" block and §12 the in-cell annotations. Verification: `tsc` and `eslint` clean, `prisma validate` valid, 53 files / 799 passed / 0 skipped with the database, 46 / 669 / 130 without it, prod-config gate green in both arms |

## 12. UNKNOWN log

| Id | Unknown | What settles it |
| --- | --- | --- |
| U15-1 | Field LCP / INP / CLS for `/` and one element page on a cold 4G handset — the plan's own first line for this doc | CrUX dashboard or the PageSpeed Insights API for `https://www.periodictable.lol/`; `npx lighthouse https://www.periodictable.lol/ --preset=desktop --output=json --output-path=./lh.json` for a lab score. Needs no load I would have to generate |
| U15-2 | The real concurrency ceiling, i.e. how many simultaneous settlements one element tolerates on production infrastructure | A staging deployment with production-shaped data plus `k6`/`artillery` at 25, 50 and 100 virtual users on one symbol, recording p95 and the 5xx rate — **not** runnable against the live origin and not runnable meaningfully from this host. **§5.14:** the measurement itself is still owed, but the two numbers it has to be read against now exist inside the product — every origin invocation logs `status` and `ms` (R15-11), and `TXN_BUDGET_MS` states the ceiling the 5xx rate would be measuring against |
| U15-3 | Neon's contribution to cold start, its pooled-connection ceiling and its region latency — `12` §5.14 owns the pooling facts and the restore drill; §5.13's ceiling depends on them | The production `DATABASE_URL` (`doc/PROD-READINESS-CHECKLIST.md:196,436` shows the read pulls back empty) plus a `pg_stat_activity` count during a synthetic burst; `12`'s PITR drill settles the restore half |
| U15-4 | What a *slow* or briefly-5xx Stripe does to a checkout and to the webhook — the branch §5.10 could not produce without a real account | A Stripe test-mode key plus a fault-injecting proxy in front of `api.stripe.com`, or Stripe's own dashboard "failed payments" view after any real incident. Never the live key from a workstation. **§5.14:** unchanged, and deliberately so — the pass added no network call to the money path and no provider credential to a developer machine, so this row is exactly as open as it was |
| U15-5 | What a slow Resend does to a 30 s job invocation and to the 15 s inline drain | A Resend test key plus artificial delay (proxy or `RESEND` sandbox) on one settle; observe `OutboxEvent` depth afterwards, which is the number `13`'s cron depends on |
| U15-6 | Real spend: the Vercel, Neon, Resend and Upstash lines for a launch month, Stripe's own fee schedule, and which of them the accounts actually bill at the tiers assumed in §5.12 | Provider consoles and the first invoice, read next to §5.12's model inputs (5.6 kB and 11 rows per settlement, 6 invocations per checkout). Every rate in §5.12 is a third-party summary until this row closes. **§5.14:** the pass gives the model one app-side input it lacked — `cost.settlements.day` / `.week` on `/api/jobs/config` — so the next invoice can be compared against a number the product produced rather than one this document counted by hand. The providers' lines themselves remain console-only |
| U15-7 | The animation cost of `components/TableCamera.tsx` on the 122-tile grid, on a mid-range phone | A device profiler (Chrome DevTools performance trace throttled 4× CPU) on `/`, recording long tasks during a camera move; `components/TableCamera.tsx` is read, never profiled, in this review |
| U15-8 | How many ISR writes the element routes actually incur, i.e. whether §5.12's largest cost line is real | Vercel's "ISR writes" usage metric over a week, compared with `symbols_reached_each_minute × 1440 × 30`; if it is anywhere near 5 M/month, that is a product decision about the 60 s window, not an invoice surprise. **§5.14:** half of this row is now answerable without the dashboard — the application side of every invocation is in the log, and `cost.analyticsRows` counts the one trail growth this doc could not see before — but **ISR writes themselves remain host-only**, and this row stays open until Vercel's metric is read |
| U15-9 | Whether any real request has ever hit the body-less 500s of R15-3, and what the production 5xx rate is | Vercel → Logs filtered on status ≥ 500 over a week, plus an alert on 5xx rate; the log lines will name the Prisma model (as in §5.10) but no request id. **§5.14:** the second half of that sentence is no longer true — every origin invocation now logs an id, a method, a path, a status and a duration, so "has a real request ever hit one of these" is answerable from the application's own log after the next deploy. What the log cannot see is an invocation the platform kills before the code runs, and an *alert* on 5xx rate is still not configured, which is why this row stays open |

**What the fix pass did not settle.** Nine rows above are untouched by it, and each for a reason
the pass could not manufacture: U15-1 needs a field measurement on a real handset, U15-3 a
production-database reading, U15-4 and U15-5 a live provider branch, U15-7 a device profiler. Two
rows were *narrowed* rather than closed (U15-8, U15-9 — the application half is now in the log,
the host half is not), and two gained an app-side input the model can be checked against (U15-2,
U15-6). What remains structurally outside this document's reach is the same list §5.13 flagged:
platform invocations, ISR write volume, provider invoices, field CWV, and animation cost — five
things only the host, four consoles, and one real phone can report. Three decisions also stay
where their owners put them, and the pass says so rather than absorbing them: the hold
(R15-9 → `09`), retention for the tables that grow without a window (R15-13 → `12`), and whether
the prerendered `/` should carry a live number at all (§9 Q1 → `12`). The one thing the pass
changed about the unknowns themselves is that four of them are now cheaper to close than they
were when this document was authored.

