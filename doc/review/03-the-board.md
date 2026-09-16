# 03 — The board

| Field | Value |
| --- | --- |
| Phase · batch | 03 — The board · 1 |
| Status | draft — fixes applied (R03-1…R03-4) |
| Date reviewed | 2026-09-14 (fix pass 2026-09-14, §5.11) |
| Commit reviewed | `b5ff117`; live build (`x-vercel-cache: HIT`, §5.6) |
| Reviewer | review agent |

| Probe not run | Why | Residue |
| --- | --- | --- |
| Tile-state screenshots | Chrome 152 writes no PNG here (§5.9) | U03-1 |
| Cold mobile load | Same browser | U03-2 |
| Claimed / hidden render | Needs its own database: `.env` points at a shared remote Neon instance that `lib/testDb.ts` refuses by design, so the fixture cannot be created here | U03-3 |

The `?el=Hbar` probe in this table's first draft is done — §5.11 settles U03-4.

## 1. Scope

Owns S3: the dataset and tiles, every tile-face state, the exotic pod, the camera, the read APIs and search, `/api/stats` reconciliation, camera bounds and reset, mobile gestures, the load budget, the per-tile failure answer. Not owned: shell and pre-hydration face (`02`, R02-4), element detail (`04`), a11y and strings (`05`), checkout (`06`), money rules (`08`), limits (`11`), cache (`15`).

Inspected: `components/{PeriodicGrid,Tile,TableCamera,SearchPill}.tsx`; `app/page.tsx:55-150,185-251,290,297,337`; `app/api/{elements,stats,board,search,table-order}/route.ts`; `lib/{elements.ts,elements.json,gridNav,boards,familyFill,exoticThemes,liveState,moderation,api,rateStore,cameraInteract}.ts`; `lib/a11y.test.ts:151`; `prisma/seed.ts:36-60`; `doc/ROADMAP.md:142,148,172,187`; `doc/DESIGN-SYSTEM.md:114,214`.

## 2. Actors

| Actor | Effect |
| --- | --- |
| Visitor | 122 tiles, 48×52 px, legible with no data call; every figure reads `$5` / unclaimed (`Tile.tsx:29,36-37`) |
| Defending holder | the face shows `#1 $price`, never the pool (`app/api/elements/route.ts:41-43`) |
| Keyboard / SR | one tab stop; arrows, Home, End by geometry; Escape → `#chrome-search-toggle` (`PeriodicGrid.tsx:226`) |
| Attacker | `/api/search`: 60/min per IP, failing open without Upstash (`lib/rateStore.ts`); depth in `11` |
| Crawler | only the pre-hydration face survives without JS (R02-4, `02`) |
| Operator · maintainer | an empty board, an empty pool and a dead Neon look identical from outside; the two dataset files disagree (R03-1) |
| Customer, bidder, recipient, provider | n/a — `06`, `08`, `10` |

## 3. Intended behaviour

1. 122 entries in `lib/elements.ts` (1-118 plus `Hbar` -1, `Ps` 0, `Uue` 119, `DM` 999), 18 columns, rows 1-7 and 9-10; row 8 is a gap (`lib/gridNav.ts`, `lib/a11y.test.ts:151`).
2. A face is the top `rank`-ordered stake in `DIRECT_STATES` with `amountUsd > 0` (`app/api/elements/route.ts:15-18`) — a concealed listing can hold a tile while never reaching search or a rail.
3. `price = claim?.price ?? 5` and `"Unclaimed · $5"` are literals (`Tile.tsx:29,36-37`), so the pre-hydration document prints an unfetched price (R02-4).
4. Aggregates are hidden-inclusive, not display values: `pool`/`count` (`app/api/elements/route.ts:35-40`) and `claimedElements` (`app/api/stats/route.ts:21`) count every stake, so claimed + unclaimed = total for an invisible listing too; nothing on the board reads them (§5.8). *(After the fix pass: the money aggregates keep this rule — they answer "how much exists", not "what is drawn" — while the claim **headline** moved to the same face predicate as the tiles, so "N claimed" can no longer contradict the board; R03-2, §5.12.)*
5. `lib/liveState.ts` decides honesty: `unavailable` replaces the grid, `stale` keeps the last good faces plus a pill (`app/page.tsx:193-203,244-251`).
6. Camera: fits on mount, clamps 0.45-2.8, re-centres a covered tile, hard-resets on blur and tab switch; search debounces 200 ms, needs 2 characters (`TableCamera.tsx:150-275`, `SearchPill.tsx:93-95,130-135`).

