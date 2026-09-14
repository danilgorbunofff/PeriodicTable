# Findings register

Every finding from every phase doc, in one place. The phase doc is the work; this is the index over it. A finding's text is written in its phase doc first and mirrored here — never only here.

**IDs.** `R<phase>-<n>`, two-digit phase, e.g. `R04-3`. Ids are append-only: a fixed or rejected finding keeps its id forever, because the ledger and the commit history reference them.

**Severity.** P0 blocks announce (money can be lost, created or misrepresented; data can leak; legal exposure; a silent undetectable failure). P1 must fix before announce. P2 first week. P3 backlog. Full definitions in `00-REVIEW-PLAN.md` §4.

**Category.** `money` · `correctness` · `security` · `privacy` · `legal` · `ux` · `a11y` · `perf` · `ops` · `content` · `seo` · `data` · `testing`

**Status.** `open` · `fixed` · `wontfix` · `accepted-risk` — the last two require a reason in the phase doc's open-questions section.

**Rules.** No row without evidence: a `file:line` or a dated probe recorded in the phase doc's live-evidence section, and a reproduction someone else can run. Where no evidence is yet possible the row is `UNKNOWN` in the evidence column together with the exact command or dashboard step that would settle it. Secrets are never recorded here.

## P0

| ID | Phase | Category | Summary | Evidence | Status | Fixed in |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

## P1

| ID | Phase | Category | Summary | Evidence | Status | Fixed in |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

## P2

| ID | Phase | Category | Summary | Evidence | Status | Fixed in |
| --- | --- | --- | --- | --- | --- | --- |
| R01-1 | 01 | seo | The home page ships no social metadata at all (0 `og:*`, 0 `twitter:*`, no canonical, no JSON-LD), so every share of the product's own URL renders a text-only link with no card image | `doc/review/01-discovery-and-unfurl.md` §5.1 (0 og/twitter/canonical in the served 149431-byte document); `app/layout.tsx:17-22` | open | — |
| R01-2 | 01 | seo | The share image is served as `image/svg+xml`, which the platforms that render cards do not accept, so element unfurls have no image | `app/og/[sym]/route.tsx:6,19`; §5.8 (`Content-Type: image/svg+xml`); §5.5 (platform card-image support) | open | — |
| R01-3 | 01 | seo | No element page has an inbound link from anywhere in the product; the board's tiles are `<button>`s, so all 122 element pages are reachable only via the sitemap | `components/Tile.tsx:34-41`; §5.1 href census (0 occurrences of `/elements/` in the home document) | open | — |
| R02-1 | 02 | ux | `notFound()` off a bad legal slug returns a blank page: 404 status, `<html id="__next_error__">`, no visible element at all | §5.2 (probe of `/legal/nope`); `app/legal/[slug]/page.tsx:129-130`; §5.7 (no `app/not-found.tsx`) | open | — |
| R02-2 | 02 | ux | A route matching nothing falls through to Next's default 404 — no wordmark, no nav, no way back | §5.3 (`/zzz-not-a-page` and `/legal` → 404/7335 B, stock `<title>404: This page could not be found.</title>`) | open | — |
| R02-3 | 02 | ux | No error boundary anywhere: `error.tsx`, `global-error.tsx` and `loading.tsx` are all absent, so a client render throw or an unguarded server read reaches Next's default surface with no brand and no recovery | §5.7 (absence audit under `app/`) | open | — |
| R02-4 | 02 | content | The served document advertises 122 elements at `$5 · unclaimed` before hydration — the claim `lib/liveState.ts` exists to prevent | §5.6 (149431 B document, `unclaimed` ×123, tile titles); `app/page.tsx:216-233,197-203`; `lib/liveState.ts:24-27` | open | — |
| R02-5 | 02 | ux | An empty `/api/activity` feed renders `loading…` pulsing forever above `0 recent` | §5.5 (`[]`, 200, 2 B); `components/ActivityCard.tsx:36-38,70-74` | open | — |

## P3

