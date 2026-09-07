# PERIODICTABLE.LOL — Comprehensive Roadmap
### A worldmap.lol Twin, Rebuilt for the Periodic Table

> **Tagline:** "Put your startup on the table. Literally."
> **Concept:** Every chemical element is an open, multi-tenant leaderboard ranked by total stake. Startups plant their flag from $5, take the #1 Crown, get outbid, and top-up to reclaim. Visually and logically identical to worldmap.lol, but on an 18-column periodic canvas with 122 nodes.
> **Source inputs:** `*.txt` master spec (333 lines, v1) + `/images/` reference set (15x worldmap.lol screenshots, 09:40–09:56).
> **Doc location:** `/doc/ROADMAP.md` — product & architecture authority.
> **Visual authority:** `/doc/DESIGN-SYSTEM.md` (post-review). If this file and DESIGN-SYSTEM conflict on look, **DESIGN-SYSTEM wins**.
> **Audit:** `/doc/REVIEW.md` — what was wrong vs the 15 worldmap.lol screenshots.

---

## 0. TL;DR — What We Are Building

| # | Decision | Detail |
|---|----------|--------|
| 1 | **122 nodes** | 118 IUPAC elements (1–118) + 4 theoretical top-gap exotics in Row 2 gap: Antihydrogen (-1), Positronium (0), Ununennium (119), Dark Matter (∞) |
| 2 | **$5 unified floor** | Every tile starts at $5. No tiers, no gates. Status = culture + competition |
| 3 | **Never sells out** | Unlimited stakers per element. #1 owns the tile face, #2…#N live ranked in the drawer |
| 4 | **Cumulative equity** | Stake never expires. Reclaim = `(Current #1 + $1) − Your Prior Stake` |
| 5 | **worldmap.lol clone** | Near-black stage, **floating** table object, white porcelain cards, chunky CTA `#FFC93C` + lip `#8F6C17`, Plus Jakarta Sans, **persistent right rail** (World Order → Territory), 3 modals, live activity, light-theme startup profile |
| 6 | **Tile lifecycle (MVP)** | White unclaimed → **flat** family pastel + logo + optional 👑. No metal/glass/cosmic shaders until Phase 6 |
| 7 | **MVP first** | Static grid + drawer + fake data → real DB + checkout → emails + clicks + leaderboard + launch |

---

## 1. What worldmap.lol Does Right (Distilled from `/images/` References)

Analyzed all 15 screenshots. These are the patterns we must replicate 1:1 in look, feel, and logic:

### 1.1 Global viewport pattern
- **Full-viewport interactive canvas, no page scroll on desktop.** The map/table IS the page.
- **Everything floats.** All UI is `position:fixed/absolute` white cards with `rounded-3xl + shadow-2xl` over the canvas. Nothing pushes or resizes the grid.
- **3 anchored clusters + 1 persistent rail:** top-left hero, top-right stats, bottom-left activity. **Right rail is ON by default** showing World Order (top spenders). Tile click swaps the rail to Territory. ✕ returns to World Order.
- **The table floats** in dark margin like the globe — it is not an edge-to-edge spreadsheet.
- **Canvas auto-pan:** clicking far-right columns shifts the table ~120px left so the rail never covers the selected tile.
- **Dismissal trinity:** `Esc` + `✕` + backdrop click. Every modal/drawer obeys it.

### 1.2 Top-left hero stack (the money component)
- Wordmark pill: `periodictable` ink + `.lol` **yellow**.
- Main card `w-[360px] p-5`: H1 only — `Put your startup on the table. Literally.` **No subtitle.**
- Same row: hug-content chunky CTA `[ Claim an element · from $5 ]` + 32px circles `🏆 (i) 🔍` (search gets a yellow ring when open).
- Search pill slides **under** the card: icy input + **navy** arrow button. Enter jumps to tile + opens Territory rail.
- Lesson: **one headline, one CTA, three icons.** No nav, no subtitle, no full-width button.

### 1.3 Top-right stats card (social proof in 3 lines)
- `rounded-2xl shadow-xl px-4 py-3`, 3 rows: `🧪 122 elements live` / `💰 $X in bids` / `N unclaimed · from $5` (do **not** copy worldmap’s `on sale · $3` until a sale rule exists).
- Updates after checkout. No sparklines.