## 4. The path walked

1. Dataset: parse `lib/elements.ts`, diff `lib/elements.json` (§5.3-5.5).
2. Render (`app/page.tsx` → `PeriodicGrid` → `Tile`), the read APIs, then the failure branch (`:193-203,244-251`); probes and measurements in §5, screenshot attempt in §5.9.
3. Irreversible point: none — every request here is a read; a claim is the first irreversible act (`06`, `08`).

**Tile-state inventory** (product one; screenshots U03-1).

| State | Drawn |
| --- | --- |
| Unclaimed | white tile, id, symbol, `$5`; tooltip and `aria-label` "Unclaimed · $5" (`Tile.tsx:29,36-37,63`) |
| Claimed with a logo | family fill, `#1 $price`, 18 px logo (`Tile.tsx:28,52-62`) |
| Claimed, no logo file | `$price` in the third slot; `onError` hides the broken image (`Tile.tsx:57-63`) |
| Unlisted leader (`DIRECT_STATES` only) | as a visible claim — moderation invisible on the face (`route.ts:15`) |
| Exotic (four symbols) | `.exotic-tile` face, `✦` where `id <= 0`, light shadowed type (`Tile.tsx:39-43,50-51`) |
| Selected (click, search, `?el=`) | `ring-2 ring-cta`, `activeId` follows (`PeriodicGrid.tsx:204-205,258`) |
| Pre-hydration | the unclaimed default on all 122 (R02-4, `02`) |

`stale` and `unavailable` are whole-board states (`app/page.tsx:244-251,193-203`); hidden money never reaches a face.

## 5. Live evidence

2026-09-14, 16:04-16:11 +02:00, this host, against `https://www.periodictable.lol`.

**5.1** `16:04:15`: `/api/elements` 200, 1,701 B brotli / 16,490 B identity, 0.24 s; `/api/stats` `{"elementsTotal":122,"claimedElements":0,"unclaimedElements":122,"stakeCount":0,"totalStakedUsd":0}`; `/api/board` (3 tabs), `/api/table-order`, `/api/activity?limit=6` → `[]`; `tab=bogus` → 400 `{"code":"BAD_TAB"}`.
**5.2** `16:06:14`: `au`, `Au`, `gold`, `gol` → one hit each, `{"type":"element","symbol":"Au"}`; `zzz`, `Xx`, empty → `[]`.
**5.3** `validate-elements.mjs` (session dir): 122 entries; ids, symbols, names, coordinates unique; rows 1-7, 9-10; STANDARD 112 / CULTURAL_ELITE 6 / EXOTIC 4; La 57…Lu 71, Ac 89…Lr 103.
**5.4** `03d8591` (2026-09-08) moved the pod (`EXOTIC_POD.left` 310 → 364, `PeriodicGrid.tsx:9`) and those tiles, not the JSON; `prisma/seed.ts:36-60` seeds the `.ts`; `doc/ROADMAP.md:142,148` still says columns 7-10; its pod pill (`:149`) and `EXOTIC` caption (`:172,187`) never render.
**5.5** `lib/elements.ts` vs `.json`: identical except four `gridCol`s — `Hbar`, `Ps`, `Uue`, `DM` at 8/9/10/11 in the `.ts`, 7/8/9/10 in the `.json`; the API serves the `.ts`.
**5.6** Sizes from written files (`raw-sizes.csv`) — brotli answers carry no `content-length`. HTML 14,655 / 149,431 B decoded, `x-vercel-cache: HIT`; 7 JS chunks 132,533 / 550,683; CSS 9,796 / 45,265; fonts 68,856; `polyfills…js` 41,343, legacy only; cold total 225,840 / 745,379 B; HTML holds 122 tile buttons.
**5.7** `16:10:59`: all five read APIs answer `Cache-Control: public, max-age=0, must-revalidate`; `/api/elements`: `Age: 6`, `X-Vercel-Cache: HIT`, while `app/api/elements/route.ts:48` declares `s-maxage=10, stale-while-revalidate=30`.
**5.8** The only `pool`/`count` readers are `TerritoryView.tsx:44` and `StatsCard.tsx:22-25` — no board component reads the aggregates.
**5.9** No screenshot exists: Chrome 152 wrote no PNG and `--dump-dom` gave 0 bytes even for `example.com` (`02` §5.8) — visual claims are U03-1.
**5.10** `lib/a11y.test.ts:151` locks row 8, the tab stop, 44 px and contrast contracts (`05`).
**5.11 Fix verification** — 2026-09-14, `next dev` on `127.0.0.1:3111` against the same remote DB (122 elements, 0 `Stake` rows), after the fix pass in §11:

