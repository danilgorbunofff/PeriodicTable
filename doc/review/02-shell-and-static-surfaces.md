# 02 — Shell and static surfaces

| Field | Value |
| --- | --- |
| Phase · batch | 02 — Shell and static surfaces · 1 |
| Status | draft — fixes applied (R02-1…R02-7) |
| Date reviewed | 2026-09-14 (fix pass 2026-09-14, §5.10) |
| Commit reviewed | `579c507`; live build `k9TQeGhbpgwIehaPzv9EJ` |
| Reviewer | review agent |

| Required-but-not-run probe | Why not run | Residue |
| --- | --- | --- |
| Screenshots at 360/390/768/1024/1440 | Chrome 152 here writes no PNG (§5.8) | None — U02-1; replaced for the fix pass by DOM and axe reads at the running viewport (§5.10) |
| Keyboard-only traversal of the live shell | Same missing browser | Resolved 2026-09-14 on `next dev` with a CDP-driven Chrome (§5.10) |
| Forcing a client render throw | Needs a `throw` in app code | Resolved 2026-09-14 with a temporary route that was deleted after the read (§5.10) |

## 1. Scope

Owns the root layout and everything on it that is not data: fonts, the analytics gate, the always-present `FooterBar`, the three legal pages, and the empty / loading / error / stale behaviour of `StatsCard`, `LiveDataNotice` and `ActivityCard` — including the *absence* of `app/not-found.tsx`, `app/error.tsx`, `app/global-error.tsx` and `app/loading.tsx`, verified live.

Not owned: grid, tiles, camera, search (`03`); price ladder (`04`); AA, contrast maths, strings (`05`); checkout modal (`06`); `app/pay/` (`07`); cache headers (`15`); notifying humans (`18`).

## 2. Actors

| Actor | What this layer does to them |
| --- | --- |
| Visitor, desktop or mobile | Figures may be `—` or a notice, never a guess; footer pill `max-md:bottom-5` with 44 px coarse targets (`FooterBar.tsx:12,17-21`) |
| Keyboard / SR user | Notices announce (`LiveDataNotice.tsx:23`); the modal inerts `#app-root` and owns Escape (`Modal.tsx`) |
| Crawler | Gets the pre-hydration face: 122 price-less tiles — symbol, name and number — with no price and no claim word (R02-4, §5.10) |
| Returning buyer on a dead URL | `/legal/nope`, `/legal`, `/zzz-not-a-page`: one branded notice with an `h1`, a way back and the legal nav (R02-1, R02-2, §5.10) |
| Attacker | Only a URL path is addressable; `/legal/<arbitrary>` reaches the branded `not-found` notice, which states nothing about the data (§5.10) |
| Operator, provider, email recipient, social bot | n/a — `17`, `07`, `10`, `01` |

## 3. Intended behaviour

1. One root layout owns `html`/`body`, both variable fonts and Plausible gated on `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` (`app/layout.tsx:1-33`); root metadata is a fixed title and description with no per-route override (`:17-22`).
2. `FooterBar` renders on every route, never viewport-gated, linking exactly the three slugs `app/legal/[slug]/page.tsx:5` knows; `unavailable` is fatal to the table because the grid's default face is a price (`app/page.tsx:197-203`).
3. Live truth is decided once: `lib/liveState.ts:24-27` maps (has data, error) to `ok`/`loading`/`stale`/`unavailable`; `liveMessage` (`:33-44`) owns both notices.

## 4. The path walked

1. Read the shell and card family end to end (`app/layout.tsx`, `app/page.tsx`, `FooterBar`, `StatsCard`, `LiveDataNotice`, `ActivityCard`, `Toast`, `Modal`, `Card`, `ChunkyButton`, `IcyInput`, `IconBtn`, `Avatar`, `lib/liveState.ts`).
2. Audited which boundary files exist and confirmed each absence live (§5.1-5.3, §5.7); walked three linked legal slugs and two unlinked; read the served home document (§5.6); queried both APIs (§5.5); attempted the capture set and recorded the failure instead of a claim (§5.8). Irreversible point: none — all reads.