### 1.4 Bottom-left live activity (FOMO engine)
- Card `w-[300px]`: header `🟢 Live activity` + rotating Geo-IP line (`Someone in Prague is online` / `Singapore` / `São Paulo`).
- Feed rows: favicon + `domain.com  $7` + subline `#1 in SA Saudi Arabia · 1d ago` (for us: `#1 in C Carbon · 1d ago`).
- Footer: `409 visitors · 72h   8 watching`. Numbers tick via polling/SSE, not realtime sockets in MVP.
- Lesson: **activity = domain + price + rank + recency.** Copy this row layout exactly for elements.

### 1.5 Tile / country states
- **Unclaimed = porcelain white + ink + hairline.** Empty land.
- **Claimed = flat family pastel + logo pin.** No textures.
- **Contested = 👑 only.** No diamond/cosmic crowns in MVP.
- Hover: lift `scale 1.04` + tooltip (`Symbol · Name · #1 $X` or `Unclaimed · $5`).

### 1.6 Right rail (World Order + Territory — never empty on desktop)
- Persistent ~400px white rail. Default = **World Order** (`THE TABLE · LIVE`, top spenders). Tile click swaps to Territory. ✕ returns to World Order. ⤢ expands / opens profile.
- **Unclaimed:** `UNCLAIMED TERRITORY` → `C Carbon` → `BE THE FIRST · $5` → icy `?` card → chunky `[ Be the first — from $5 ]` → `plant your flag · rank is your total stake`.
- **Claimed:** `CLAIMED TERRITORY` → `C Carbon` → gold `X bidding · #1 pays $Y` → gold-wash #1 (👑 + logo + domain + pitch + money) → quiet #2…#N → sticky `[ Claim a spot — for $X ]` (`X = #1 + 1`) → `rank is your total stake · top up to climb`. **No** extra “join from $5” link.
- **Hover preview (left of rail):** screenshot or `loading preview…`, full pitch, gold URL, clicks, **`View profile →`** (routes to light-theme `/s/[domain]`).

### 1.7 Modals (3) + profile page
1. **How it works `(i)`:** `How` **claiming** `works` + flask. Icy step cards with icon squares (flag / chart / recycle). Disclaimer + chunky `Got it` + legal links. Not “synthesis”.
2. **Checkout:** `Stake on` **Carbon** + flag. Icy tabs + icy inputs. Live `👑 $X takes #1…`. Chunky continue. Whop line. `maybe later`.
3. **Board `🏆`:** `The` **board**. Tabs are **three metrics**: By Element (biggest single-tile stake) · #1 Crowns (crown count) · Early Adopter (first-claimer medals).
4. **Profile `/s/[domain]`** (not a modal): light `#EFF5FC` page — banner, mini-table, navy Visit site, elements-held cards. See DESIGN-SYSTEM §6.

### 1.8 Design tokens
**Do not use the old `#0e1b2e` / `#fab828` set.** Copy `/doc/DESIGN-SYSTEM.md` §2 exactly (`stage #05070A`, `cta #FFC93C`, `cta-lip #8F6C17`, `icy #F2F7FC`, `money #C8892A`, `muted #8497AE`).

---

## 2. Product Definition — periodictable.lol

### 2.1 One-liner
An uncapped, multi-tenant cumulative staking auction ("King of the Hill") for startup advertising on a living periodic table.