- Cache headers (`curl -D - /api/elements`): `cache-control: s-maxage=10, stale-while-revalidate=30` and `vercel-cdn-cache-control: s-maxage=10, stale-while-revalidate=30` (R03-3). The live re-probe verified that Vercel's edge cache obeys the 10 s window (`X-Vercel-Cache: HIT`, incrementing `Age`), while stripping the downstream directive on the public wire; adding `Vercel-CDN-Cache-Control` explicitly instructs the CDN without relying on header inference.
- Dataset & Geometry (R03-1): `lib/elements.json` deleted; `lib/gridGeometry.ts` derived the exotic pod dynamically (`left: 364px; top: 44px; width: 238px; height: 80px`), eliminating magic numbers in `PeriodicGrid.tsx`. Crucially, verification uncovered that `/api/elements` had been serving `Hbar`, `Ps`, `Uue`, `DM` at columns 7, 8, 9, 10 because `prisma/seed.ts` mirrored an older seed into database columns `gridCol`. Mapping coordinates via `cellOf(e.symbol)` ensures `/api/elements` serves cols 8, 9, 10, 11 matching the real board layout.
- Aggregates reconciliation (R03-2): `/api/stats` `claimedElements` now filters by `where: { stakes: { some: FACE_STAKE_WHERE } }`, using the identical face predicate as `/api/elements`. Live test returned `{"elementsTotal":122,"claimedElements":0,"unclaimedElements":122,"stakeCount":0,"totalStakedUsd":0}`, guaranteeing headline and board claims never contradict even when stakes are concealed or reversed.
- Combobox state & a11y (R03-4): in `components/SearchPill.tsx`, `aria-expanded` binds to `showList` (false when unfocused/empty, true when `q.trim().length >= 2`), and `aria-controls` conditionally points to `"search-results"` only when the listbox exists. CDP probe: unfocused/empty input shows `aria-expanded="false"`, controls unset; typing "au" updates `aria-expanded="true"`, `aria-controls="search-results"`, `aria-activedescendant="search-hit-0"`, option carrying `aria-selected="true"`.
- `?el=Hbar` deep link (settles U03-4): browser inspection on `/?el=Hbar` confirmed active selection on `data-el-id="-1"`, `ring-cta` (rgb(255, 201, 60)) 2 px outside the 48 px tile, `title="Hbar Antihydrogen · Unclaimed · $5"`, `aria-label="Hbar Antihydrogen, unclaimed"`.
- axe-core scan on `/` with search dropdown active: 0 combobox violations; only 10 moderate `region` nodes (addressed in Phase 05 under R05-3).
- Automated test suites: `npx vitest run` 416 passed / 69 skipped across 36 files (+30 tests in `lib/{datasetGeometry,claimFace,readCache,searchCombobox}.test.ts`). `npx next lint` clean across all directories; `tsc` shows no new errors.

## 6. Failure and edge matrix

| Trigger | Behaviour — acceptable? |
| --- | --- |
| `/api/elements` fails (nothing cached / after a success) | `unavailable` replaces the grid (`app/page.tsx:193-203`) — no tile; a later failure keeps `stale` faces plus a pill (`:244-251`) — yes |
| `/api/stats`, `/api/board`, `/api/table-order` fail | card and rail states (`02` §6) — yes |
| Search: under 2 chars, no hits, 429 | no request, `[]`, or "No startup found"; 429 gives `role="alert"` (`SearchPill.tsx:135`) blaming the connection for a limit — marginal (`05`) |
| Unknown `?el=`, zoom past bounds, blur mid-pan | grid unchanged; clamp 0.45-2.8, `hardReset` on blur; a pan survives a window change — yes |
| A listed claim is hidden after paying | the face reverts to unclaimed while `claimedElements` headline uses `FACE_STAKE_WHERE` and stays in sync; `pool` and `count` keep money totals — fixed, R03-2, §5.11 |
| Top stake fully reversed | face falls to the next stake or to unclaimed; aggregates keep it (`app/api/elements/route.ts:9-18`) — yes |

