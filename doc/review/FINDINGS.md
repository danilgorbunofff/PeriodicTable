# Findings register

Every finding from every phase doc, in one place. The phase doc is the work; this is the index over it. A finding's text is written in its phase doc first and mirrored here — never only here.

**IDs.** `R<phase>-<n>`, two-digit phase, e.g. `R04-3`. Ids are append-only: a fixed or rejected finding keeps its id forever, because the ledger and the commit history reference them.

**Severity.** P0 blocks announce (money can be lost, created or misrepresented; data can leak; legal exposure; a silent undetectable failure). P1 must fix before announce. P2 first week. P3 backlog. Full definitions in `00-REVIEW-PLAN.md` §4.

**Category.** `money` · `correctness` · `security` · `privacy` · `legal` · `ux` · `a11y` · `perf` · `ops` · `content` · `seo` · `data` · `testing`

**Status.** `open` · `fixed` · `wontfix` · `accepted-risk` — the last two require a reason in the phase doc's open-questions section. A `Fixed in` cell names the files rather than a commit while a fix pass still sits in the working tree; the phase doc's change log says which pass it was.

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
| R01-1 | 01 | seo | The home page ships no social metadata at all (0 `og:*`, 0 `twitter:*`, no canonical, no JSON-LD), so every share of the product's own URL renders a text-only link with no card image | `doc/review/01-discovery-and-unfurl.md` §5.1 (0 og/twitter/canonical in the served 149431-byte document); `app/layout.tsx:17-22` | fixed | `lib/shareMeta.ts` (layout metadata); `app/og/home/route.tsx` |
| R01-2 | 01 | seo | The share image is served as `image/svg+xml`, which the platforms that render cards do not accept, so element unfurls have no image | `app/og/[sym]/route.tsx:6,19`; §5.8 (`Content-Type: image/svg+xml`); §5.5 (platform card-image support) | fixed | `app/og/[sym]/route.tsx`, `lib/ogCardImage.tsx`, `lib/ogCard.ts` |
| R01-3 | 01 | seo | No element page has an inbound link from anywhere in the product; the board's tiles are `<button>`s, so all 122 element pages are reachable only via the sitemap | `components/Tile.tsx:34-41`; §5.1 href census (0 occurrences of `/elements/` in the home document) | fixed | `components/Tile.tsx`, `components/PeriodicGrid.tsx` |
| R02-1 | 02 | ux | `notFound()` off a bad legal slug returns a blank page: 404 status, `<html id="__next_error__">`, no visible element at all | §5.2 (probe of `/legal/nope`); `app/legal/[slug]/page.tsx:129-130`; §5.7 (no `app/not-found.tsx`) | fixed | `app/not-found.tsx`, `lib/boundaryChrome.tsx`, `lib/boundaries.ts` |
| R02-2 | 02 | ux | A route matching nothing falls through to Next's default 404 — no wordmark, no nav, no way back | §5.3 (`/zzz-not-a-page` and `/legal` → 404/7335 B, stock `<title>404: This page could not be found.</title>`) | fixed | `app/not-found.tsx` |
| R02-3 | 02 | ux | No error boundary anywhere: `error.tsx`, `global-error.tsx` and `loading.tsx` are all absent, so a client render throw or an unguarded server read reaches Next's default surface with no brand and no recovery | §5.7 (absence audit under `app/`) | fixed | `app/error.tsx`, `app/global-error.tsx`, `lib/boundaryChrome.tsx`, `lib/boundaries.ts` |
| R02-4 | 02 | content | The served document advertises 122 elements at `$5 · unclaimed` before hydration — the claim `lib/liveState.ts` exists to prevent | §5.6 (149431 B document, `unclaimed` ×123, tile titles); `app/page.tsx:216-233,197-203`; `lib/liveState.ts:24-27`; §5.10 (`unclaimed` ×1, `$5` ×1 after) | fixed | `lib/tileFace.ts`, `components/Tile.tsx`, `components/PeriodicGrid.tsx`, `app/page.tsx` |
| R02-5 | 02 | ux | An empty `/api/activity` feed renders `loading…` pulsing forever above `0 recent` | §5.5 (`[]`, 200, 2 B); `components/ActivityCard.tsx:36-38,70-74`; §5.10 (empty state live) | fixed | `lib/activityFace.ts`, `components/ActivityCard.tsx`, `app/page.tsx` |
| R04-1 | 04 | money | A reclaim link's pre-filled amount is set once from the quote and never reconciled with the board, so after a rival bid the older amount is charged as an ordinary top-up that retakes nothing while the modal prints the live delta beside it | `doc/review/04-element-detail-and-pricing.md` §5.8, R04-1; `app/page.tsx:116-123,127-130`; `components/Modals.tsx:154-170,378`; `app/elements/[sym]/page.tsx:68-71` | fixed | `lib/stakeQuote.ts` (+ `lib/stakeQuote.test.ts`), `app/page.tsx`, `components/Modals.tsx`, `lib/detailFace.test.ts` |
| R05-1 | 05 | a11y | Error text misses the project's own contrast budget: ten `text-red-500` sites and two `ink/60` labels measure 3.49–3.95:1 against the 4.5:1 the token table documents | `doc/review/05-accessibility-and-content.md` §5.1, §5.3, R05-1; `components/Modals.tsx:284,331-372,421-422`; `components/TerritoryView.tsx:81`; `components/WorldOrder.tsx:36`; `tailwind.config.ts:17-48` | open | — |
| R05-2 | 05 | a11y | The only focus indicator is a 1.43:1 `cta` ring and the search field has none, against 1.4.11's 3:1 | §5.1, R05-2; `components/IcyInput.tsx:11`; `components/SearchPill.tsx:117`; `components/IconBtn.tsx:23`; `components/PeriodicGrid.tsx:258`; `tailwind.config.ts:30` | open | — |

