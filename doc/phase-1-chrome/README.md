# Phase 1 — worldmap.lol Chrome (Day 3–5)
### Floating hero, stats, activity + drawer + modals on mock data

**Goal:** the app *looks* like worldmap.lol. Floating table + chrome, **World Order rail on load**, Territory swap, 3 modals, light profile page. Mock data only. Visual SoT: `DESIGN-SYSTEM.md`.

**Why now:** nails UX before ledger complexity. Stakeholders can click-test conversion flow with fakes.

**Inputs:** ROADMAP §1, §6, §7 · screenshots 094120–094207 (hero/stats/activity/drawer/modals).

**Outputs:**
- `HeroCard`, `SearchPill`, `StatsCard`, `ActivityCard` floating clusters
- `Drawer` (UnclaimedView/ClaimedView/RankRow/HoverPreview) + autopan + Esc/backdrop close
- `Modal` shared + `HowItWorks`, `CheckoutMock`, `BoardMock`
- Tooltip + crowns + toasts stub

**Done =**
- [ ] Cold load shows **World Order rail** (not an empty right side)
- [ ] Click any tile → Territory view in the **same** rail; ✕ returns to World Order
- [ ] Hero: hug-content CTA + 3 icons on one row; search = icy + navy arrow; no H1 subtitle
- [ ] 3 modals match yellow-noun titles; profile `/s/[domain]` light page opens from `View profile →`
- [ ] Side-by-side with `/images`: spacing, radius, chunky lip, icy inputs

**Sub-phases:**
1. `01-hero-search.md`
2. `02-stats-activity.md`
3. `03-drawer-inspector.md` — Territory state
4. `04-modals-tooltips.md`
5. `05-world-order-rail.md` — default rail
6. `06-startup-profile.md` — light theme page

**Non-goals:** real APIs, payments, emails, metal/cosmic tiles. Mock checkout → toast only.
