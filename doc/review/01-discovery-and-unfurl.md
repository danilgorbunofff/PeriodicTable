# Phase 01 — Discovery and unfurl

| | |
| --- | --- |
| Phase | 01 |
| Batch | 1 |
| Status | draft — fixes applied (R01-1…R01-8) |
| Date reviewed | 2026-09-14 (fix pass 2026-09-14, §11) |
| Commit reviewed | `43fd252` |
| Reviewer | review agent |

**Required-but-not-run probes.**

| Probe | Why not run | Cleanup |
| --- | --- | --- |
| Neon read: `psql -f elements.sql` | No `DATABASE_URL` here; `/api/elements` covers it (§5.7) | None |
| Unfurl render (5 platforms) | Needs a post or a preview submission | Delete the post |
| Search Console: verify, submit, read Pages | Operator's Google account (U01-2) | None |

## 1. Scope

**Owns.** Plan §1 **S1 × L1, L2, L6, L7**: what a crawler or unfurl bot receives, what `robots.txt` and the sitemap claim, whether one canonical URL per entity exists, whether an element page is reachable.

**Does not own.** 02-11 (09 owns profile share), 14, 15, 19, 20.

**Paths.** `app/sitemap.ts`, `app/robots.ts`, `app/og/[sym]/route.tsx`, `app/api/elements/route.ts`; `app/layout.tsx:17-22`, `app/elements/[sym]/page.tsx:13-25,83-92,126-135`, `app/s/[domain]/page.tsx:46`, `components/Tile.tsx:34-41`, `lib/validate.ts:45-75`, `lib/env.ts:11`.

## 2. Actors

| Actor | Applies | Checked |
| --- | --- | --- |
| Anonymous visitor | yes | Preview; reachability |
| Paying customer | partial | Their shared profile |
| Defending holder | partial | Leader on the card |
| Losing bidder | n/a at S1 | — |
| Operator | yes | Robots/sitemap; host |
| Attacker | yes | Open `og`, profile routes |
| Crawler / unfurl bot | yes — primary | Metadata, sitemap |
| Email recipient | partial | Canonical-host links |
| Payment provider | n/a before checkout | — |
| Future maintainer | yes | Comments match code |

## 3. Intended behaviour

1. Sitemap = board + 122 element pages; profiles excluded (`app/sitemap.ts:1-16`).
2. The "internal surfaces" comment misses `/api/`, `/og/`, `/go/`, `/s/` (`app/robots.ts:12`).
3. `app/layout.tsx:17-22`: title and description only — no `metadataBase`, OG/Twitter, canonical.
4. Element pages meant to index: metadata `page.tsx:13-25`; `ItemList` `:83-92`, rendered `:135`.
5. Share image: DB-backed SVG, 404 on unknown symbol (`app/og/[sym]/route.tsx:1-19`); R01-8.
6. Profiles gated on stakes (`app/s/[domain]/page.tsx:46`); tiles are `<button>` (`components/Tile.tsx:34-41`).

## 4. The path, walked

1. A stranger pastes the link (apex 308s to www — §5.8); a platform crawler fetches it.
2. The cache answers with no OG/Twitter/canonical/JSON-LD (§5.1): text-only unfurl (R01-1).
3. Googlebot finds no `Sitemap:` in `robots.txt`, guesses `/sitemap.xml` (R01-5, R01-6).
4. `/elements/<Sym>` serves metadata but links back only via `/?el=` (R01-3, R01-4); a shared profile 404s without stakes (§5.9).
5. **Irreversible point: none — all reads.**

## 5. Live evidence

Probes **2026-09-14** on `https://www.periodictable.lol`.

**5.1 Home** — 149431 B; no OG/Twitter/canonical/JSON-LD; no `/elements/` link.

**5.2 Element** — `/elements/H` 200; og 3, twitter 4, canonical 0.

**5.3** `og:image` absolute; no `metadataBase` (grep).

**5.4** Six bot UAs × two URLs byte-identical.

**5.5** X/LinkedIn reject SVG; render is U01-1.

**5.6** `robots.txt` 104 B, no `Sitemap:`; 123 `<loc>`, `lastmod` = render time.

**5.7** Element set 122 = 122 = 122 (static, API, sitemap); diffs `[]`.