## P3

| ID | Phase | Category | Summary | Evidence | Status | Fixed in |
| --- | --- | --- | --- | --- | --- | --- |
| R01-4 | 01 | seo | No `rel="canonical"` on any route, and the only internal link into the board is `/?el=<sym>&stake=<n>` — a query-state document identical in size to `/` | §5.1, §5.2 (0 canonical tags); §5.9 (`/?el=H` → 200, 149431 bytes); `app/elements/[sym]/page.tsx:126-131` | fixed | `lib/shareMeta.ts`, `app/elements/[sym]/page.tsx`, `app/s/[domain]/page.tsx` |
| R01-5 | 01 | seo | Every sitemap URL claims to have changed at the moment the sitemap was rendered (all 123 `lastmod` identical) | `app/sitemap.ts:14-15`; §5.6 (123 identical `lastmod`, unchanged 41 minutes later) | fixed | `app/sitemap.ts`, `lib/sitemapData.ts` |
| R01-6 | 01 | seo | `robots.txt` declares no `Sitemap:` directive, so the sitemap is discoverable only by guessing `/sitemap.xml` or a manual submission | `app/robots.ts:8-14`; §5.6 (104-byte file, no `Sitemap:` line) | fixed | `app/robots.ts` |
| R01-7 | 01 | ops | The sitemap's host comes from `NEXT_PUBLIC_APP_URL`, whose absence nothing detects (`requireProdEnv` has no call site), while the code fallback is the apex | `app/sitemap.ts:12`; `lib/env.ts:11,164`; `app/api/jobs/config/route.ts:10-11`; §5.8 | fixed | `lib/siteUrl.ts`, `app/sitemap.ts` |
| R01-8 | 01 | security | The OG card interpolates stored strings into SVG markup unescaped, on the product's own origin; the only control is upstream WHATWG validation | `app/og/[sym]/route.tsx:18-19`; `lib/validate.ts:1-30,45-70,75`; §5.10 | fixed | `lib/ogCard.ts` (`escapeXml`) |
| R02-6 | 02 | ux | The activity card cannot report failure or staleness on its main path: handed-down rows suppress its own error, so a failed refresh leaves retained rows under a footer still claiming `live · updates every 30s` | §6 (row 3 and row 5); `components/ActivityCard.tsx:39,70,110,115`; §5.10 (`offline · not updating`, `Retry`, static dot) | fixed | `lib/activityFace.ts`, `components/ActivityCard.tsx`, `app/page.tsx` |
| R02-7 | 02 | content | The legal pages ship the home page's `<title>` and description verbatim | §5.4; `app/legal/[slug]/page.tsx:5,124-125`; `app/layout.tsx:17-22` | fixed | `lib/legalMeta.ts`, `app/legal/[slug]/page.tsx` |
| R03-1 | 03 | data | The dataset and the roadmap disagree about where the four exotics sit: columns 8/9/10/11 in `lib/elements.ts`, 7/8/9/10 in `lib/elements.json`, 7-10 in `doc/ROADMAP.md`; `03d8591` moved the pod and the tiles but not the JSON, and the API serves the `.ts` | `doc/review/03-the-board.md` §5.4-5.5; `lib/elements.ts` vs `lib/elements.json` `gridCol`; `doc/ROADMAP.md:142,148`; `prisma/seed.ts:36-60` | fixed | `lib/gridGeometry.ts`, `app/api/elements/route.ts`, `components/PeriodicGrid.tsx`, `doc/ROADMAP.md` |
| R03-2 | 03 | correctness | The API ships money aggregates that count stakes the tiles refuse to show — the face filter keeps only `amountUsd > 0` `DIRECT_STATES` rows while `pool`/`count` and `claimedElements` count every stake; P3 only because both sides are empty today, it becomes real the day a stake is hidden | §5.1, §5.8; `app/api/elements/route.ts:15-18,35-40`; `app/api/stats/route.ts:21,27`; `doc/PROD-READINESS-CHECKLIST.md` §J6 | fixed | `lib/moderation.ts`, `app/api/stats/route.ts`, `lib/claimFace.test.ts` |
| R03-3 | 03 | perf | The declared cache window never reaches the wire: `s-maxage=10, stale-while-revalidate=30` in the route, `public, max-age=0, must-revalidate` plus `Age: 6` and `X-Vercel-Cache: HIT` on the wire, as for all five read APIs | §5.7; `app/api/elements/route.ts:48` | fixed | `lib/route.ts`, `app/api/elements/route.ts`, `app/api/elements/[sym]/route.ts` |
| R03-4 | 03 | a11y | The search field announces combobox state it does not have: `aria-expanded="true"` and `aria-controls="search-results"` are hardcoded while the listbox is conditional, and the `role="option"` items carry no `aria-selected` | §5.2; `components/SearchPill.tsx:93,94,130,146,186` | fixed | `components/SearchPill.tsx`, `lib/searchCombobox.test.ts` |
| R04-2 | 04 | correctness | A hidden holder is priced as a newcomer: `?me=` and the modal answer from the hidden-filtered list while checkout looks the caller up unfiltered and reserves only TAKE, so the modal promises a 15-minute hold no `Reservation` row backs | `doc/review/04-element-detail-and-pricing.md` §5.8, §4.4, §6, R04-2; `app/api/elements/[sym]/route.ts:13,47-52`; `components/Modals.tsx:150-153`; `app/api/checkout/route.ts:215-218,296-311` | fixed | `app/api/elements/[sym]/route.ts` (`prices.boardComplete`), `lib/api.ts`, `lib/stakeQuote.ts`, `components/Modals.tsx`, `lib/routes.test.ts`, `lib/contracts.test.ts` |
| R04-3 | 04 | testing | `validateTake` (`lib/pricing.ts:53-58`) is dead code: its only references are its own test, while the take floor is enforced by `reservedTotal` and `lib/settle.ts:161` — so the documented $L+1 rule has no test on its live path | `doc/review/04-element-detail-and-pricing.md` §5.7, §5.8, R04-3; `lib/pricing.test.ts:11,93-95` | fixed | `app/api/checkout/route.ts:309-312`, `lib/detailFace.test.ts` (truth table) |
| R04-4 | 04 | seo | `/elements/<symbol>` is case-sensitive with no redirect, so `/elements/au` — the form a human types — is a 404 while `/elements/Au` is 200; `?el=` and the API agree with the strictness | `doc/review/04-element-detail-and-pricing.md` §5.5, §5.8, R04-4; `app/elements/[sym]/page.tsx:15-16,26-27`; `app/api/elements/[sym]/route.ts:25`; `app/page.tsx:108` | fixed | `lib/elements.ts` (`findElementBySymbol`), `lib/elements.test.ts`, `app/elements/[sym]/page.tsx`, `app/api/elements/[sym]/route.ts`, `app/og/[sym]/route.tsx`, `app/api/checkout/route.ts`, `app/page.tsx` |
| R05-3 | 05 | a11y | Home serves no `<main>` and no skip link, and the profile page has no landmark and no heading above `<h3>` | §5.2, §5.3, R05-3; `app/layout.tsx`; `app/page.tsx`; `app/s/[domain]/page.tsx:164` | open | — |
| R05-4 | 05 | a11y | Both branches of each checkout error render the same element id, so a client and a server failure produce duplicate ids and `aria-describedby` resolves to the first div | §5.3, R05-4; `components/Modals.tsx:329-332,343-346,357-360` | open | — |
| R05-5 | 05 | a11y | Four panels refetch every 30 s with no pause and none is `aria-live`, so a tab open an hour makes 480 requests and shifts numbers under a pointer | R05-5; `app/page.tsx:67,73,76`; `components/ActivityCard.tsx:36`; `components/TerritoryView.tsx:31`; `components/WorldOrder.tsx:23` | open | — |
| R05-6 | 05 | content | `/legal/rules` says "we do not offer refunds" twice while the shipped path reverses a settled payment (`kind: "refund"`) on `charge.refunded` | §5.2, R05-6; `app/legal/[slug]/page.tsx:81-84`; `lib/recompute.ts:116,165`; `lib/stripe.ts:325-327,340` | open | — |
| R05-7 | 05 | content | Two promises nothing keeps: reports "actioned within 72 hours" and a waitlist "we'll be in touch", while the report surface is a pull queue and a waitlist join sends nothing | R05-7; `app/legal/[slug]/page.tsx:104`; `app/api/admin/reports/route.ts`; `app/api/waitlist/route.ts:39,44`; `components/Modals.tsx:192` | open | — |
| R05-8 | 05 | content | Production serves the dev-simulator copy on `/pay/[paymentId]` ("DEV SIMULATOR", "No Stripe keys configured") while the API 403s outside mode `dev` | §5.2, R05-8; `app/pay/[paymentId]/page.tsx:52,55,93`; `app/api/dev/pay/route.ts:15` | open | — |

