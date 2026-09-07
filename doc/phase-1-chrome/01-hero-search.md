# 01 — Hero Stack & Search

**Parent:** Phase 1 README · **Covers:** ROADMAP §1.2, §7.1

## Objective
Top-left cluster: pill badge + hero card + toggleable search pill. The single highest-leverage UI on the page.

## Spec
- Wordmark pill: `periodictable` ink + `.lol` yellow, white, `rounded-full shadow-xl px-4 py-1.5 text-sm`
- Hero card `w-[360px] p-5 rounded-3xl`: H1 only `Put your startup on the table. Literally.` (800, ~22–24px). **No subtitle.**
- **One row:** hug-content chunky CTA `[ Claim an element · from $5 ]` (NOT full-width) + 32px white circles `🏆 (i) 🔍`. Active search = yellow ring on 🔍.
- CTA opens HowItWorks on first visit, otherwise focuses an unclaimed tile.
- Search pill (hidden default) **under** the card: icy `#F2F7FC` input, placeholder `find your startup...`, **navy circle + white arrow** on the right (screenshot 094600).
- Search behavior: filters mock `startups.json` by domain/title/symbol/name; dropdown max 8 rows (favicon + domain + `SYM Name`); Enter/click → pan canvas to tile + open drawer + close dropdown

## Acceptance
- [ ] Toggle 🔍 opens/closes with animation; Esc closes search first, then drawer
- [ ] Empty query → recent 5; no match → `No startup found — claim {query} on C?` hint
- [ ] Mobile: hero becomes top sheet full-width, search below it

## Mock data
- `mocks/startups.json`: 8 rows across C, Au, Si, H, DM with logo (pravatar/favicon), pitch ≤140ch
