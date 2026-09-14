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

## P3

| ID | Phase | Category | Summary | Evidence | Status | Fixed in |
| --- | --- | --- | --- | --- | --- | --- |
| R01-4 | 01 | seo | No `rel="canonical"` on any route, and the only internal link into the board is `/?el=<sym>&stake=<n>` — a query-state document identical in size to `/` | §5.1, §5.2 (0 canonical tags); §5.9 (`/?el=H` → 200, 149431 bytes); `app/elements/[sym]/page.tsx:126-131` | open | — |
| R01-5 | 01 | seo | Every sitemap URL claims to have changed at the moment the sitemap was rendered (all 123 `lastmod` identical) | `app/sitemap.ts:14-15`; §5.6 (123 identical `lastmod`, unchanged 41 minutes later) | open | — |
| R01-6 | 01 | seo | `robots.txt` declares no `Sitemap:` directive, so the sitemap is discoverable only by guessing `/sitemap.xml` or a manual submission | `app/robots.ts:8-14`; §5.6 (104-byte file, no `Sitemap:` line) | open | — |
| R01-7 | 01 | ops | The sitemap's host comes from `NEXT_PUBLIC_APP_URL`, whose absence nothing detects (`requireProdEnv` has no call site), while the code fallback is the apex | `app/sitemap.ts:12`; `lib/env.ts:11,164`; `app/api/jobs/config/route.ts:10-11`; §5.8 | open | — |
| R01-8 | 01 | security | The OG card interpolates stored strings into SVG markup unescaped, on the product's own origin; the only control is upstream WHATWG validation | `app/og/[sym]/route.tsx:18-19`; `lib/validate.ts:1-30,45-70,75`; §5.10 | open | — |

## UNKNOWN — evidence not yet obtainable

| U01-1 | 01 | seo | Whether each platform actually renders the element card (image, or text only) | Paste `https://www.periodictable.lol/elements/H` into a private X post draft, a Slack DM, a Discord DM, an iMessage to yourself and the LinkedIn Post Inspector, and read the rendered card; delete any public post afterwards |
| U01-2 | 01 | seo | Whether Google has the sitemap and whether the 122 element pages are indexed | Search Console → verify the `www` URL-prefix property → Sitemaps → submit `https://www.periodictable.lol/sitemap.xml` → read Pages/Coverage for the element URLs |
| U01-3 | 01 | seo | Whether a leader domain of ~30+ characters overflows the OG card's 640 px text column (no clamp in the route) | `curl -s https://www.periodictable.lol/og/<sym> -o card.svg` for a symbol whose leader has a long domain (needs the first real stake), or substitute the text in a local copy of the SVG and measure the text element's bounding box in a browser |

## Summary

| Doc | Phase | Status | P0 | P1 | P2 | P3 | Last reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 00 | Review plan | draft | — | — | — | — | 2026-09-14 |
| 01 | Discovery and unfurl | draft | 0 | 0 | 3 | 5 | 2026-09-14 |
| 02 | Shell and static surfaces | not started | — | — | — | — | — |
| 03 | The board | not started | — | — | — | — | — |
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
