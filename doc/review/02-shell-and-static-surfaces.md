# 02 — Shell and static surfaces

| Field | Value |
| --- | --- |
| Phase · batch | 02 — Shell and static surfaces · 1 |
| Status | draft |
| Date reviewed | 2026-09-14 |
| Commit reviewed | `579c507`; live build `k9TQeGhbpgwIehaPzv9EJ` |
| Reviewer | review agent |

| Required-but-not-run probe | Why not run | Residue |
| --- | --- | --- |
| Screenshots at 360/390/768/1024/1440 | Chrome 152 here writes no PNG (§5.8) | None — U02-1 |
| Keyboard-only traversal of the live shell | Same missing browser | None — U02-2 |
| Forcing a client render throw | Needs a `throw` in app code | None — U02-3 |

## 1. Scope

Owns the root layout and everything on it that is not data: fonts, the analytics gate, the always-present `FooterBar`, the three legal pages, and the empty / loading / error / stale behaviour of `StatsCard`, `LiveDataNotice` and `ActivityCard` — including the *absence* of `app/not-found.tsx`, `app/error.tsx`, `app/global-error.tsx` and `app/loading.tsx`, verified live.

Not owned: grid, tiles, camera, search (`03`); price ladder (`04`); AA, contrast maths, strings (`05`); checkout modal (`06`); `app/pay/` (`07`); cache headers (`15`); notifying humans (`18`).

## 2. Actors

| Actor | What this layer does to them |
| --- | --- |
| Visitor, desktop or mobile | Figures may be `—` or a notice, never a guess; footer pill `max-md:bottom-5` with 44 px coarse targets (`FooterBar.tsx:12,17-21`) |
| Keyboard / SR user | Notices announce (`LiveDataNotice.tsx:23`); the modal inerts `#app-root` and owns Escape (`Modal.tsx`) |
| Crawler | Gets the pre-hydration face: 122 tiles at `$5 · unclaimed` — R02-4 |
| Returning buyer on a dead URL | `/legal/nope`, `/legal`, `/zzz-not-a-page`: no way back — R02-1, R02-2 |
| Attacker | Only a URL path is addressable; `/legal/<arbitrary>` reaches the blank page (§5.2) |
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

## 6. Failure and edge matrix

| Observation | Surface | What the visitor gets |
| --- | --- | --- |
| First paint, pre-hydration | Hero, tiles, stats | `$5 · unclaimed` ×122, and the CTA promises the same (`app/page.tsx:216-233`) — R02-4 |
| Fetch fails, nothing cached | Table, stats | `Couldn't load the live table. Prices shown here are not real.` + Retry (`lib/liveState.ts:41-43`); stats `—` ×3 (`StatsCard.tsx:22-35`) — correct |
| Fetch fails, nothing cached | Activity | `Couldn't load activity — retrying…` over an empty list, footer still `live · updates every 30s` / `0 recent` (`ActivityCard.tsx:70,110,115`) — R02-6 |
| Refresh fails, data cached | Table, stats | Pill `Last known data — live updates are paused.` (`app/page.tsx:246`), `Last known` in stats (`StatsCard.tsx:35`) — correct |
| Refresh fails, data cached | Activity | Nothing at all (`ActivityCard.tsx:39`) — R02-6 |
| Success, empty feed | Activity | `loading…` pulsing forever above `0 recent` (§5.5) — R02-5 |
| Route matches nothing | Shell | Next's default 404: no brand, no nav, no way back — R02-2 |
| `notFound()` from a bad slug | Shell | Blank white page with a 404 status — R02-1 |
| Client render throw | Shell | No boundary exists — R02-3; the surface is U02-3 |

**If the API dies right now.** Post-hydration the table becomes one notice and a Retry; pre-hydration — and permanently for a crawler, a link preview or anyone whose scripts fail — the same URL still sells 122 elements at `$5 · unclaimed`. Activity says it could not load while still claiming live updates, and nobody is told — `18`.

## 7. Findings

### R02-1 — `notFound()` off `/legal/[slug]` returns a blank page · P2 · ux
`/legal/nope` answers 404 with `<html id="__next_error__">` and no visible element (§5.2; `app/legal/[slug]/page.tsx:129-130` calls `notFound()`, and no `app/not-found.tsx` exists, §5.7). Repro: `curl.exe -i https://www.periodictable.lol/legal/nope`. Fix: an `app/not-found.tsx` with the shell, an `h1` and the legal nav. Status: open.

### R02-2 — a route matching nothing falls through to Next's default 404 · P2 · ux
`/zzz-not-a-page` and `/legal` return 404 and render the stock page: `<title>404: This page could not be found.</title>`, one `h1`, no wordmark, no nav (§5.3). Repro: `curl.exe -i https://www.periodictable.lol/zzz-not-a-page`. Fix: the same `app/not-found.tsx` covers both shapes. Status: open.

### R02-3 — no error boundary anywhere · P2 · ux
`app/error.tsx`, `app/global-error.tsx` and `app/loading.tsx` are absent (§5.7), so a client render throw or an unguarded server read reaches Next's default error surface with no brand and no recovery. Repro: force a throw on a preview deploy (U02-3). Fix: `app/error.tsx` with branded copy and a Retry calling `reset()`, plus `app/global-error.tsx`. Status: open.