| ID | Phase | Category | Summary | Evidence | Status | Fixed in |
| --- | --- | --- | --- | --- | --- | --- |
| R01-4 | 01 | seo | No `rel="canonical"` on any route, and the only internal link into the board is `/?el=<sym>&stake=<n>` — a query-state document identical in size to `/` | §5.1, §5.2 (0 canonical tags); §5.9 (`/?el=H` → 200, 149431 bytes); `app/elements/[sym]/page.tsx:126-131` | open | — |
| R01-5 | 01 | seo | Every sitemap URL claims to have changed at the moment the sitemap was rendered (all 123 `lastmod` identical) | `app/sitemap.ts:14-15`; §5.6 (123 identical `lastmod`, unchanged 41 minutes later) | open | — |
| R01-6 | 01 | seo | `robots.txt` declares no `Sitemap:` directive, so the sitemap is discoverable only by guessing `/sitemap.xml` or a manual submission | `app/robots.ts:8-14`; §5.6 (104-byte file, no `Sitemap:` line) | open | — |
| R01-7 | 01 | ops | The sitemap's host comes from `NEXT_PUBLIC_APP_URL`, whose absence nothing detects (`requireProdEnv` has no call site), while the code fallback is the apex | `app/sitemap.ts:12`; `lib/env.ts:11,164`; `app/api/jobs/config/route.ts:10-11`; §5.8 | open | — |
| R01-8 | 01 | security | The OG card interpolates stored strings into SVG markup unescaped, on the product's own origin; the only control is upstream WHATWG validation | `app/og/[sym]/route.tsx:18-19`; `lib/validate.ts:1-30,45-70,75`; §5.10 | open | — |
| R02-6 | 02 | ux | The activity card cannot report failure or staleness on its main path: handed-down rows suppress its own error, so a failed refresh leaves retained rows under a footer still claiming `live · updates every 30s` | §6 (row 3 and row 5); `components/ActivityCard.tsx:39,70,110,115` | open | — |
| R02-7 | 02 | content | The legal pages ship the home page's `<title>` and description verbatim | §5.4; `app/legal/[slug]/page.tsx:5,124-125`; `app/layout.tsx:17-22` | open | — |
| R03-1 | 03 | data | The dataset and the roadmap disagree about where the four exotics sit: columns 8/9/10/11 in `lib/elements.ts`, 7/8/9/10 in `lib/elements.json`, 7-10 in `doc/ROADMAP.md`; `03d8591` moved the pod and the tiles but not the JSON, and the API serves the `.ts` | `doc/review/03-the-board.md` §5.4-5.5; `lib/elements.ts` vs `lib/elements.json` `gridCol`; `doc/ROADMAP.md:142,148`; `prisma/seed.ts:36-60` | open | — |
| R03-2 | 03 | correctness | The API ships money aggregates that count stakes the tiles refuse to show — the face filter keeps only `amountUsd > 0` `DIRECT_STATES` rows while `pool`/`count` and `claimedElements` count every stake; P3 only because both sides are empty today, it becomes real the day a stake is hidden | §5.1, §5.8; `app/api/elements/route.ts:15-18,35-40`; `app/api/stats/route.ts:21,27`; `doc/PROD-READINESS-CHECKLIST.md` §J6 | open | — |
| R03-3 | 03 | perf | The declared cache window never reaches the wire: `s-maxage=10, stale-while-revalidate=30` in the route, `public, max-age=0, must-revalidate` plus `Age: 6` and `X-Vercel-Cache: HIT` on the wire, as for all five read APIs | §5.7; `app/api/elements/route.ts:48` | open | — |
| R03-4 | 03 | a11y | The search field announces combobox state it does not have: `aria-expanded="true"` and `aria-controls="search-results"` are hardcoded while the listbox is conditional, and the `role="option"` items carry no `aria-selected` | §5.2; `components/SearchPill.tsx:93,94,130,146,186` | open | — |

## UNKNOWN — evidence not yet obtainable