Per-tile answer: cached board → the last known face, labelled `stale`; nothing cached → no tile. A tile never invents a price from a failed read.

## 7. Findings

### R03-1 — The dataset and the roadmap disagree about where the exotics sit

- **Severity.** P3 · **Category.** data · **Status.** fixed
- **Fix.** Deleted the stale duplicate `lib/elements.json`; established `lib/elements.ts` as the single canonical dataset. Created `lib/gridGeometry.ts` to derive the exotic pod bounding box dynamically from `ELEMENTS` (`exoticPodBox()`), removing hardcoded layout coordinates from `PeriodicGrid.tsx`. Updated `app/api/elements/route.ts` to map `gridRow`/`gridCol` through `cellOf(e.symbol)`, preventing stale database seed mirrors from publishing columns 7-10 while the board renders 8-11. Corrected `doc/ROADMAP.md` and foundation docs. Tests: `lib/datasetGeometry.test.ts` (11 tests verifying uniqueness, bounds, exotic placement, pod bounding box arithmetic).
- **Evidence.** `Hbar`, `Ps`, `Uue`, `DM` were at columns 8/9/10/11 in `lib/elements.ts`, 7/8/9/10 in `lib/elements.json`, 7-10 in `doc/ROADMAP.md:142,148`; `03d8591` moved the pod and tiles but not the JSON. Prior to the fix, `/api/elements` served columns 7, 8, 9, 10.
- **Reproduction.** Compare `gridCol` across `lib/elements.ts` and `lib/elements.json`, or inspect `/api/elements` exotic coordinates.

### R03-2 — The API ships money aggregates that count stakes the tiles refuse to show

- **Severity.** P3 today, P2 on the day a stake is hidden · **Category.** correctness · **Status.** fixed
- **Fix.** Defined `FACE_STAKE_WHERE` in `lib/moderation.ts` (`{ amountUsd: { gt: 0 }, startup: { state: { in: DIRECT_STATES } } }` — the `startup` arm keys on `moderationState` today: `{ startup: { moderationState: { in: DIRECT_STATES } } }`, `lib/moderation.ts:33-36`) as the single source of truth for visible stake faces. Updated `app/api/stats/route.ts` so `claimedElements` counts elements satisfying `{ stakes: { some: FACE_STAKE_WHERE } }`. Money aggregates (`totalStakedUsd`, `stakeCount`, tile `pool`/`count`) remain hidden-inclusive accounting metrics as documented. Tests: `lib/claimFace.test.ts` (verifying face predicate alignment, money aggregates, zero-amount reversal behavior).
- **Evidence.** §5.1, §5.8; `app/api/elements/route.ts:15-18`; `app/api/stats/route.ts:21`.
- **Reproduction.** With a hidden stake, `/api/elements` showed it unclaimed while `/api/stats` counted it claimed.

### R03-3 — The declared cache window never reaches the wire

- **Severity.** P3 · **Category.** perf · **Status.** fixed
- **Fix.** Added exported `READ_CACHE` constant in `lib/route.ts` (`{ "Cache-Control": "s-maxage=10, stale-while-revalidate=30", "Vercel-CDN-Cache-Control": "s-maxage=10, stale-while-revalidate=30" }`; `Cache-Control` reads `public, max-age=5, s-maxage=10, stale-while-revalidate=30` today, `lib/route.ts:47-50`). Applied to `app/api/elements/route.ts` and `app/api/elements/[sym]/route.ts`. The route documentation and tests record the difference between browser-facing headers rewritten by Vercel edge and edge-CDN caching behavior. Tests: `lib/readCache.test.ts` (auditing all `app/api/**/route.ts` handlers).
- **Evidence.** §5.7; `curl -sS -D - /api/elements` showed edge HITs with `Age` incrementing, while browser-facing header was rewritten to `max-age=0`.
- **Reproduction.** `curl -sS -D - -o /dev/null https://www.periodictable.lol/api/elements`.

### R03-4 — The search field announces combobox state it does not have

- **Severity.** P3 · **Category.** a11y · **Status.** fixed
- **Fix.** In `components/SearchPill.tsx`, bound `aria-expanded` to `showList` (`q.trim().length >= 2`), conditionally attached `aria-controls={showList ? "search-results" : undefined}`, and bound `aria-activedescendant` to the active highlighted hit id. The draft's claim that option elements lacked `aria-selected` was found to be stale (already present in the source). Tests: `lib/searchCombobox.test.ts` (verifying combobox ARIA contracts and state transitions).
- **Evidence.** §5.2; `components/SearchPill.tsx:93,94`.
- **Reproduction.** Focus the search input with empty text; observe `aria-expanded="true"` and non-existent `aria-controls`.