### R02-4 — the pre-hydration document advertises 122 elements at their default price · P2 · content
Before any script runs, the document carries `unclaimed` 123 times, ships tiles as `He Helium · Unclaimed · $5` and has the hero CTA promise the same price (`app/page.tsx:216-233`); `liveState` can only correct the grid after hydration (`lib/liveState.ts:24-27`, `app/page.tsx:197-203`). A crawler, preview bot or JS-less visitor reads a confident inventory claim the code itself documents as untrustworthy — the residue of the false-green failure that produced `lib/liveState.ts`. Repro: `curl.exe -s https://www.periodictable.lol/ | Select-String unclaimed -AllMatches`. Fix: draw the price face from client state only, and give SSR a neutral face (symbol + name). Status: open.

### R02-5 — a successful empty activity feed renders an eternal `loading…` · P2 · ux
`components/ActivityCard.tsx:36-38,70-74` reads "no first row" as "still loading"; production returns `[]` (§5.5), so every visitor watches `loading…` pulse forever above `0 recent`. Repro: open `/` and read the card header. Fix: separate `!data` from `data.length === 0` and render an explicit empty state. Status: open.

### R02-6 — the activity card cannot report failure or staleness on its main path · P3 · ux
Rows handed down suppress the card's own error (`components/ActivityCard.tsx:39`), so a failed refresh leaves retained rows under a footer still reading `live · updates every 30s` (`:115`) while the tiles pill and `StatsCard:35` mark the same condition; the self-fetch path does report failure (`:70`) but keeps the live claim and offers `Retry` only when `error && !data` (`:110`). Repro: block `/api/activity` in DevTools on `/`, read the footer. Fix: pass the page's error in and mark retained rows `Last known`. Status: open.

### R02-7 — the legal pages ship the home page's title and description · P3 · content
`app/legal/[slug]/page.tsx` exports `generateStaticParams` (`:124-125`) and no metadata, so `/legal/about` is served the root `<title>` and description (§5.4; `app/layout.tsx:17-22`). Repro: `curl.exe -s https://www.periodictable.lol/legal/about | Select-String '<title>'`. Fix: `generateMetadata` off the same `PAGES` map (`:5`). Status: open.

## 8. Acceptance criteria

1. `app/not-found.tsx` exists, serves both 404 shapes with shell, `h1` and legal nav, and a test asserts `/legal/nope`'s body holds `could not be found`, not `__next_error__`.
2. `app/error.tsx` and `app/global-error.tsx` exist with branded copy and a working retry (U02-3).
3. No server-rendered document states a price for a value not yet known: the pre-hydration face carries neither `$5` nor `unclaimed`.
4. An empty activity response renders an explicit empty state, and the card stops asserting live updates whenever the last request failed.
5. Each legal slug serves its own title and description.
6. `lib/a11y.test.ts` still passes untouched.

## 9. Open questions

1. If the pre-hydration face may not state a price, are 122 crawler-visible price-less tiles acceptable, or is the fix a client-only price face plus one honest SSR sentence?
2. Does the branded 404 keep the legal nav, and did `/legal/nope` genuinely fail to receive the root layout?

## 10. Cross-references

- `doc/PROD-READINESS-CHECKLIST.md`: "Pre-announce cleanup applied" is why an empty production — and so R02-5 — is normal, not an edge; §5 "HIDDEN leaks" settles the exclusions keeping `/s/` and `/api/` from a crawler.
- `doc/project-review/`: the unreachable API rendering as *unclaimed* is why `lib/liveState.ts` exists; R02-4 is its residue before hydration, not a repeat.
- Evicted: `app/pay/` → `07`; AA and strings → `05`; tiles, grid, camera → `03`; 404 cache headers → `15`; notifying humans → `18`; checkout modal → `06`.

## 11. Change log

- 2026-09-14 — first pass; R02-1…R02-7 raised, all open; per-viewport capture deferred (U02-1).

## 12. UNKNOWN log

| ID | Phase | Category | What is unknown | What settles it |
| --- | --- | --- | --- | --- |
| U02-1 | 02 | ux | Shell at five widths (360→1440) — rail vs sheet; footer and stale pills clearing each other | Capture those five widths of `/`, `/legal/about`, `/legal/nope`, `/zzz-not-a-page` where screenshots work (§5.8) |
| U02-2 | 02 | a11y | Keyboard-only traversal: tab order, focus visibility, Escape ownership with a sheet and a modal open | Tab through `/` with no mouse; the contracts are asserted but never traversed |
| U02-3 | 02 | ux | What a client render throw shows, with no `app/error.tsx` | Force a render error on a preview deploy (temporary `throw`) — it edits app code |
| U02-4 | 02 | ux | How long the pre-hydration `$5 · unclaimed` face stays on screen (R02-4) | DevTools → Slow 4G + 6× CPU throttle on `/`, capturing at first paint and after hydration |
