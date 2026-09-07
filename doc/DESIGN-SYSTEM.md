# DESIGN SYSTEM — worldmap.lol twin (visual source of truth)
**Overrides ROADMAP §1, §5, §6 and any phase file that conflicts.**  
**Sampled from `/images` on 2026-09-07. Implement these pixels, not the old hex guesses.**

---

## 1. The one sentence

A **light object** (periodic table) floats in **near-black space**. **White porcelain chrome** hangs off the corners. **Chunky honey buttons** do money. Territories are **flat pastels + a logo**. That is the entire look.

If a screen looks like a dashboard, a game inventory, or Excel, it is wrong.

---

## 2. Tokens (locked)

```
stage            #05070A   /* near-black, cool. NOT #0e1b2e */
stage-mid        #0A1720   /* globe-adjacent navy, gradients ok at edges */
card             #FFFFFF
ink              #1F2B3E
muted            #8494AB
hairline         #E4EBF3
icy              #F2F7FC   /* inputs, step cards, segmented track, unclaimed explainer */
cta              #FFC93C   /* button fill. NOT #fab828 */
cta-lip          #E8AC12   /* 3D underside / border-bottom */
cta-hover        #FFD45C
money            #B8860B   /* $ amounts */
gold-wash        #FFF5DB   /* #1 row */
gold-wash-edge   #F5D480
sale             #F18B42   /* only if sale mechanic exists */
live             #59C794
ring-active      #FFC93C   /* search icon when open */
visit            #0F172A   /* profile "Visit site" — the only dark pill */
profile-bg       #EFF5FC   /* light theme pages */
banner-start     #FFEFC1
banner-end       #FFCE4B
radius-card      24px      /* ~rounded-3xl */
radius-pill      999px
radius-btn       18px      /* chunky, not a skinny pill */
shadow-card      0 18px 50px rgba(0,0,0,.28)
shadow-float     0 12px 40px rgba(0,0,0,.22)
display font     Fredoka 500/600/700
body font        Nunito 600/700/800/900
```

### Chunky CTA (copy this, don’t improvise)
```
height: 48–52px
bg: #FFC93C
color: #0F172A
font-weight: 800
border-bottom: 4px solid #8F6C17
border-radius: 16–18px
hover: translateY(1px) + thinner lip
active: translateY(2px)
```
Yellow is **only** for claim / stake / Got it / Claim on profile banner. Never for Visit site, search submit, or icon buttons.

### Icon buttons
32–36px circles, white, hairline or soft gray fill, **no** yellow except the active search **ring**.

### Search submit
Navy circle `#0F172A`, white arrow. Sits inside the icy search pill on the right.

---

## 3. Type rules

- Headlines 800, ink. **Exactly one word in `#FFC93C`** in modal titles.
- Wordmark: `periodictable` (or `periodic table`) ink + `.lol` yellow, white pill, bold.
- Hero H1: `Put your startup on the table. Literally.` — **no subtitle**.
- Eyebrows: 11px, tracking-widest, `#8497AE`, uppercase (`CLAIMED TERRITORY`, `THE TABLE · LIVE`).
- Money: 800, `#C8892A`, always with `$`, no cents in UI.
- Body muted `#8497AE`. Never pure `#64748b` gray-500 — too cool/dark.

---

## 4. Stage composition (desktop)

```
┌─────────────────────────────────────────────────────────────┐
│ stage #05070A                                               │
│  [wordmark]                          [stats 3-line]         │
│  [hero: H1 + CTA + 🏆 i 🔍]                                 │
│  [search pill, collapsed]                                   │
│                                                             │
│           ┌─────────────────────────┐     ┌──────────────┐  │
│           │   FLOATING TABLE        │     │ RIGHT RAIL   │  │
│           │   ~960×560, radius 24   │     │ always on    │  │
│           │   18-col tiles 46–52px  │     │ World Order  │  │
│           │   gap 6, pastel/white   │     │ or Territory │  │
│           └─────────────────────────┘     └──────────────┘  │
│  [activity]                                                 │
└─────────────────────────────────────────────────────────────┘
```

