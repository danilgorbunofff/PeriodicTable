# Strict Review — periodictable.lol vs worldmap.lol
**Reviewer stance:** product engineer + UI/UX lead, shipping this as a visual twin.  
**Inputs:** 28 markdown files in `/doc`, 15 screenshots in `/images`, original txt spec.  
**Date:** 2026-09-07

---

## Verdict

| Layer | Score | Ship as written? |
|-------|-------|------------------|
| Product / staking logic | **B+** | Yes, with 3 rule fixes |
| Information architecture | **C** | No — missing 2 core surfaces |
| Visual twin of worldmap.lol | **D+** | **No.** Docs would produce a dark dashboard, not that site |
| Engineering plan / phases | **B** | Yes as a build order |

**Bottom line:** The *idea* (King-of-the-Hill on 122 tiles, $5 floor, cumulative reclaim) is coherent and close to worldmap.lol. The *look* specified in ROADMAP / Phase 0–1 is **not**. If you implement tokens, layout, chrome, and tile finishes as currently written, it will not feel like worldmap.lol. You will get a navy spreadsheet with yellow buttons.

**Visual source of truth after this review:** `/doc/DESIGN-SYSTEM.md` (overrides ROADMAP §1 and §5 where they conflict).  
**Product source of truth:** ROADMAP economy rules, plus the rule fixes in §3 of this file.

---

## 1. What is actually correct (keep)

These match the screenshots and should not be renegotiated:

1. **Full-viewport stage, no desktop page scroll.** The table *is* the page.
2. **Floating white porcelain cards** over a dark stage. Nothing reflows the canvas.
3. **Top-left hero** = wordmark pill + one headline + one yellow CTA + 🏆 / (i) / 🔍.
4. **Search is a separate pill** under the hero, toggled by 🔍.
5. **Top-right 3-line stats. Bottom-left live activity.**
6. **Right rail** for inspection / live ranking. Hover preview floats to the *left* of that rail.
7. **Three modals:** How it works, Checkout, The board. Same copy skeleton, Whop, “ad buy not a bet.”
8. **Unclaimed = empty / white. Claimed = pastel + logo.** Rank is total stake. Take #1 at current+#1.
9. **Cumulative reclaim math** and outbid email. This is the product.
10. **Dismissal trinity** (Esc / ✕ / backdrop) on modals.

Phased build order (grid → chrome → ledger → money → polish → launch) is the right engineering sequence.

---

## 2. Critical UI/UX misses vs the 15 screenshots

These are the reasons it would not look like worldmap.lol.

### P0 — Right rail is NOT closed on load
**Docs say:** drawer `translate-x-full`, table gets 100% focus.  
**Screenshots (094055):** desktop home has a **persistent right panel** titled `THE WORLD · LIVE` / **World Order** / `TOP 10 · MOST SPENT`. Clicking a country *replaces* that panel with `CLAIMED TERRITORY` / `UNCLAIMED TERRITORY` (094107, 094130). ✕ returns to World Order.

World Order ≠ The board modal. Trophy opens the modal (094610). The rail is the live top-spenders list. Docs collapsed two surfaces into one and then hid it.

**Fix:** right rail always mounted on desktop. States: `world-order` | `territory`. Never start empty.

### P0 — The table must float like the globe, not fill the screen
**Docs say:** 18-col CSS grid, tile min 64px, gap 8px, max-width ~1400px. Math: `18 × 72 ≈ 1296px` — a spreadsheet to the edges.  
**Screenshots:** a **sphere sits in dark negative space**. Cards float in the margins. The object is the hero; UI is chrome around it.

**Fix:** treat the periodic table as a composed object in the center (~900–1040px), tile ~44–52px, gap 6px, generous dark margin. Rounded board, soft shadow, optional inner padding. If it looks like Excel on navy, you failed.

### P0 — Page background is near-black, not `#0e1b2e`
Sampled from 094055:

| Token | Docs | Actual pixels |
|-------|------|----------------|
| Stage | `#0e1b2e` | `#010304` … `#0A1720` (almost black, cool) |
| CTA fill | `#fab828` | **`#FFC93C`** |
| CTA underside (3D lip) | missing | **`#8F6C17`** |
| Input / step wash | `#f1f5f9` / cream | **`#F2F7FC`** icy blue |
| Crown row | `#fef9c3` | `#FFF5DB` / wash `#F5D480` |
| Money numerals | “gold” | ~`#C8892A`–`#DA9D45` |
| On-sale line | generic | **`#F18B42`** |
| Live / globe accent | emerald `#10b981` | **`#59C794`** |
| Muted copy | `#64748b` | **`#8497AE`** |
| Profile page | navy canvas | **`#EFF5FC` icy light** (different theme) |

The yellow button is **chunky 3D**: bright fill + dark gold bottom lip. Flat `bg-[#fab828] rounded-full` will look like every Tailwind landing page, not this product.