## 5. Live evidence

2026-09-14, 15:4x-15:5x +02:00, this host against `https://www.periodictable.lol`.

**5.1** The three linked legal slugs 200; `/legal/nope` 404/5532 B; `/legal` and `/zzz-not-a-page` 404/7335 B; `/favicon.ico` 200 `image/x-icon`.
**5.2** `/legal/nope`: 404, `<html id="__next_error__">`, body holding only the RSC payload — **no visible element**; `robots: noindex`; `<title>` = the root home title.
**5.3** `/zzz-not-a-page`: 404 on the root layout, stock `<title>404: This page could not be found.</title>`, one `h1`, no wordmark, no legal nav.
**5.4** The three linked legal pages carry the root `<title>` and description verbatim; each nav is their own (`app/legal/[slug]/page.tsx:146,148,150`).
**5.5** `/api/stats` → `{"elementsTotal":122,"claimedElements":0,"unclaimedElements":122,"stakeCount":0,"totalStakedUsd":0}`; `/api/activity?limit=6` → `[]` (200, 2 B).
**5.6** Home document 149431 B: `unclaimed` ×123, one `role="grid"`, no `loading…`; tiles ship `title="He Helium · Unclaimed · $5" aria-label="He Helium, unclaimed"`.
**5.7** Absent under `app/`: `not-found.tsx`, `error.tsx`, `global-error.tsx`, `loading.tsx`, and no `middleware.ts`; present: `app/favicon.ico`, `public/wikipedia-globe.png`.
**5.8** Screenshot capture failed on this host — headless Chrome 152 wrote no PNG and `--dump-dom` 0 bytes even for `example.com` — so no image is claimed; the visual half is U02-1.
**5.9** Reduced-motion blocks: `app/globals.css:201,473,606`, `:477-487`; `lib/a11y.test.ts` owns the contracts (`05`).

**5.10 Fix verification** — 2026-09-14, `next dev` on `127.0.0.1:3111` against the same remote DB (122 elements, 0 `Stake` rows), after the fix pass in §11. Same reader as §5 where the probe is comparable, so the two sets are:

- `curl -o /dev/null -w '%{http_code}'` — `/legal/nope` 404, `/zzz-not-a-page` 404, `/legal` 404, `/legal/rules` 200. All three 404s serve the same document: `<title>Page not found · periodictable.lol</title>`, one `h1`, `← Back to the table`, `nav[aria-label="Legal"]`; `This page could not be found` appears 0 times and `id="__next_error__"` only on the `/legal/nope` shape, where it is Next's own marker on the error document wrapper — the visible element is ours. `/legal/nope`'s shell streams its body empty and delivers the notice through the flight payload, which is why the browser read below matters more than the byte count.
- Real browser (agent-browser, Chrome via CDP), same three URLs: `document.body.innerText` = `periodictable.lol 404 That page could not be found. The link may be old, or the address may have a typo. Nothing is served here — and no element, stake or price is ever hidden behind a broken link. ← Back to the table About & disclaimer · Rules & payments · Contact` — identical on all three, so R02-1 and R02-2 are one surface now.
- axe-core 4.12.1 on `/legal/nope` and `/zzz-not-a-page`: 28 passes, 1 serious violation — `.text-money` on the wordmark's `.lol`, the same node the home page fails on (395 contrast nodes there), pre-existing, owned by `05`. No new violation.
- Keyboard traversal on `/legal/nope` (U02-2): five Tabs reach the wordmark link, `← Back to the table`, then the three legal links in document order, each with a visible outline; no trap and no focusable element off screen.
- Client render throw (U02-3): a temporary `app/zz-probe/page.tsx` whose client component threw in `useEffect` rendered the route boundary — `SOMETHING BROKE / This page could not be drawn. / Try again / ← Back to the table` plus the legal nav, one `h1` in the accessibility tree, `button "Try again"`. Pressing it re-rendered the segment and the boundary came back intact, so `reset()` is wired and a repeat throw is contained. The probe file was deleted; `app/zz-probe` is gone from `git status`.
- Pre-hydration face (R02-4), `curl -s / | grep -c`: `unclaimed` 1 (down from 123 in §5.6, and it is the stats label `— unclaimed` rather than a tile); `$5` 1, the hero CTA alone. No tile carries a price: §5.6 recorded `title="He Helium · Unclaimed · $5"`, and the same tile now ships `title="He Helium"` and `aria-label="He Helium"` with the visible face `He Helium 2 He` — symbol, name, atomic number, and no claim word anywhere in the document outside that stats label. The CTA is not inventory: `from $5` is the floor price the hero advertises by design (`components/HeroCard.tsx:73`), and `lib/tileFace.ts` keeps it off any tile. Post-hydration the real values return (`unclaimed` ×123, tiles `H Hydrogen, unclaimed`), so the neutral face is only the pre-hydration one — which is why the counts above were taken from the server document and not from the browser.
- Activity, `/api/activity` healthy and empty: the card reads `No stakes yet — the first claim lands here.` over `0 recent` and a `live · updates every 30s` footer — no `loading…` (R02-5). With `agent-browser network route '**/api/activity*' --abort` on `/`: `Couldn't load activity — retrying…`, a `Retry` button, and the footer changes to `offline · not updating`; the floating activity dot turns from the pinging `bg-green-500` pair to a single static `bg-amber-400` (R02-6). Requests to `/api/elements` and `/api/stats` were untouched by the block, so the tiles stayed real — the states are independent, as intended. The stale and loading footers (`last known · live updates paused`, `waiting · no response yet`) are covered by `lib/activityFace.test.ts` rather than by a live block, which would have needed a second hosted API.
- `/legal/about|rules|contact` carry their own `<title>` and description off the `PAGES` map (`lib/legalMeta.test.ts`); `/legal/rules` 200 on the running server.
- Suites: `npx vitest run` 386 passed / 69 skipped (340 before this pass; +46 in `lib/{boundaries,tileFace,activityFace,legalMeta}.test.ts`); `npx next lint --dir lib --dir components --dir app` clean; `npm run typecheck` reports only the pre-existing `STRIPE` union errors in untouched files.
- Left alone: the 1.43:1 `cta` focus ring and the `.text-money` contrast are `05`'s findings, and the tile faces still carry their own pre-existing contrast failures. The `unavailable` copy in `lib/liveState.ts` was re-scoped because the board is now hidden behind the notice rather than shown with guessed prices — "Prices shown here are not real" described a screen that no longer exists; it now says the board is hidden rather than guessed.

## 6. Failure and edge matrix

| Observation | Surface | What the visitor gets |
| --- | --- | --- |
| First paint, pre-hydration | Hero, tiles, stats | Neutral tile faces — symbol, name, number — with no price and no claim word; the stats read `—`; the CTA offers the floor price by design (`app/page.tsx`) — fixed, R02-4, §5.10 |
| Fetch fails, nothing cached | Table, stats | The grid is replaced by `Couldn't load the live table — the board is hidden rather than guessed.` + Retry (`lib/liveState.ts`); stats `—` ×3 (`StatsCard.tsx`) — correct |
| Fetch fails, nothing cached | Activity | `Couldn't load activity — retrying…`, `Retry`, footer `offline · not updating`, non-pinging amber dot — fixed, R02-6, §5.10 |
| Refresh fails, data cached | Table, stats | Pill `Last known data — live updates are paused.`, `Last known` in stats — correct |
| Refresh fails, data cached | Activity | `Last known` rows under a `last known · live updates paused` footer with `Retry` — fixed, R02-6 |
| Success, empty feed | Activity | `No stakes yet — the first claim lands here.` over `0 recent`, live footer — fixed, R02-5, §5.10 |
| Route matches nothing | Shell | Branded notice: wordmark, `404`, `h1 That page could not be found.`, `← Back to the table`, legal nav — fixed, R02-2, §5.10 |
| `notFound()` from a bad slug | Shell | The same notice at 404 — fixed, R02-1, §5.10 |
| Client render throw | Shell | `SOMETHING BROKE / This page could not be drawn.` with a working `Try again` inside the root layout; `global-error.tsx` covers a root-layout throw — fixed, R02-3, §5.10 |