- Table is a **rounded board** with a whisper of white/10 inner bg or just tiles with shared radius — it must read as one object, with dark margin ≥ 80px on left (under cards) and enough right margin that the rail does not sit on the cells.
- **Do not** let 18×64px tiles eat the viewport.
- z: stage 0 · table 10 · tooltips 30 · corner cards 40 · rail 50 · hover preview 60 · modals 70 · toasts 80.
- Desktop: no document scroll. Mobile: table pans horizontally; rail becomes a bottom sheet; hero stacks.

---

## 5. Tiles (MVP — flat, period)

| State | Fill | Type | Extra |
|-------|------|------|-------|
| Unclaimed | `#FFFFFF` | ink number + symbol + `$5` | hairline `#E8EEF4` |
| Claimed | family pastel (ROADMAP §5.2 map) | ink | leader **logo 16–18px**, optional ticker |
| Contested | same pastel | ink | **👑** top-right, nothing else |
| Selected | same | ink | 2px ink/yellow ring + lift `scale(1.04)` |

**Forbidden in MVP:** metal gradients, chrome, carbon weave, trefoils, frosted glass, event-horizon rings, cosmic pulses, diamond crowns, 🌌 crowns. Exotic four tiles use the **same** porcelain language + a tiny `EXOTIC` caption under the symbol if needed.

Hover tooltip: dark pill `Symbol · Name · #1 $X` or `Unclaimed · $5`.

---

## 6. Chrome components (match screenshots)

### Hero (094600)
- Wordmark pill above, separate.
- Card ~360px, padding 18–20, H1 only.
- Row: chunky CTA **hug contents** `Claim an element · from $5` + 3 icon circles.
- 🔍 open → yellow ring on icon + search pill **under** the card: icy input, placeholder `find your startup...`, navy arrow button.

### Stats (094154)
- Compact white card, 3 lines, emoji/icon + copy.
- `🧪 122 elements live` · `💰 $X in bids` · third line **not** “on sale” until a rule exists (`N unclaimed · from $5` is legal).

### Activity (094147)
- `🟢 Live activity`
- `{cc} Someone in {City} is online` muted
- Rows: favicon, domain, **money right**; sub `#1 in C Carbon` + `1d ago` right
- Footer `409 visitors · 72h` left · `8 watching` right

### Right rail — World Order (094055) **default**
- Eyebrow `THE TABLE · LIVE`
- Title: globe/flask + **Table Order**
- Gold sub `TOP 10 · MOST SPENT`
- #1 row: peach pill `#1` (bg `sale` #F18B42), logo, domain, `{n} elements · 👑 {c}`, money
- #2… list: plain rank text (no pill), logo, domain, `{n} elements · 👑 {c}`, money
- Footer muted `total staked across every element · click one for details`
- Top-right expand ⤢ → opens a `size="lg"` fullscreen modal (see “Expand modal” below)
- Every row is `<a target="_blank">` → opens that startup’s `/s/{domain}` profile page in a **new tab** (does not pan the table or close the rail)

### Right rail — Territory (094107 / 094130)
- Same shell (white, ~380–420px, large radius on left, shadow). Not a full-bleed drawer that eats the table.
- Header: eyebrow + ⤢ + ✕
- Title `C Carbon` (symbol then name)
- Unclaimed: `BE THE FIRST · $5` · icy card with `?` · CTA `Be the first — from $5` · micro `plant your flag · rank is your total stake`
- Claimed: gold `10 bidding · #1 pays $50` · **every** row gets a peach rank pill (`#1`, `#2`, `#3`…, not just the leader) · sticky CTA `Claim a spot — for $51` · micro `rank is your total stake · top up to climb`
- **No** “or join from $5” link
- ✕ returns to World Order (desktop)
- Every bidder row is `<a target="_blank">` → opens `/s/{domain}` in a **new tab** (hover-preview card still shows on `mouseenter`; its “View profile →” is now plain text since the whole row is already the link)