**5.8** `/og/H` SVG 1200×630; apex 308 → www; `/elements/h` 404 (cache headers → 15).

**5.9** `/?el=H` = `/`; `/s/*` without stakes 404; no canonical.

**5.10** Hostile inputs throw in `lib/validate.ts` (→14).

**5.11** 0 stakes/claimed/VISIBLE (checklist §5).

**5.12 Fix verification** — 2026-09-14, `next dev` on `127.0.0.1:3111` against the same remote DB (122 elements, 0 `Stake` rows), after the fix pass in §11. Same reader as §5, so the two sets are comparable:

- `/` — 6 `og:` + 4 `twitter:` tags, canonical `https://www.periodictable.lol`, `og:image` `https://www.periodictable.lol/og/home`; 122 `href="/elements/`.
- `/og/home` — 200 `image/png` 1200×630, 22345 B; `/og/H` — 200 `image/png` 1200×630, 20221 B, unclaimed branch (the DB holds no stakes); `/og/hydrogen` — 404 JSON.
- `/robots.txt` — `Sitemap: https://www.periodictable.lol/sitemap.xml`; `/sitemap.xml` — 123 `<url>`, 0 `lastmod`, two runs 2 s apart byte-identical.
- `/?el=H` — canonical `https://www.periodictable.lol`; `/elements/H` — self-canonical with absolute `og:image`.
- Tiles, real browser input (agent-browser, Chrome via CDP): middle-click on `Au` opens `/elements/Au` in a new tab; a plain left click opens the drawer without navigating; Space on a focused tile opens the same drawer. axe-core 4.12.1 on `/` — 1 moderate `region` (pre-existing) and no new violation.
- Suites: `npx vitest run` 340 passed / 69 skipped; `npx next lint` clean on every touched file; `npm run typecheck` reports only the pre-existing `STRIPE` union errors in `app/api/checkout/route.ts`, `app/api/webhooks/stripe/route.ts`, `lib/settle.ts`, `lib/reconcile.test.ts`, `lib/webhook.test.ts`.
- Known left alone: the floating card at `left-[18px] top-[18px] z-[--z-cards]` (`app/page.tsx`) covers the centre of 13 tiles, `H` among them, so those tiles' click points belong to the card. Pre-existing, unrelated to the tile change, and not owned by this phase.

## 6. Failure and edge matrix

| Trigger | Current behaviour | User sees | Operator sees | Acceptable? |
| --- | --- | --- | --- | --- |
| Root shared | No OG/Twitter (§5.1) | Text-only | Nothing | No — R01-1 |
| Element shared | SVG card (§5.5) | Uncertain | Nothing | No — R01-2 |
| `robots.txt` read | No `Sitemap:` (§5.6) | n/a | Guessing only | No — R01-6 |
| Sitemap read | `lastmod` = now (§5.6) | n/a | False recrawl dates | No — R01-5 |
| Element link hunted | Four links (§5.1) | Sitemap only | Orphans | No — R01-3 |
| CTA followed | `/?el=H`, same bytes (§5.9) | Duplicate URL | None | No — R01-4 |
| `/s/<domain>` shared | 404, no stakes | Broken preview | Expected | Yes for now |
| `/og/H`, Neon down | `route.tsx:9` → 500 | No image | Trace in logs | No — R01-2 |

State as reviewed (commit `43fd252`). The 2026-09-14 fix pass closes R01-1…R01-8 — see §5.12 and the status on each finding in §7.

## 7. Findings

### R01-1 — The home page ships no social metadata at all

- **Severity.** P2 · **Category.** seo · **Status.** fixed
- **Fix.** `lib/shareMeta.ts` `homeMetadata()` — `metadataBase` from `siteOrigin()`, `alternates.canonical: "/"`, an `openGraph` block (absolute `/og/home`, 1200×630, alt) and a matching `twitter` block — is now the root layout's metadata (`app/layout.tsx`), so `/` serves 6 `og:` and 4 `twitter:` tags. Tests: `lib/shareMeta.test.ts`. Live: §5.12.
- **Evidence.** §5.1; `app/layout.tsx:17-22` sets title/description only; no `metadataBase` (§5.3).
- **Reproduction.** `curl -s https://www.periodictable.lol/ | grep -c 'property="og:"'` → `0`.
- **Proposed fix.** Add `openGraph` (type `website`, `siteName`, `description`, `images: [{ url: "/og/home", width: 1200, height: 630 }]`), a matching `twitter` block, `alternates.canonical: "/"` and an explicit `metadataBase`. Prove with a test asserting ≥ 4 `og:` tags and an absolute `og:image` on www.