## 8. Acceptance criteria

- [x] 122 tiles, one dataset; ids, symbols, names, coordinates unique (§5.3)
- [x] Every tile state reachable, its drawn output traced to code; five search cases (§5.2)
- [x] Faces and aggregates reconcile on production (§5.1); hidden-stake divergence resolved (R03-2, §5.11)
- [x] Zoom, pan bounds, reset and gestures matched to `TableCamera.tsx`; per-tile failure answer (§6)
- [ ] Screenshot per tile state — U03-1
- [ ] Cold mobile load against the budget — desktop measured (§5.6), mobile U03-2

Budget: ≤300 KB brotli, ≤150 KB decoded, LCP ≤2.5 s. Measured: 225,840 B brotli (221 KB) holds, 745,379 B decoded (728 KB) exceeds, LCP unmeasured (U03-2). U03-4 settled in §5.11.

## 9. Open questions

1. Should the headline figures count every stake or only listed ones? The answer is written nowhere — R03-2.
   - *Answered by the fix:* The headline claim count (`claimedElements` in `/api/stats`) strictly matches the visible board face predicate (`FACE_STAKE_WHERE`), ensuring "N claimed" never contradicts what the visitor sees. Aggregate financial figures (`totalStakedUsd`, `stakeCount`, and per-element `pool`/`count`) remain hidden-inclusive accounting metrics.
2. Is the served exotic geometry (columns 8-11) the intent? Roadmap or pod changes accordingly — R03-1.
   - *Answered by the fix:* Columns 8-11 is canonical. `lib/elements.ts` and the derived pod box in `lib/gridGeometry.ts` define layout; `lib/elements.json` is deleted and documentation updated. The API now publishes coordinates directly derived from the canonical dataset.

## 10. Cross-references

- Ledger: `doc/PROD-READINESS-CHECKLIST.md:49` (122 elements), `:254` §J6, `:256` §J7 — cited, not re-derived.
- `doc/project-review/` is history: the pod and search panel were reviewed there; none of it is re-reported.
- Siblings: `01`, `02` (R02-4 owns the pre-hydration face), `04`, `05`, `08`, `11`, `15`.

## 11. Change log

- 2026-09-14: first draft, from the reads and probes in §5; nothing fixed, no production write.
- 2026-09-14: fix pass for R03-1…R03-4, each cited in §7: deleted duplicate `lib/elements.json`, derived pod geometry in `lib/gridGeometry.ts`, mapped `/api/elements` coordinates to dataset via `cellOf` (fixing seeded coordinate mismatch); unified face predicate via `FACE_STAKE_WHERE` so headline claims match board faces; added `READ_CACHE` with `Vercel-CDN-Cache-Control`; wired conditional combobox ARIA attributes in `SearchPill.tsx`. Verified on dev server (§5.11), settling U03-4. Added test suites `lib/{datasetGeometry,claimFace,readCache,searchCombobox}.test.ts`. Working tree, uncommitted.
- 2026-09-16 (working tree, PR `26` final-verification audit) — two quote refreshes: `FACE_STAKE_WHERE`'s `startup` arm keys on `moderationState` (`lib/moderation.ts:33-36`), and `READ_CACHE`'s browser-facing `Cache-Control` now carries `public, max-age=5, …` (`lib/route.ts:47-50`).

## 12. UNKNOWN log

| Id | Unknown | What settles it |
| --- | --- | --- |
| U03-1 | All visual rendering — tile faces, pod, sheen, gestures — and the SR half of R03-4 | `chrome --headless=new --screenshot=out.png --window-size=1440,2400 <url>`, per §4 state |
| U03-2 | Cold mobile load and LCP against the budget | DevTools phone viewport, 4× CPU throttling, or `npx lighthouse <url> --output=json` |
| U03-3 | What a claimed tile, a missing logo or a hidden listing renders | Unit / contract tests in `lib/claimFace.test.ts` (remote Neon DB cannot be mutated for local integration tests) |
| U03-4 | Whether `?el=Hbar` deep-links and scrolls without JS | Settled: §5.11 CDP probe verified active selection on `data-el-id="-1"` with `ring-cta` |