### Expand modal — World Order / Territory (cream leaderboard header)
Matches worldmap.lol’s “Country Leaderboard” / “World Order” modal treatment. Triggered by the rail’s ⤢ button; renders in `<Modal size="lg">` (fixed `max-w-[460px] h-[min(720px,85vh)]`, single Modal-supplied ✕, no double header).
- Full-bleed cream/gold gradient band at the top (`linear-gradient(180deg,#FFEFC1,#FFCE4B)`, bled to the dialog edges via `-mx-6 -mt-6` so it reaches the rounded corners)
- White rounded-2xl avatar chip on the left: `⚗️` for World Order, element-colored symbol chip for Territory
- Eyebrow (`text-ink/60`, e.g. `the table · live` / `CLAIMED TERRITORY`), bold title (`text-ink`, e.g. `Table Order` / `C Carbon`), subtitle stat line (`text-ink/70`, e.g. `{n} bidding · ${total} staked`)
- Below the header: the same row list as the compact rail (peach-pill rank rules unchanged: #1-only for World Order, all ranks for Territory), each row still an `<a target="_blank">`
- Compact-mode-only stat lines (e.g. the `{n} bidding · #1 pays $X` line) are hidden when expanded since that info now lives in the header subtitle

### Hover preview (094120)
- Left of rail, white card.
- Screenshot 16:9 or `loading preview…`
- Full pitch · chain + gold URL · green clicks · **View profile →** (gold)

### How claiming works (094207)
- Title `How` **claiming** `works` + flask
- Sub: `Every element is an open leaderboard, ranked by total stake.`
- 3 icy cards, numbered, illustrated icon squares (flag / chart / recycle) — not raw emoji walls
- Disclaimer · chunky `Got it` · `About & disclaimer · Rules & payments`

### Checkout (094139)
- `Stake on` **Carbon** + flag
- Reminder paragraph muted
- Segmented `Product URL` | `@ Social` (icy track, white selected)
- Icy URL field, icy stake field with `$` prefix
- `👑 $X takes #1 in Carbon!`
- Chunky `Continue to checkout →`
- Lock + Whop line; `rules & terms` yellow
- `maybe later` centered muted

### The board (094610 / 095520 / 095541)
- `The` **board** + trophy
- Sub changes per tab
- Icy segmented tabs: `By Element` | `#1 Crowns` | `Early Adopter`
- Medals 1–3, then `#4`
- **By Element:** domain + `C Carbon` + money
- **Crowns:** domain + `{n} seats · $X · 👑 {c}` + crown count right
- **Early Adopter:** domain + first-claimer medals right
- Header/tabs unchanged (plain white, out of scope for the cream-header restyle); every row across all 3 tabs is an `<a target="_blank">` → opens `/s/{domain}` in a new tab (same new-tab convention as World Order/Territory rows)

### Profile `/s/[domain]` (095559–095625) — light theme
- `bg #EFF5FC`. Back `← the table`. Wordmark top-right.
- Yellow gradient banner: `✦ OFFICIALLY ON THE TABLE ✦` · `{domain} is on the table` · `{title} · {n} elements claimed`
- Left: dark rounded frame with a **mini table** highlighting their tiles (globe analog) + `drag / scroll` hint + `{n} elements claimed` badge
- Right white card: logo, rank pill, domain, pitch, stat pills, **navy Visit site**, naked URL
- Stat quad: elements · #1 spots · placements · clicks
- `Elements held` 2-col cards: symbol avatar, `C Carbon`, bidding count, rank list with **this domain yellow-washed**
- Bottom yellow bar: `Start your own empire` / `Grab a seat on any element — from $5.` + Claim
- Footer disclaimer: public page, listings ≠ endorsement

---

## 7. Motion

- Rail swap 280ms ease. Preview 120ms. Modal 180ms scale+fade.
- Tile hover lift only. **No** looping exotic shaders.
- `prefers-reduced-motion`: cuts lift to color-ring only.

---

## 8. Anti-patterns (instant fail)

- Full-width yellow hero button
- Drawer closed on desktop home
- Edge-to-edge 64px tile spreadsheet
- Navy `#0e1b2e` wash that reads as “admin theme”
- Flat yellow without the 4px lip
- Metallic / glass / cosmic tiles in MVP
- Extra subtitle under the H1
- “Join from $5” secondary in the rail
- Yellow `Visit site`
- shadcn default borders and ghost buttons left visible
- Scrollable marketing landing above the table