### R01-2 — The share image is an SVG, which card consumers do not accept

- **Severity.** P2 · **Category.** seo · **Status.** fixed
- **Fix.** `app/og/[sym]/route.tsx` builds a `next/og` PNG (`lib/ogCardImage.tsx`), keeps the unclaimed branch and the domain clamp (U01-3), and falls back to the escaped SVG (`lib/ogCard.ts`) instead of 500ing: the Prisma read is inside `try/catch`, connection-class codes retry three times, and an unknown symbol is a 404 JSON. `app/og/home/route.tsx` is the home card. Tests: `lib/ogCard.test.ts`, `lib/shareMeta.test.ts`. Live: §5.12.
- **Evidence.** `app/og/[sym]/route.tsx:6,19` ("*SVG to avoid native deps*", `image/svg+xml`); §5.5, §5.8; per-platform rendering is U01-1.
- **Reproduction.** `curl -sI https://www.periodictable.lol/og/H` → `content-type: image/svg+xml`; the LinkedIn Post Inspector then shows no image.
- **Proposed fix.** Serve a raster card on the same path: `next/og`'s `ImageResponse` (PNG, embedded font subset), keeping the "Unclaimed · from $5" branch, clamping the domain line (U01-3), and wrapping the Prisma read in `try/catch` with a static fallback so a Neon outage cannot 500 a preview. Prove with a test asserting `Content-Type: image/png`.

### R01-3 — No element page has an inbound link; discovery rests on the sitemap alone

- **Severity.** P2 · **Category.** seo · **Status.** fixed
- **Fix.** `components/Tile.tsx` is an `<a href="/elements/<Sym>">` that keeps the old button behaviour on a plain left click (`preventDefault()` then `onSelect`), lets modifier and middle clicks through to the browser, keeps the drag guard and binds Space (a link does not activate on Space); `components/PeriodicGrid.tsx` focus lookup now selects `a`. Tests: `lib/shareMeta.test.ts` (source asserts), `lib/a11y.test.ts` unchanged and green. Live: §5.12 — 122 `href="/elements/` and no new axe violation.
- **Evidence.** §5.1 (no `/elements/` in the home document); `components/Tile.tsx:34-41` (tiles are `<button>`, never anchors); the element page's only own-site link is `/?el=` (`app/elements/[sym]/page.tsx:126-131`).
- **Reproduction.** `curl -s https://www.periodictable.lol/ | grep -c '/elements/'` → `0`.
- **Proposed fix.** Make each tile a base `<a href="/elements/<Sym>">` whose `onClick` calls `preventDefault()` and then does what the button does today. Prove by asserting ≥ 20 `href="/elements/` in `/`.

### R01-4 — No `rel="canonical"` anywhere, and the only link to the board is a query duplicate

- **Severity.** P3 · **Category.** seo · **Status.** fixed
- **Fix.** `alternates.canonical` on `/` (through `homeMetadata`), `/elements/[sym]` and `/s/[domain]`; the element page's card URL is absolute from `siteOrigin()`, so canonical, card and sitemap cannot disagree. Tests: `lib/shareMeta.test.ts`. Live: §5.12.
- **Evidence.** §5.1, §5.2 (0 canonical tags; no `alternates` in `app/layout.tsx:17-22`); §5.9 (`/?el=H` → 200, 149431 bytes, the same document as `/`), the element CTA's destination (`:126-131`).
- **Reproduction.** `curl -s https://www.periodictable.lol/elements/H | grep -c 'rel="canonical"'` → `0`.
- **Proposed fix.** Set `alternates.canonical` on `/` and `/elements/[sym]` so `?el=` folds into `/`. Prove with a test asserting the tag on both routes.

### R01-5 — Every sitemap URL claims to have changed when the sitemap was rendered