### P0 — Hero CTA is NOT full width
**Phase 1 `01-hero-search.md`:** “yellow pill, full-width.”  
**094600:** CTA is **hug-content, left**; three **32px circular** icon buttons sit **on the same row** to the right. Search icon gets a **yellow ring** when active. Search submit is a **navy circle with white arrow**, not a yellow button.

Also: worldmap hero has **no subtitle**. Do not add “Every element is an open leaderboard” under the H1.

### P0 — Wordmark is two-tone
`worldmap` ink + `.lol` **yellow**. Docs said “bold lowercase” only. Must be `periodic` + `table` ink + `.lol` yellow (or `periodictable` + `.lol` yellow). This is the brand.

### P0 — Title pattern: one word in yellow
Every modal title does this:

- `How` **conquest** `works`
- `The` **board**
- `Stake on` **Kenya**

Docs specified all-ink titles + emoji soup. Recreate the **yellow noun** pattern: `How` **claiming** `works` · `The` **board** · `Stake on` **Carbon**.

### P0 — Startup profile page is missing
**095559, 095612, 095625** (3/15 screenshots) are a **second visual system**:

- Light icy page `#EFF5FC`, not the dark stage
- `← the globe` back link
- Yellow official banner (`OFFICIALLY ON THE WORLD MAP` / `{domain} is on the map` / rank title)
- Left: framed globe of *their* territories
- Right: logo, rank badge (Emperor), pitch, stat pills, **dark** `Visit site` button (inverse CTA)
- Metrics: countries · #1 spots · placements · clicks
- `Territories held` card grid; this startup’s row is a yellow wash
- Bottom yellow bar `Start your own empire` + Claim
- Footer: public page disclaimer

Hover preview **`View profile →`** goes here. Docs never specified this route. Without it, clicks have nowhere to prove status, and the product feels unfinished vs worldmap.

### P0 — Elite/exotic “tactile finishes” will kill the twin
Worldmap paints **every** country as a **flat pastel**. USA is not metallic. Saudi is not gold-leaf. The map language is: empty gray/white → filled candy color + tiny logo pin.

ROADMAP State 3–4 (brushed gold, chrome, carbon weave, radioactive trefoil, frosted glass, event-horizon rings) is a **game-inventory aesthetic**. It is the fastest way to *not* look like worldmap.lol.

**Fix:** MVP tiles = unclaimed white + claimed family pastel + logo + optional 👑. Elite/exotic shaders are Phase 6 only, behind `prefers-reduced-motion`, and even then they must stay pastel-first. A small `ELITE` / `EXOTIC` caption is enough.

### P1 — Drawer chrome details
From 094107 / 094120 / 094130, missing in docs:

- Top-right **expand ⤢ + close ✕** (expand → profile or pop-out)
- ISO-style prefix: `US` **United States…** → `C` **Carbon** (symbol ink, name heavy)
- Subline gold: `10 bidding · #1 pays $50`
- #1 row is a **soft gold wash**, not a thick yellow box
- Rank rows are quiet; price gold; pitch one line
- Microcopy under CTA: `rank is your total stake · top up to climb` (claimed) / `plant your flag · rank is your total stake` (unclaimed)
- Hover preview: screenshot **or** `loading preview…`, full pitch, chain + gold URL, green clicks, **`View profile →`**
- Clicks live on the **preview**, not necessarily as a loud badge on every #1 row (094107 #1 card does *not* show clicks; 094120 preview does)

### P1 — How-it-works steps are icon tiles, not emoji paragraphs
094207: each step is an **icy `#F2F7FC` rounded card** with a **colored rounded-square illustration** (flag / chart / recycle), numbered title, 2-line body. Optional Product Hunt badge — skip for launch. Footer disclaimer + full-width chunky yellow `Got it`.

### P1 — Board tabs are three different *metrics*, not filters of one list
- **By Country / By Element:** biggest *single-territory* stake (`$100` on Canada)
- **#1 Crowns:** count of #1 seats (`👑 16`)
- **Early Adopter:** first-claimer medals (`🏅 16`)

Docs described this loosely. Implement as three sort keys, not CSS-only tabs on the same array.

### P1 — “On sale · $3” is in the UI, not in the rules
Stats row 3 is orange `#F18B42`. $3 is **below** the $5 floor. Docs copied the label and never defined a sale. Either:

- **Drop the row** until a rule exists, or
- Define it (example: a rotating daily element at $3, one seat, then back to $5)

Do not show “on sale” as dummy copy.

### P1 — Dual CTA `or join from $5`
Not in any screenshot. Worldmap has **one** sticky CTA at take-lead price. Lower amounts are typed in checkout. Extra links make it look like a pricing page. Cut it from the drawer.