## UNKNOWN — evidence not yet obtainable

| ID | Phase | Category | Unknown | What settles it |
| --- | --- | --- | --- | --- |
| U01-1 | 01 | seo | Whether each platform actually renders the element card (image, or text only) | Paste `https://www.periodictable.lol/elements/H` into a private X post draft, a Slack DM, a Discord DM, an iMessage to yourself and the LinkedIn Post Inspector, and read the rendered card; delete any public post afterwards |
| U01-2 | 01 | seo | Whether Google has the sitemap and whether the 122 element pages are indexed | Search Console → verify the `www` URL-prefix property → Sitemaps → submit `https://www.periodictable.lol/sitemap.xml` → read Pages/Coverage for the element URLs |
| U01-3 | 01 | seo | Whether a leader domain of ~30+ characters overflows the OG card's 640 px text column (no clamp in the route) — **settled 2026-09-14:** the card clamps the domain to 24 characters with an ellipsis (`clampDomain`, `lib/ogCard.ts`) and sizes the headline against a fixed 760 px column, so no domain can reach the edge; `lib/ogCard.test.ts` asserts the cap. The original probe is kept for the record | `curl -s https://www.periodictable.lol/og/<sym> -o card.svg` for a symbol whose leader has a long domain (needs the first real stake), or substitute the text in a local copy of the SVG and measure the text element's bounding box in a browser |
| U02-1 | 02 | ux | What the shell looks like at 360/390/768/1024/1440 px — rail vs sheet, and whether the footer and the stale pill clear each other | Capture those five widths of `/`, `/legal/about`, `/legal/nope` and `/zzz-not-a-page` on a host whose browser writes PNGs (this one's Chrome 152 does not, §5.8) |
| U02-2 | 02 | a11y | Keyboard-only traversal of the live shell: tab order, focus visibility, and Escape ownership with a sheet and a modal open | Tab through `/` with no mouse — the contracts are asserted in `lib/a11y.test.ts` but never traversed on the running site |
| U02-3 | 02 | ux | What a client render throw actually shows, given no error boundary exists (R02-3) | Force a render error on a preview deploy with a temporary `throw` — it edits app code, so it needs a go-ahead |
| U02-4 | 02 | ux | How long the pre-hydration `$5 · unclaimed` face stays on screen (R02-4) | DevTools → Slow 4G plus 6× CPU throttle on `/`, capturing at first paint and after hydration |
| U03-1 | 03 | ux | All visual rendering — tile faces, the pod, the sheen, gestures — and the screen-reader half of R03-4 | `chrome --headless=new --screenshot=out.png --window-size=1440,2400 <url>` per §4 state |
| U03-2 | 03 | perf | Cold mobile load and LCP against the budget; desktop is measured (§5.6) | DevTools phone viewport with 4× CPU throttling, or `npx lighthouse <url> --output=json` |
| U03-3 | 03 | correctness | What a claimed tile, a missing logo or a hidden listing renders — the one production write this doc defers until a go-ahead | Two stakes on a throwaway DB, then read `/api/elements` and `/api/stats`; residue 2 `Stake` rows |
| U03-4 | 03 | ux | Whether `?el=Hbar` deep-links and scrolls without JS | `curl.exe -sS <url>/?el=Hbar` for the face, a browser for the scroll |
| U04-1 | 04 | data | Whether the `ActivityLog` rows carry `deltaUsd`/`resultTotalUsd` or the pre-Phase-3 NULLs, and what the feed prints for each | `psql "$DATABASE_URL"`, SQL in a temp `.sql` piped in (`-c` breaks on PascalCase) — read only |
| U04-2 | 04 | correctness | Whether any production `Stake` row belongs to a `HIDDEN` startup, which decides R04-2's reach from static-only to live | Same connection: `SELECT count(*) FROM "Stake" s JOIN "Startup" u ON u.id = s."startupId" WHERE u."moderationState" = 'HIDDEN';` |
| U04-3 | 04 | money | The claimed-state render, the receipt shape and the real $5 charge on the element path | J4 — one real card payment, then `/elements/<sym>` and the Stripe dashboard; residue 1 `Payment`, 1 `Stake`, 1 `ActivityLog` |
| U05-1 | 05 | a11y | Whether the 22 `text-money` sites render ≥18.66 px bold, which 3.00–3.25:1 passes, or are failing small text | `getComputedStyle` over `.text-money` at 1280/360 px |
| U05-2 | 05 | a11y | Whether the white `.exotic-tile:focus-visible` outline clears 3:1 on every exotic theme, not only the worst | Focus each theme's tile and sample the outline against its background |
| U05-3 | 05 | a11y | Tab order, focus visibility and 1.4.10 reflow at 400 % zoom on the live shell | A browser run — blocked on this host by U02-1 (`02` §5.8) |

## Summary

| Doc | Phase | Status | P0 | P1 | P2 | P3 | Last reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 00 | Review plan | draft | — | — | — | — | 2026-09-14 |
| 01 | Discovery and unfurl | draft — fixes applied | 0 | 0 | 3 | 5 | 2026-09-14 |
| 02 | Shell and static surfaces | draft | 0 | 0 | 5 | 2 | 2026-09-14 |
| 03 | The board | draft | 0 | 0 | 0 | 4 | 2026-09-14 |
| 04 | Element detail and pricing | draft — fixes applied | 0 | 0 | 1 | 3 | 2026-09-14 |
| 05 | Accessibility and content | draft | 0 | 0 | 2 | 6 | 2026-09-14 |
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