- **Severity.** P3 · **Category.** seo · **Status.** fixed
- **Fix.** `app/sitemap.ts` reads stamps from `MAX(Stake.updatedAt)` per element plus the newest overall for `/` (`lib/sitemapData.ts` `buildSitemapEntries`) and omits `lastmod` where there is nothing truthful to say, with `revalidate = 3600`. Tests: `lib/sitemapData.test.ts` (both generations, stamped and unstamped). Live: §5.12.
- **Evidence.** `app/sitemap.ts:14-15` (`lastModified: new Date()` on all 123 entries); §5.6 (all identical, unchanged 41 minutes later); sitemaps.org defines `lastmod` as the page's last modification and Google schedules recrawls from it (vendor docs, 2026-09-14).
- **Reproduction.** `curl -s https://www.periodictable.lol/sitemap.xml | grep -o '<lastmod>[^<]*' | sort -u | wc -l` → `1`, moving whenever the cached rendering regenerates.
- **Proposed fix.** Drop it, or derive it from `Stake.updatedAt` (`prisma/schema.prisma:161`): per-element `MAX`, the newest overall for `/`, omitted when there are no stakes. Prove with a two-generation test.

### R01-6 — `robots.txt` declares no `Sitemap:` directive

- **Severity.** P3 · **Category.** seo · **Status.** fixed
- **Fix.** `app/robots.ts` returns `sitemap: \`${siteOrigin()}/sitemap.xml\`` — the same origin helper the sitemap itself resolves, so the directive and the URLs it points at cannot drift apart. Test: `lib/shareMeta.test.ts`. Live: §5.12.
- **Evidence.** `app/robots.ts:8-14` returns only `rules`, no `sitemap` key; §5.6 (104-byte file), so the sitemap is found only if a crawler guesses `/sitemap.xml`.
- **Reproduction.** `curl -s https://www.periodictable.lol/robots.txt` → no `Sitemap:` line.
- **Proposed fix.** Add `sitemap: \`${base}/sitemap.xml\`` to the `robots()` return, using the sitemap's own `base` expression, and record a Search Console submission. Prove by re-reading `/robots.txt`.

### R01-7 — The sitemap host comes from an unvalidated variable whose absence nothing detects

- **Severity.** P3 · **Category.** ops · **Status.** fixed
- **Fix.** `lib/siteUrl.ts` `siteOriginStrict()` throws when `NEXT_PUBLIC_APP_URL` is unset or malformed in production (outside the build phase), and `app/sitemap.ts` plus the metadata helpers read the host through it, so a hostless deploy fails the sitemap loudly instead of shipping the apex. Test: `lib/siteUrl.test.ts`. The email fallback (`lib/email.ts`) stays 10's.
- **Evidence.** `app/sitemap.ts:12` falls back to **apex** while production serves **www** (§5.8); `lib/env.ts:164` defines `requireProdEnv`, but `lib/env.ts:11` records it "has no call site yet" (also `app/api/jobs/config/route.ts:10-11`), so nothing fails when the variable is missing.
- **Reproduction.** Not runnable here without a production write (probe table); the path is readable at `app/sitemap.ts:12` and `lib/env.ts:11`.
- **Proposed fix.** Fail loudly: call `requireProdEnv()` from an instrumentation or health path, or throw in `app/sitemap.ts` when `NEXT_PUBLIC_APP_URL` is unset in production. The same variable's `http://localhost:3000` fallback (`lib/email.ts:11`) is 10's to report.

### R01-8 — The OG card interpolates stored strings into SVG markup unescaped

- **Severity.** P3 · **Category.** security · **Status.** fixed
- **Fix.** `lib/ogCard.ts` `escapeXml()` escapes `& < > " '` for all four interpolated values in the SVG fallback; the PNG path builds no markup at all, because satori takes text nodes. Test: `lib/ogCard.test.ts` asserts the entities and the absence of raw `<`.
- **Evidence.** `app/og/[sym]/route.tsx:18` interpolates `element.symbol`, `element.name`, `leader.startup.domain` and `leader.amountUsd` unescaped, served from the product's own origin (`:19`); the only control is upstream validation (`lib/validate.ts:1-30,45-75`), and §5.10 records hostile inputs whose markup-bearing forms all throw — no reachable injection today.
- **Reproduction.** No working exploit found; this is the check: the five markup-bearing inputs in §5.10 all throw before storage.
- **Proposed fix.** Add an escape helper (`&<>"'`) for the four interpolated values so the property stops depending on the validator staying correct, with a unit test asserting escaped entities and no raw `<`. Load-bearing once R01-2 moves to `ImageResponse`.