### P2 — Other twin details
- Activity geo line: `{cc}` + `Someone in {City} is online` (teal muted), not a spinning tourist list
- Activity row: favicon · domain · **gold price right** · `#1 in {cc} {Name}` · relative time right
- Segmented controls: icy track, **white raised** selected pill (checkout tabs, board tabs)
- Inputs: `#F2F7FC` fill, no hard border
- Profile `Visit site` = **navy pill**, not yellow (yellow = claim/stake only)
- Unclaimed land on the globe is **gray**, claimed is pastel — white tiles on black is the right analog if the *board* is a light object; individual unclaimed tiles should read as empty porcelain, not glowing rectangles

---

## 3. Product / logic — keep, with three fixes

**Keep:** $5 floor, never sell out, cumulative stake, reclaim = `(#1 + 1) − yours`, integer dollars, ad-buy framing, 118 + 4 exotics in the skyline gap, family pastels as *fill only*.

**Fix A — Join-ladder vs take-lead (keep the rule, hide the extra button).**  
You *can* stake $5 on a $50 tile and sit at #N (board screenshots prove non-#1 rows). Primary CTA still quotes take-lead. Checkout amount is editable. Server accepts `>= 5` to join, `>= #1+1` to crown. No second link.

**Fix B — `currentLeaderId @unique` was already removed in ROADMAP.** Good. One startup must be allowed to lead many elements (vignette.id × 17). Keep it that way.

**Fix C — Sale mechanic.** Decide before Phase 1 stats copy. Recommendation: **omit “on sale” for MVP.** Stats become 2 rows, or row 3 = `N unclaimed · from $5`. Revisit in V2.

**Exotic science:** H̄ / Ps / Uue / DM are fine as *product* theater if the IUPAC disclaimer stays. Do not style them like a different app.

**Clicks:** counting `/go/:id` is correct. Don’t invent client-side increments.

---

## 4. Engineering plan — mostly sound, gaps

| Gap | Risk |
|-----|------|
| No World Order rail in any phase folder | Phase 1 “done” can pass while home looks empty on the right |
| No `/s/[domain]` profile in phases | Hover `View profile` dead-ends; 3 reference screens unused |
| Elite finishes scheduled Phase 4 | Will restyle the product away from the twin right before launch |
| Autopan −150px | Fine for a grid; don’t over-animate |
| Plus Jakarta Sans | Plausible stand-in; lock *weights and yellow-noun titles*, not the foundry |
| shadcn/ui | Dangerous default (gray borders, flat buttons). If used, **strip it** — custom Card / chunky CTA / icy input only |
| `grid-cols-18` + 64px tiles | Breaks the globe-like composition (see P0) |
| Playwright / a11y in Phase 4 | Good; add a **visual regression** vs `/images` for hero, rail, checkout, board |

---

## 5. Screenshot → required surface map

| File | Surface | In docs? |
|------|---------|----------|
| 094055 | Home: stage + hero + stats + activity + **World Order rail** | Rail missing / wrong (closed) |
| 094107 | Territory rail (claimed) | Partial |
| 094120 | Hover preview + View profile | Partial; profile link missing |
| 094130 | Unclaimed rail | Yes |
| 094139 | Checkout modal | Yes, title/tokens wrong |
| 094147 | Activity card | Yes |
| 094154 | Stats card | Yes; sale row undefined |
| 094207 | How it works | Yes; layout wrong |
| 094600 | Hero + search | CTA layout wrong |
| 094610 | Board · By Element | Yes |
| 095520 | Board · Crowns | Yes |
| 095541 | Board · Early Adopter | Yes |
| 095559 | **Profile header + globe** | **Missing** |
| 095612 | Profile territories | **Missing** |
| 095625 | Profile + empire CTA | **Missing** |

---

## 6. What to implement if you want it to *look* like worldmap.lol

Do this, in order, and ignore the rest of the visual invention:

1. Near-black stage. **Floating light table object** in the center (not edge-to-edge cells).
2. White cards, huge radius, soft shadow. Chunky `#FFC93C` buttons with dark lip.
3. Two-tone `.lol` wordmark. Headline one sentence. CTA + 3 icon buttons **one row**.
4. Persistent right rail: World Order by default → territory on tile click.
5. Flat pastel tiles + logo pin. Crowns only. No metals, no glass, no cosmic shaders.
6. Icy `#F2F7FC` inputs and step cards. Yellow noun in titles. Gold money.
7. Light-theme public profile page. Dark `Visit site`. Yellow only for claim/stake.
8. Copy, spacing, and hierarchy from the screenshots — not from emoji tables.

Then the staking engine on top. That is the product.

---

## 7. Required doc actions (done in this pass)

- [x] This review
- [x] `/doc/DESIGN-SYSTEM.md` locked as visual SoT
- [x] ROADMAP §1 / tokens / tile lifecycle corrected
- [x] Phase 0 tokens + grid composition corrected
- [x] Phase 1 hero / drawer / modals corrected
- [x] Phase 1 World Order + profile sub-phases added
- [x] Elite finishes pushed to Phase 6; Phase 4 finishes doc demoted

**Do not start coding from the pre-review ROADMAP visual sections.**