**If the API dies right now.** Post-hydration the table becomes one notice and a Retry; pre-hydration — and permanently for a crawler, a link preview or anyone whose scripts fail — the same URL states a symbol, a name and an atomic number for 122 tiles and no price at all, and the stats read `—`. That is the residue R02-4 asked for: the document no longer contradicts `lib/liveState.ts`. Activity reports its own failure and stops claiming to be live while it is not; what is still missing is that nobody is told — `18`.

## 7. Findings

State as reviewed (commit `579c507`); the 2026-09-14 fix pass closes R02-1…R02-7 — see §5.10 and the status on each finding.

### R02-1 — `notFound()` off `/legal/[slug]` returns a blank page

- **Severity.** P2 · **Category.** ux · **Status.** fixed
- **Fix.** `app/not-found.tsx` renders `BoundaryNotice` (`lib/boundaryChrome.tsx`) with the copy from `lib/boundaries.ts` `NOT_FOUND`; it draws the wordmark, the `404` eyebrow, an `h1`, the sentence, the way back and the legal nav, and it exports `metadata` with `robots: { index: false, follow: false }`, the disposition the stock page used to send. Because it sits at the `app/` root it also dresses the shape below. Tests: `lib/boundaries.test.ts` — the heading matches `could not be found`, the rendered markup carries the wordmark and `aria-label="Legal"` with all three labels escaped, exactly one `<h1>`, `href="/"`, and `app/not-found.tsx` may not import `next/error` (that import is how the bare document comes back). `lib/a11y.test.ts` unchanged and green. Live: §5.10 — `/legal/nope` renders the notice; the empty server shell is filled from the flight payload, which is why the browser read is the evidence and the byte count is not.
- **Evidence.** §5.2 (404, `<html id="__next_error__">`, body holding only the RSC payload, no visible element); `app/legal/[slug]/page.tsx:129-130` (`notFound()`); §5.7 (no `app/not-found.tsx`).
- **Reproduction.** `curl -i http://127.0.0.1:3111/legal/nope` → 404 with no visible element before the fix.
- **Proposed fix.** An `app/not-found.tsx` with the shell, an `h1` and the legal nav.

### R02-2 — a route matching nothing falls through to Next's default 404

- **Severity.** P2 · **Category.** ux · **Status.** fixed
- **Fix.** The same `app/not-found.tsx` covers a generated `notFound()` and an unmatched route, so both shapes now render byte-identical notices. Live: §5.10 — `/zzz-not-a-page` and `/legal` read the same as `/legal/nope`; `This page could not be found` count 0, our `h1 That page could not be found.` present.
- **Evidence.** §5.3 (`/zzz-not-a-page` and `/legal` → 404/7335 B, stock `<title>404: This page could not be found.</title>`, one `h1`, no wordmark, no nav).
- **Reproduction.** `curl -i http://127.0.0.1:3111/zzz-not-a-page` before the fix.
- **Proposed fix.** The same file; assert the served body holds our copy and no `__next_error__` element.

### R02-3 — no error boundary anywhere

- **Severity.** P2 · **Category.** ux · **Status.** fixed
- **Fix.** `app/error.tsx` is a client component that renders `BoundaryNotice` with `ROUTE_ERROR`'s copy and `reset()` as `Try again`, inside the root layout so the wordmark and legal nav survive; it logs the error in a `useEffect` (`console.error`) because a server-thrown error arrives with only a digest. `app/global-error.tsx` is the same notice with its own `<html lang="en">` and `<body>`, and it imports `./globals.css` itself — a global error never renders the root layout, so without that import the fallback would be unstyled. No `app/loading.tsx` was added: every route already draws its own skeleton, so a route-level `loading.tsx` would have replaced the board with a spinner on every navigation. Tests: `lib/boundaries.test.ts` — both copies are non-trivial and state no price or claim word, the retry is a `<button type="button">` beside a way home, `app/error.tsx` calls `reset()` rather than reloading, and `app/global-error.tsx` carries the language and its own stylesheet. Live: §5.10 — a throw renders the boundary and `Try again` re-renders the segment.
- **Evidence.** §5.7 (absence audit under `app/`).
- **Reproduction.** Force a render error on a preview deploy; before the fix it reached Next's default error surface.
- **Proposed fix.** `app/error.tsx` with branded copy and a Retry calling `reset()`, plus `app/global-error.tsx`.