## 8. Acceptance criteria

- [x] `/` has ≥ 4 `og:` tags and an absolute `og:image` returning `image/png` — 6 `og:` tags, `og:image` `https://www.periodictable.lol/og/home`, `/og/home` → `image/png` (§5.12).
- [x] `/` and `/elements/H` self-canonicalise; `/?el=H` folds to `/` — both carry the tag and `/?el=H` reads `https://www.periodictable.lol` (§5.12).
- [ ] `/og/H` is `image/png` and renders in the LinkedIn Inspector — the type is `image/png` at 1200×630 (§5.12); the Inspector reading is still U01-1, operator.
- [x] `/robots.txt` carries `Sitemap:`; `/` has ≥ 20 `href="/elements/` — one directive; 122 hrefs (§5.12).
- [x] Two sitemap runs with no data change agree on `lastmod` — byte-identical, 123 URLs, no `lastmod` while the DB holds 0 stakes (§5.12); `lib/sitemapData.test.ts` covers the stamped generation too.
- [x] Card text escaped by unit test; OG route falls back, not 500 — `lib/ogCard.test.ts`; the route catches the read, retries connection-class codes, then serves the escaped SVG (§5.12).
- [ ] Search Console: `www` verified, sitemap submitted (U01-2) — operator.

## 9. Open questions

1. **R01-2 renderer:** `next/og` on the same URL (recommended) vs a raster library vs build-time PNGs. **Settled 2026-09-14:** `next/og`, the recommended option, with the escaped SVG kept as the fallback.
2. **Index the 122 unclaimed pages?** Recommended once R01-3 links them; else `noindex`. Still the operator's call.
3. **Keep `lastModified`?** Recommended: from `Stake.updatedAt`, omitted when empty. **Settled 2026-09-14:** implemented exactly that (`lib/sitemapData.ts`), because the empty DB made "omit" the only truthful answer available.

## 10. Cross-references

- Plan §1, §4 (P2/P3), §5 row 01.
- `doc/PROD-READINESS-CHECKLIST.md` §5 "HIDDEN leaks" settles the deliberate `/s/[domain]` exclusion, hidden-profile 404s and `/api/admin/` hygiene; §2 the row count and `/api/stats`; "Pre-announce cleanup applied" the empty production. R01-6 is only the missing directive.
- `doc/project-review/files/review-findings.md` **P2-13** is the ancestor; its asks are done, which is why §3 reads as correct.
- Evicted: cache headers → 15; hostile input → 14; 404/500 bodies → 02; profile share → 09; email fallback → 10; Search Console → 19.

## 11. Change log

| Date | Commit | Change |
| --- | --- | --- |
| 2026-09-14 | `43fd252` | First pass; R01-1…R01-8 raised, U01-1…U01-3 opened. |
| 2026-09-14 | working tree, uncommitted | Fix pass for R01-1…R01-8, each cited on its own finding in §7: home OG/Twitter/canonical and `/og/home`, PNG cards with an escaped SVG fallback, tiles as real element links, canonicals on the element and profile routes, truthful `lastmod`, `Sitemap:` in robots, a strict origin helper, and the domain clamp that settles U01-3. Verification recorded in §5.12; tests `lib/{siteUrl,ogCard,sitemapData,shareMeta}.test.ts`. |

## 12. UNKNOWN log

| ID | Phase | Category | What is unknown | What settles it |
| --- | --- | --- | --- | --- |
| U01-1 | 01 | seo | Do platforms render the card; is the apex followed? | Post the element URL into X, Slack, Discord, iMessage and the LinkedIn Inspector; read, then delete. |
| U01-2 | 01 | seo | Has Google the sitemap; are the 122 element pages indexed? | Search Console → verify `www` → submit the sitemap → read Pages. |
| U01-3 | 01 | seo | Does a 30+ character leader domain overflow the 640 px column? **Settled 2026-09-14:** the card clamps the domain to 24 characters with an ellipsis (`clampDomain`, `lib/ogCard.ts`) and the headline is sized against a fixed 760 px column, so no domain can reach the edge; `lib/ogCard.test.ts` asserts the cap. The original probe stays for the record. | `curl -s https://www.periodictable.lol/og/<sym>` when a long leader exists. |