| U01-1 | 01 | seo | Whether each platform actually renders the element card (image, or text only) | Paste `https://www.periodictable.lol/elements/H` into a private X post draft, a Slack DM, a Discord DM, an iMessage to yourself and the LinkedIn Post Inspector, and read the rendered card; delete any public post afterwards |
| U01-2 | 01 | seo | Whether Google has the sitemap and whether the 122 element pages are indexed | Search Console → verify the `www` URL-prefix property → Sitemaps → submit `https://www.periodictable.lol/sitemap.xml` → read Pages/Coverage for the element URLs |
| U01-3 | 01 | seo | Whether a leader domain of ~30+ characters overflows the OG card's 640 px text column (no clamp in the route) | `curl -s https://www.periodictable.lol/og/<sym> -o card.svg` for a symbol whose leader has a long domain (needs the first real stake), or substitute the text in a local copy of the SVG and measure the text element's bounding box in a browser |
| U02-1 | 02 | ux | What the shell looks like at 360/390/768/1024/1440 px — rail vs sheet, and whether the footer and the stale pill clear each other | Capture those five widths of `/`, `/legal/about`, `/legal/nope` and `/zzz-not-a-page` on a host whose browser writes PNGs (this one's Chrome 152 does not, §5.8) |
| U02-2 | 02 | a11y | Keyboard-only traversal of the live shell: tab order, focus visibility, and Escape ownership with a sheet and a modal open | Tab through `/` with no mouse — the contracts are asserted in `lib/a11y.test.ts` but never traversed on the running site |
| U02-3 | 02 | ux | What a client render throw actually shows, given no error boundary exists (R02-3) | Force a render error on a preview deploy with a temporary `throw` — it edits app code, so it needs a go-ahead |
| U02-4 | 02 | ux | How long the pre-hydration `$5 · unclaimed` face stays on screen (R02-4) | DevTools → Slow 4G plus 6× CPU throttle on `/`, capturing at first paint and after hydration |
| U03-1 | 03 | ux | All visual rendering — tile faces, the pod, the sheen, gestures — and the screen-reader half of R03-4 | `chrome --headless=new --screenshot=out.png --window-size=1440,2400 <url>` per §4 state |
| U03-2 | 03 | perf | Cold mobile load and LCP against the budget; desktop is measured (§5.6) | DevTools phone viewport with 4× CPU throttling, or `npx lighthouse <url> --output=json` |
| U03-3 | 03 | correctness | What a claimed tile, a missing logo or a hidden listing renders — the one production write this doc defers until a go-ahead | Two stakes on a throwaway DB, then read `/api/elements` and `/api/stats`; residue 2 `Stake` rows |
| U03-4 | 03 | ux | Whether `?el=Hbar` deep-links and scrolls without JS | `curl.exe -sS <url>/?el=Hbar` for the face, a browser for the scroll |

## Summary

| Doc | Phase | Status | P0 | P1 | P2 | P3 | Last reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 00 | Review plan | draft | — | — | — | — | 2026-09-14 |
| 01 | Discovery and unfurl | draft | 0 | 0 | 3 | 5 | 2026-09-14 |
| 02 | Shell and static surfaces | draft | 0 | 0 | 5 | 2 | 2026-09-14 |
| 03 | The board | draft | 0 | 0 | 4 | 4 | 2026-09-14 |
| 04 | Element detail and pricing | not started | — | — | — | — | — |
| 05 | Accessibility and content | not started | — | — | — | — | — |
| 06 | Checkout before payment | not started | — | — | — | — | — |
| 07 | Payment provider integration | not started | — | — | — | — | — |
| 08 | Settlement and ledger integrity | not started | — | — | — | — | — |
| 09 | Ownership and competition | not started | — | — | — | — | — |
| 10 | Email and notifications | not started | — | — | — | — | — |
| 11 | API contracts | not started | — | — | — | — | — |
| 12 | Data layer | not started | — | — | — | — | — |
| 13 | Jobs and cron | not started | — | — | — | — | — |
| 14 | Security | not started | — | — | — | — | — |
| 15 | Performance, concurrency, cost, resilience | not started | — | — | — | — | — |
| 16 | Legal, privacy, tax | not started | — | — | — | — | — |
| 17 | Operator tooling and runbooks | not started | — | — | — | — | — |
| 18 | Observability, analytics, alerts | not started | — | — | — | — | — |
| 19 | Launch and marketing readiness | not started | — | — | — | — | — |
| 20 | Post-launch and debt | not started | — | — | — | — | — |