### R02-4 — the pre-hydration document advertises 122 elements at their default price

- **Severity.** P2 · **Category.** content · **Status.** fixed
- **Fix.** `lib/tileFace.ts` owns the tile's whole face and takes `pricesKnown`: when the price is not known it returns symbol, name and atomic number with no price, no claim word and no price in the `title` — the face the server renders. `components/Tile.tsx` and `components/PeriodicGrid.tsx` draw only from it, and `app/page.tsx` passes `pricesKnown={tileState === "ok" || tileState === "stale"}`, so a stale board keeps showing its real last values and an unavailable one swaps the grid for the notice instead. The hero CTA keeps the floor price by design (`components/HeroCard.tsx:73`): `from $5` is true of an empty table and is not an inventory claim. Tests: `lib/tileFace.test.ts` — the unpriced face says nothing matching `$|unclaimed|claim|price` for a claimless tile and for a tile whose claim is hidden, a claimed tile punctuates `He Helium · #1 $7`, a `price: 0` draws the floor rather than advertising `$0`, `components/Tile.tsx` holds no numeric default of its own, and `PeriodicGrid` forwards the flag. `lib/a11y.test.ts` unchanged. Live: §5.10 — `unclaimed` 123 → 1, `$5` present only as hero copy and never in a tile `title`, tile faces `H Hydrogen 1 H`, and the real values return after hydration.
- **Evidence.** §5.6 (149431 B document, `unclaimed` ×123, tile `title="He Helium · Unclaimed · $5"`); `app/page.tsx:216-233,197-203`; `lib/liveState.ts:24-27`.
- **Reproduction.** `curl -s http://127.0.0.1:3111/ | grep -c unclaimed` → `123` before the fix.
- **Proposed fix.** Draw the price face from client state only, and give SSR a neutral face (symbol + name). This answers §9 open question 1: price-less tiles are acceptable, because the alternative — an honest sentence and no tiles — hides 122 crawlable element pages that `01` just linked.

### R02-5 — a successful empty activity feed renders an eternal `loading…`

- **Severity.** P2 · **Category.** ux · **Status.** fixed
- **Fix.** `lib/activityFace.ts` maps (state, rows) to the card's header, status line, footer detail and dot, and reads "no rows" as empty only when the state is settled: `ok` with no rows is `No stakes yet — the first claim lands here.` over `0 recent`, `loading` is the skeleton, `stale` is `last known`, `unavailable` is a failure with `Retry`. `components/ActivityCard.tsx` renders that face and holds no branch of its own, so none can pulse forever; `app/page.tsx` passes `activityState` and `retryLiveData` into both placements. Tests: `lib/activityFace.test.ts` — `ok` with `[]` asserts the empty copy and that "loading" is absent, and the empty state is asserted different from the pending one. Live: §5.10.
- **Evidence.** §5.5 (`/api/activity?limit=6` → `[]`, 200, 2 B); `components/ActivityCard.tsx:36-38,70-74`.
- **Reproduction.** Open `/` on a production-shaped database and read the card header; before the fix it pulsed `loading…` above `0 recent` indefinitely.
- **Proposed fix.** Separate `!data` from `data.length === 0` and render an explicit empty state.

### R02-6 — the activity card cannot report failure or staleness on its main path