### 2.2 Core loop
1. Founder lands → sees white ocean of open elements + a few colored claimed ones.
2. Clicks element → drawer shows rank ladder + exact price to lead.
3. Stakes → logo on tile face (if #1) + rank row + activity feed entry + stats bump.
4. Gets outbid → transactional email `Reclaim C for $2.00` → one-click top-up.
5. Reclaims → crown back, clicks accrue, board rank climbs.

### 2.3 Non-goals (explicitly out of scope for MVP)
- No bidding wars timer, no expiry, no auction end. Stakes are permanent equity.
- No fractional ownership display. One #1 face per tile, rest ranked in drawer.
- No on-tile animation beyond hover lift. Elite/exotic sheens are static CSS gradients in MVP (animate in V2).

---

## 3. Economy & Staking Engine (Improved + Edge Cases)

### 3.1 Rules (lock these)
- **Floor:** `MIN_STAKE = $5` for first-ever stake on an element, and minimum for any new startup joining an element.
- **Takeover:** to become #1 you must hold `currentLeaderTotal + $1` (integer dollars, MVP).
- **Cumulative:** `userTotal[element][startup] = Σ all top-ups`. Top-ups add, never replace.
- **Reclaim cost:** `(current #1 total + 1) − yourPriorTotal`, floored at `$1`. Quote this exact number in drawer CTA, checkout line, and email.
- **No refunds, no withdrawals.** Stake = ad buy. State this in checkout + rules modal + footer (merchant compliance for Whop/Stripe).
- **Multi-tenant:** unlimited stakers per element. No "sold out" state exists.

### 3.2 Worked example (canonical test case)
1. A stakes `$20` on C → #1 A ($20).
2. B stakes `$21` on C → #1 B ($21), #2 A ($20).
3. A sees `[ Reclaim — for $2 ]` because `(21+1)−20 = 2`. A pays $2 → A total $22 → #1 A ($22), #2 B ($21).

### 3.3 Edge cases the v1 spec missed (now handled)
| Case | Rule |
|------|------|
| Tie attempt (`stake == #1`) | Rejected client + server: `must be ≥ #1 + $1`. Show `Add $N more to take #1` |
| Self top-up while #1 | Allowed, increases moat. CTA becomes `[ Increase moat — from $1 ]` |
| New joiner on contested tile | Must still pay `≥ #1 + $1` to take #1 instantly, OR pay `$5+` to join ladder at #N (drawer offers both: primary = take #1 price, secondary link = `join from $5`) |
| Outbid email race (A & B both top-up) | Recompute price at checkout open + before charge; never trust quoted price older than 5 min |
| Charge succeeds, DB fails | Webhook reconciliation job; idempotency key per checkout session |
| Click fraud | Count distinct `/go/:stakeId` redirects; rate-limit IP; show `clicks delivered` as verified redirects only |

### 3.4 Transactional re-engagement (copy lock)
- Trigger: leader loses #1. Send within 60s.
- Subject: `You were knocked off C (Carbon) 👑`
- Body: `B ([domain]) just took #1 with $21. Reclaim it for $2.00 → [ Reclaim now ]`
- Include unsubscribe + `it's an ad buy, past stake still counts` reassurance.

---

## 4. Table Geometry & Data

### 4.1 Grid (authentic 18-col + skyline exotics)
```
Row1: H(1,1) …………………………… He(1,18)
Row2: Li Be [ EXOTIC POD cols 7-10 ] B C N O F Ne
Row3: Na Mg [ (empty skyline) ]      Al Si P S Cl Ar
Row4: K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr
Row5-7: standard fill
Row9:  La-Lu (57-71) offset cols 4-17, placeholder ★ in col 3
Row10: Ac-Lr (89-103) offset cols 4-17, placeholder ★ in col 3
Exotics (Row2): H̄(-1,c7) Ps(0,c8) Uue(119,c9) DM(999,c10)
Pill tag above pod: 🌌 EXOTIC SECTOR · THEORETICAL NODES
```

### 4.2 Element seed fields
`id, symbol, name, atomicMass, gridRow, gridCol, family, tier` + `totalPoolUsd, currentLeaderId`.
Families: Alkali, AlkalineEarth, Transition, PostTransition, Metalloid, ReactiveNonmetal, Halogen, NobleGas, Lanthanide, Actinide, Exotic.
Tiers: `STANDARD` / `CULTURAL_ELITE` (Au Pt Si C U Ti) / `EXOTIC` (4).

### 4.3 Copy for exotics (drawer subtitles)
- **H̄ Antihydrogen (-1):** most expensive substance on Earth (~$62.5T/g, NASA). For deep-tech / quantum / advanced compute.
- **Ps Positronium (0):** electron+positron exotic matter. For crypto / ZK / edge.
- **Uue Ununennium (119):** gateway to Island of Stability. For frontier AI / robotics.
- **DM Dark Matter (∞):** 85% of galactic mass, invisible. For security / stealth / funds.

---

## 5. Visual Identity & Tile Lifecycle

### 5.1 Tile states (MVP = 2 fills + optional crown)
| State | Surface | Text | Badge |
|-------|---------|------|-------|
| 1 Unclaimed | `#fff`, hairline | ink number/symbol/`$5` | none |
| 2 Claimed | **flat** family pastel | ink + logo pin | 👑 if contested |
| Elite / Exotic | **same as claimed** + tiny caption | ink | 👑 only |

Metal / glass / cosmic shaders are **Phase 6**, not MVP. Worldmap paints every territory flat.

### 5.2 Family → pastel map (claimed fill)
- Alkali (G1): soft apricot `#ffedd5`
- Alkaline earth (G2): soft sand gold `#fef3c7`
- Transition (G3-12): soft sky blue `#e0f2fe`
- Post-transition (G13-16): soft slate gray `#f1f5f9`
- Metalloid: soft sage mint `#dcfce7`
- Reactive nonmetal: soft muted coral `#ffe4e6`
- Halogen (G17): soft aquamarine `#ccfbf1`
- Noble gas (G18): soft lilac lavender `#ede9fe`
- Lanthanide: soft salmon rose `#ffd9d4`
- Actinide: soft meadow green `#d9f2d0`
- Exotic: same porcelain + pastel as a neighboring family (or icy `#F2F7FC`) + caption `EXOTIC`

### 5.3 Bespoke finishes — NOT MVP
Parked in `doc/phase-6-v2/02-monetization-shaders.md`. Shipping them in Phase 4 would break the worldmap twin.

---

## 6. Viewport UI Architecture (worldmap.lol Twin Layout)

```
┌──────────────────────────────────────────────────────────────┐
│ [hero 360px]                              [stats pill]       │
│ [search pill (toggle)]                                       │
│                                                              │
│           FLOATING TABLE (~960px)        ┌──────────────┐   │
│           white + flat pastel tiles      │ RAIL ~400px  │   │
│                                          │ World Order  │   │
│ [activity 300px]                         │ (default ON) │   │
└──────────────────────────────────────────────────────────────┘
```
- Desktop: table **floats** center (~960px, tiles 46–52px, gap 6). Dark margin around it. Rail always visible. Mobile: table pans horizontally; rail = bottom sheet; hero stacks.
- z-order: stage 0 < table 10 < tooltip 30 < corner cards 40 < rail 50 < preview 60 < modals 70 < toasts 80.
- F-block rows linked with `★` placeholders. Full composition: DESIGN-SYSTEM §4.

---

## 7. Component Specs (Build-Ready)

### 7.1 Hero + search
- Files: `HeroCard.tsx`, `SearchPill.tsx`. State: `searchOpen, query`. Search matches `symbol/name/domain/title`; results dropdown (max 8) → click pans to tile + opens drawer.

### 7.2 Stats card
- Props: `elementsLive=122, totalBids$, onSaleCount`. Poll `/api/stats` every 30s. Optimistic +$ after checkout success.

### 7.3 Activity feed
- GET `/api/activity?limit=6`. Row: favicon (Google S2 fallback), domain + gold price, `#1 in {SYM} {Name} · {relTime}`. Geo header rotates from last 3 activity cities or `Someone in {city} is online`.

### 7.4 Right rail (most important — build with care)
- `Rail.tsx` with states `world-order | territory`. Default world-order.
- Territory: `UnclaimedView` + `ClaimedView` + `RankRow` + `HoverPreview`.
- World Order: top spenders across all elements (screenshot 094055).
- Must show (territory): eyebrow, `C Carbon`, subline, gold-wash #1, #2…#N, sticky take-lead CTA, microcopy. Preview has **View profile →**.
- Files also: `WorldOrder.tsx`, profile route `app/s/[domain]/page.tsx`.
- Auto-pan: if `gridCol >= 15`, translate canvas `-150px` on open (CSS transform, 300ms ease).
- Hover preview: absolute card left of drawer (`w-64`, screenshot 16:9, full pitch, URL, clicks). Prefetch `previewImgUrl` on row hover (debounce 150ms).

### 7.5 Modals
- Shared `Modal.tsx` (backdrop blur, Esc/backdrop/✕ close, focus trap, mobile bottom-sheet).
- HowItWorks, Checkout (`tabs, URL validation, min-price calc, live 👑 line, Whop redirect, maybe later`), Board (3 tabs, medals, gold totals).

### 7.6 Toasts + emails
- Toasts: `Staked! You're #1 in C 🎉` / `Outbid on C — reclaim for $2`. Emails via Resend/Postmark, template in `/emails/outbid.tsx`.

---

## 8. Key User Flows (Acceptance Tests)

1. **First claim:** land → click white tile → drawer UNCLAIMED → `[Be first — $5]` → checkout `$5` → success → tile turns pastel + logo, stats +$5, activity row appears, drawer switches to CLAIMED.
2. **Takeover:** click claimed (#1 $50) → CTA `[Claim a spot — $51]` → pay → crown flips, ex-leader emailed with exact reclaim price.
3. **Reclaim:** ex-leader opens email → drawer shows `[Reclaim — $2]` → pays difference → #1 restored.
4. **Join ladder cheap:** on contested tile, `join from $5` link → stakes $5 → appears #N, tile face unchanged.
5. **Discover:** 🔍 → type `car` → sees Carbon + startups → Enter → pans + opens.

---

## 9. Data Model (Prisma + Postgres, Improved v1)

```prisma
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }
generator client { provider = "prisma-client-js" }

enum ChemicalFamily { ALKALI_METAL ALKALINE_EARTH TRANSITION_METAL POST_TRANSITION_METAL METALLOID REACTIVE_NONMETAL HALOGEN NOBLE_GAS LANTHANIDE ACTINIDE EXOTIC_THEORETICAL }
enum PrestigeTier { STANDARD CULTURAL_ELITE EXOTIC }

model Element {
  id Int @id // 1..118, -1 Hbar, 0 Ps, 119 Uue, 999 DM
  symbol String @unique
  name String
  atomicMass String
  gridRow Int
  gridCol Int
  family ChemicalFamily
  tier PrestigeTier @default(STANDARD)
  totalPoolUsd Int @default(0)
  stakeCount Int @default(0)
  currentLeaderId String?
  stakes Stake[]
  @@index([family]) @@index([tier])
}

model Startup {
  id String @id @default(cuid())
  domain String @unique
  title String @db.VarChar(32)
  pitch String @db.VarChar(140)
  url String
  linkType String @default("product") // product | social
  logoUrl String
  previewImgUrl String?
  claimedAt DateTime @default(now())
  stakes Stake[]
}

model Stake {
  id String @id @default(cuid())
  elementId Int
  element Element @relation(fields: [elementId], references: [id])
  startupId String
  startup Startup @relation(fields: [startupId], references: [id])
  amountUsd Int // cumulative total
  clicksDelivered Int @default(0)
  rank Int @default(99)
  isLeader Boolean @default(false)
  updatedAt DateTime @updatedAt
  @@unique([elementId, startupId])
  @@index([elementId, amountUsd(sort: Desc)])
}

model Payment {
  id String @id @default(cuid())
  stakeId String
  amountUsd Int
  provider String // whop | stripe
  providerRef String @unique
  idempotencyKey String @unique
  status String @default("pending") // pending | paid | failed | refunded
  createdAt DateTime @default(now())
}

model ActivityLog {
  id String @id @default(cuid())
  domain String
  elementSymbol String
  amountUsd Int
  kind String @default("stake") // stake | reclaim | join
  city String?
  createdAt DateTime @default(now())
  @@index([createdAt(sort: Desc)])
}

model ClickEvent {
  id String @id @default(cuid())
  stakeId String
  ipHash String
  userAgent String?
  createdAt DateTime @default(now())
  @@index([stakeId, createdAt])
}
```

**Ranking invariant (server function, single writer):** after every paid top-up, recompute `rank/isLeader/currentLeaderId/totalPoolUsd/stakeCount` in a transaction. Never trust client rank.

---

## 10. API Contracts (MVP)

```
GET  /api/elements              → 122 tiles w/ leader, pool, count (cached 10s)
GET  /api/elements/:sym         → detail + ranked stakes[] + computed prices { takeLead, joinMin, reclaimFor[me] }
GET  /api/stats                 → { elementsLive, totalBids, onSale }
GET  /api/activity?limit=6      → feed rows
GET  /api/board?tab=crowns|by-element|early → leaderboard rows
POST /api/checkout              → { elementSym, startup{domain,title,pitch,url,linkType}, amountUsd, idempotencyKey } → { checkoutUrl }
POST /api/webhooks/whop         → verify → apply top-up → recompute → email if dethroned
GET  /go/:stakeId               → count click (rate-limited) → 302 to startup.url
GET  /api/search?q=             → up to 8 matches
```

**Price math (server, shared `pricing.ts`):**
```ts
takeLeadPrice = leader ? leader.amountUsd + 1 : 5;
joinMin = 5;
reclaimFor(userTotal) = leader ? Math.max(1, leader.amountUsd + 1 - userTotal) : 5;
```

---

## 11. Tech Stack (Recommended, Cheap + Fast)

- **Frontend:** Next.js 14 App Router + Tailwind + shadcn/ui + Framer Motion (drawer/modals). `Plus Jakarta Sans` via next/font.
- **Canvas:** CSS grid (not `<canvas>`) — tiles are buttons, accessible + SEO-friendly. Pan via CSS transform; zoom via `scale` buttons (+/−/reset) in MVP, pinch later.
- **Backend:** Next.js Route Handlers + Prisma + Postgres (Neon/Supabase). Redis (Upstash) for stats/activity cache + rate limits.
- **Payments:** Whop (per spec) + Stripe fallback. Webhook → idempotent ledger.
- **Email:** Resend, `outbid` + `receipt` templates.
- **Screenshots/logos:** Microlink/ScreenshotOne for `previewImgUrl` (async job after checkout) + Google S2 favicons as fallback.
- **Analytics:** Plausible + custom `clicksDelivered`. Hosting: Vercel. OG images per element (`/og/C.png`).

---

## 12. Build Roadmap — Phases, Tasks, Done Criteria

### Phase 0 — Foundation (Day 1–2)
- [ ] Scaffold Next.js + Tailwind + tokens (§1.8) + font + navy canvas shell
- [ ] Seed 122 elements JSON (coords, masses, families, tiers) + verify grid renders 18-col + exotics pod + f-block
- [ ] Static tiles: white unclaimed + pastel claimed (mock 6 claimed incl. Au, C, DM)
- [x] **Done =** grid matches §4 ASCII on desktop + mobile scrolls, no backend

### Phase 1 — worldmap.lol Chrome (Day 3–5)
- [ ] HeroCard + SearchPill + StatsCard + ActivityCard (mock data) floating over canvas
- [ ] Drawer shell (open/close, Esc/backdrop/✕, auto-pan cols 15–18) with UNCLAIMED + CLAIMED mock views
- [ ] HowItWorks + Board + Checkout modals (mock submit)
- [ ] Hover tooltip + hover preview card + crown icons
- [x] **Done =** click any tile → correct drawer; all 3 modals open/close; UI matches screenshots at a glance

### Phase 2 — Real Ledger (Day 6–9)
- [ ] Prisma schema (§9) + Postgres + seed script + `/api/elements`, `/stats`, `/activity`, `/board`, `/search`
- [ ] `pricing.ts` + rank recompute transaction + unit tests (canonical $20/$21/$2 case + ties + self-top-up)
- [ ] Wire drawer/stats/activity/board to live APIs (poll 30s, SWR)
- [x] **Done =** restart preserves stakes; takeover/reclaim math passes tests

### Phase 3 — Money (Day 10–13)
- [ ] Checkout flow: validation → idempotency key → Whop session → webhook → ledger apply
- [ ] Dual CTA (take #1 vs join $5) + live `👑 takes #1` line + `maybe later`
- [ ] Receipt + outbid emails (exact reclaim price) + toast states
- [ ] `/go/:stakeId` redirect + click counting + `🟢 clicks` display
- [x] **Done =** end-to-end $5 claim + $51 takeover + $2 reclaim on staging with real webhooks

### Phase 4 — Polish & Trust (Day 14–16)
- [ ] Elite/exotic CSS finishes (§5.3) + `ELITE RESERVE` tags + 🌌 pod pill
- [ ] Screenshot job for hover previews + logo fallbacks + OG images
- [ ] SEO (`/elements/[sym]` pages), footer legal (`About & disclaimer · Rules & payments`), `IUPAC illustrative` disclaimer
- [ ] Rate limits, honeypot + Cloudflare Turnstile on checkout, audit log
- [x] **Done =** Lighthouse ≥90, a11y keyboard/ESC pass, no layout shift when drawer opens

### Phase 5 — Launch (Day 17–18)
- [ ] Seed 8–12 friendly startups (dogfood across Au/C/Si/DM), activity backlog, concierge reclaim test
- [ ] Analytics events (`tile_click, drawer_open, checkout_start, checkout_paid, reclaim_click`)
- [ ] Launch checklist (§14) + rollback plan (feature flag payments → waitlist mode)
- [x] **Done =** prod checkout works, emails deliver, board + stats live

### Phase 6 — V2 (post-launch, do not build now)
Early-adopter badges, element watch alerts, `/api` for founders, animated exotic shaders, auctions for #119/DM anniversaries, referral cut.

---

## 13. QA, Abuse & Legal Guardrails

- **Tests:** `pricing.test.ts` (takeover/join/reclaim/tie), Playwright (first-claim, takeover, reclaim, search, drawer autopan, Esc close), webhook idempotency test (double-delivery → single top-up).
- **Abuse:** min $5 + Turnstile + domain ownership check (meta tag or DNS in V2; self-attest + report button in MVP), report/DMCA flow, banned domains list, IP rate limits on `/go` and `/checkout`.
- **Legal copy (keep visible):** `Secure payment via Whop · it's an ad buy, not a bet · by continuing you agree to the rules & terms.` + `Periodic data: IUPAC Standard. Classifications are illustrative, not a chemical statement.` + `About & disclaimer · Rules & payments`.

---

## 14. Metrics & Launch Checklist

**North star:** `totalPoolUsd` growth + `% elements with ≥1 stake` (colonization rate).
Track: tile_click→drawer_open→checkout_start→paid conversion, reclaim email open/click→paid, clicks delivered per #1, top-10 contested elements.

**Launch gate:**
- [ ] 122 tiles render, exotics centered, f-block linked
- [ ] Drawer + 3 modals pixel-close to worldmap.lol refs
- [ ] Real $5/$51/$2 flows pass on prod (then refund or keep as founders)
- [ ] Outbid email shows exact `$X.00` reclaim price
- [ ] Stats/activity/board update without refresh
- [ ] Legal links + disclaimers present
- [ ] Rollback: `PAYMENTS_LIVE=false` → checkout shows waitlist

---

## Appendix A — File Map (proposed)

```
/app/page.tsx (canvas + clusters)  /components/{HeroCard,StatsCard,ActivityCard,PeriodicGrid,Tile,Drawer,RankRow,HoverPreview,Modals,CheckoutForm,Board,Toasts}.tsx
/lib/{pricing.ts,elements.ts,geo.ts}  /app/api/...  /prisma/{schema.prisma,seed.ts}  /emails/{outbid,receipt}.tsx
/public/{og,tiles.svg}  /doc/ROADMAP.md (this file)
```

## Appendix B — Improvements Over v1 Spec

1. Added **dual CTA** (take #1 vs join ladder) — v1 forced newcomers to overpay.
2. Added **server recompute + idempotency + webhook race** handling — v1 had math but no ledger safety.
3. Added **clicks table + rate limits** — v1 showed clicks with no anti-fraud.
4. Added **responsive bottom-sheet + z-index + autopan** specifics — v1 was desktop-only.
5. Added **phased roadmap with done criteria + tests + launch gate** — v1 was spec-only, not buildable.
6. Locked **tokens, copy, file map, API contracts** so builders don't guess.

---
*Built from the v1 txt spec + 15 worldmap.lol screenshots. When in doubt, match worldmap.lol spacing, radius, and wording — then swap countries for elements.*