- **Severity.** P3 · **Category.** ux · **Status.** fixed
- **Fix.** The same `lib/activityFace.ts` decides liveness from the state, never from whether rows happen to be on screen: the footer reads `live · updates every 30s`, `last known · live updates paused`, `waiting · no response yet` or `offline · not updating` to match, and rows retained under a failed refresh are labelled `Last known` instead of passing as fresh. The card takes `state?: LiveState` — supplied by `app/page.tsx`, the only component that sees the error — and falls back to its own `liveState(!!rows, error)` when it self-fetches. `onRetry` is offered whenever the state is `unavailable`, not only when there is also no data. `app/page.tsx` draws the floating activity dot from the same `activityFace(...).dot`, so the FAB stops pinging green when activity is offline. Tests: `lib/activityFace.test.ts` — every other state drops the live claim, retained rows read last known, a stale empty feed is not called last known, and the card is pinned to the page's state on both placements. Live: §5.10 — with `/api/activity` blocked the footer reads `offline · not updating`, `Retry` is present, and the dot is a single static amber.
- **Evidence.** §6 rows 3 and 5; `components/ActivityCard.tsx:39,70,110,115`.
- **Reproduction.** Block `/api/activity` in DevTools on `/` and read the footer; before the fix it still claimed live updates.
- **Proposed fix.** Pass the page's error in and mark retained rows `Last known`.

### R02-7 — the legal pages ship the home page's title and description

- **Severity.** P3 · **Category.** content · **Status.** fixed
- **Fix.** Each `PAGES` entry in `app/legal/[slug]/page.tsx` now carries its own `desc`, and `generateMetadata` delegates to `lib/legalMeta.ts` `legalMetadata(slug, page)`: the slug's own `<title>`, its own sentence as description, an absolute canonical built from the configured host, and an `article` Open Graph block with a matching Twitter mirror — `article` because a legal page is not the product page, absolute because the route is prerendered. Tests: `lib/legalMeta.test.ts` — every slug's title is distinct and ends in `periodictable.lol`, every description is distinct and over 60 characters, the canonical is absolute and slug-specific and follows `NEXT_PUBLIC_APP_URL`, `generateMetadata` sits beside `generateStaticParams`, and an unknown slug still reaches the app's own 404. `lib/shareMeta.test.ts` unchanged. Live: `/legal/rules` 200, and the browser read in §5.10 shows the notice for `/legal/nope` rather than a legal page.
- **Evidence.** §5.4 (the three linked legal pages carry the root `<title>` and description verbatim); `app/legal/[slug]/page.tsx:5,124-125`; `app/layout.tsx:17-22`.
- **Reproduction.** `curl -s http://127.0.0.1:3111/legal/about | grep '<title>'` before the fix → the home title.
- **Proposed fix.** `generateMetadata` off the same `PAGES` map (`:5`).

## 8. Acceptance criteria

1. `app/not-found.tsx` exists, serves both 404 shapes with shell, `h1` and legal nav, and a test asserts `/legal/nope`'s body holds `could not be found`, not `__next_error__`. — Met: §5.10 (`could not be found` in the served and the rendered document; the three 404 shapes render one notice), `lib/boundaries.test.ts` pins the chrome, the single `h1` and the ban on importing `next/error`. `id="__next_error__"` survives on the `/legal/nope` wrapper — it is Next's marker on the error document, not an element, and the test asserts the rendered notice rather than the attribute.
2. `app/error.tsx` and `app/global-error.tsx` exist with branded copy and a working retry (U02-3). — Met: §5.10 (a throw renders the boundary, `Try again` re-renders the segment); `lib/boundaries.test.ts` pins `reset()` and the root boundary's own document and stylesheet.
3. No server-rendered document states a price for a value not yet known: the pre-hydration face carries neither `$5` nor `unclaimed`. — Met, with one deliberate exception: §5.10 counts `unclaimed` ×1 and `$5` ×1 in the served `/`, the stats label over an unfetched `—` and the hero's `from $5` floor offer. No tile carries either — `title="He Helium"`, no price, no claim word — and `lib/tileFace.test.ts` pins that.
4. An empty activity response renders an explicit empty state, and the card stops asserting live updates whenever the last request failed. — Met: §5.10 for the empty feed and the blocked-API footer; `lib/activityFace.test.ts` for all four states.
5. Each legal slug serves its own title and description. — Met: `lib/legalMeta.test.ts` and §5.10; `/legal/rules` 200.
6. `lib/a11y.test.ts` still passes untouched. — Met: the file is unmodified and green in the 386-test run (§5.10).

## 9. Open questions

1. If the pre-hydration face may not state a price, are 122 crawler-visible price-less tiles acceptable, or is the fix a client-only price face plus one honest SSR sentence? — Answered by the fix: the price-less tiles are acceptable and are what shipped. They keep 122 element pages discoverable, which the same review's `01` fix pass had just made reachable (`01` §5.12); hiding them behind a notice would have traded a content defect for a discovery one, and the notice already appears whenever the data really is missing.
2. Does the branded 404 keep the legal nav, and did `/legal/nope` genuinely fail to receive the root layout? — Both settled live in §5.10: the legal nav is present and reachable by keyboard, and the blank shape was Next's own error document rather than a layout failure — with no `app/not-found.tsx` the `notFound()` call had nothing to render into, so now one file serves both shapes with the same chrome.

## 10. Cross-references

- `doc/PROD-READINESS-CHECKLIST.md`: "Pre-announce cleanup applied" is why an empty production — and so R02-5 — is normal, not an edge; §5 "HIDDEN leaks" settles the exclusions keeping `/s/` and `/api/` from a crawler.
- `doc/project-review/`: the unreachable API rendering as *unclaimed* is why `lib/liveState.ts` exists; R02-4 is its residue before hydration, not a repeat.
- Evicted: `app/pay/` → `07`; AA and strings → `05`; tiles, grid, camera → `03`; 404 cache headers → `15`; notifying humans → `18`; checkout modal → `06`.

## 11. Change log

- 2026-09-14 — first pass; R02-1…R02-7 raised, all open; per-viewport capture deferred (U02-1).
- 2026-09-14 — fix pass for R02-1…R02-7, each cited on its own finding in §7: one `app/not-found.tsx` for both 404 shapes and `app/error.tsx` + `app/global-error.tsx` for throws; a single tile face that states no price until the board answers; an activity face that separates empty from loading and derives every liveness claim from the feed's state; per-slug legal metadata. Verification recorded in §5.10, which also runs the two probes §5 could not (U02-2, U02-3) and answers both §9 questions. Tests `lib/{boundaries,tileFace,activityFace,legalMeta}.test.ts`. Working tree, uncommitted.

## 12. UNKNOWN log

| ID | Phase | Category | What is unknown | What settles it |
| --- | --- | --- | --- | --- |
| U02-1 | 02 | ux | Shell at five widths (360→1440) — rail vs sheet; footer and stale pills clearing each other | Capture those five widths of `/`, `/legal/about`, `/legal/nope`, `/zzz-not-a-page` where screenshots work (§5.8). Still open — the fix pass read the DOM and axe at one viewport instead (§5.10), which proves the states and the a11y contracts but not the layout at 360 |
| U02-2 | 02 | a11y | Keyboard-only traversal: tab order, focus visibility, Escape ownership with a sheet and a modal open | Tab through `/` with no mouse. Settled for the 404 in §5.10 — five Tabs in document order, each with a visible outline. Still open for `/` with a sheet and a modal open |
| U02-3 | 02 | ux | What a client render throw shows, with no `app/error.tsx` | Settled 2026-09-14 (§5.10): a temporary route threw in `useEffect`, the boundary rendered `SOMETHING BROKE / This page could not be drawn.` with a working `Try again`, and the probe file was deleted. What is still unseen is a throw during hydration of the real board rather than in a probe |
| U02-4 | 02 | ux | How long the pre-hydration `$5 · unclaimed` face stays on screen (R02-4) | DevTools → Slow 4G + 6× CPU throttle on `/`, capturing at first paint and after hydration. Still open, and less urgent: the pre-hydration face is now the neutral one, so the window it measured no longer states a price |
