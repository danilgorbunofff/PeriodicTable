# 05 — Accessibility and content

| Field | Value |
| --- | --- |
| Phase · batch | 05 · 1 |
| Status | draft — fixes applied (R05-1…R05-4, R05-6…R05-8; R05-5 accepted risk) |
| Date reviewed | 2026-09-14 (fix pass 2026-09-14, §5.4) |
| Commit reviewed | `6616a49`; live build (§5.2) |
| Reviewer | review agent |

| Probe not run | Why | Residue |
| --- | --- | --- |
| DOM pass, keyboard walk (axe, focus order, zoom) | headless Chrome writes nothing (`02` §5.8; U02-2) | none |
| Refund to prove R05-6 | read-only default | reversal + `refund` row |

The fix pass closed R05-1…R05-4 and R05-6…R05-8 in source or copy, and recorded R05-5 as accepted risk after re-reading the library that implements it (§5.4, §9 Q2). §5.4 verifies what the code now does and each finding in §7 states itself against it. The refund probe was still not run, so R05-6 is fixed as a **copy** contradiction only — the reversal path it now describes remains unobserved — and that is the one acceptance box §8 leaves unticked. The `Probe not run` rows are otherwise unchanged by the pass.

## 1. Scope

Owns no matrix cell. The cross-cutting pass over every batch-1 surface: WCAG 2.2 AA per surface, the copy inventory, and each place the UI states a fact the server does not guarantee (plan §2 `:101-102`). Legal sufficiency is doc `16`'s; contradictions only here.

Files opened beyond `01`–`04`: `components/{IcyInput,SearchPill,IconBtn,Modal,Modals,TerritoryView,WorldOrder}.tsx`, `lib/{a11y.test,money,liveState,validate,recompute,email}.ts`, `tailwind.config.ts`, `app/globals.css`, `app/{layout,page}.tsx`, and the `app/s/[domain]`, `app/legal/[slug]` and `app/pay/[paymentId]` routes.

## 2. Actors

- **Keyboard-only visitor** — roving grid focus, the modal trap, the unfocused-looking search box (R05-2).
- **Low-vision and screen-reader users** — the 4.5:1 token budget (R05-1), landmarks and duplicate ids (R05-3, R05-4).
- **Operator** — two promises made on their behalf (R05-7).

## 3. Intended behaviour

Tokens carry measured ratios (`tailwind.config.ts:17-48`); motion is forced off under `prefers-reduced-motion` (`app/globals.css:201-218,473-494,606-609`); failures and success announce (§3.1, 4.1.3).

### 3.1 WCAG 2.2 AA per surface

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| 1.4.3 small text | Pass | R05-1 fixed: red-700 6.47:1 white / 6.00:1 icy; `ink/70` 5.63 / 5.46, so the thinnest site still clears the floor by a whole ratio point and the smallest text (`text-xs` in the `co-*-error` nodes) is not the tightest one (§5.4) |
| 1.4.3 large text | Unverified | `text-money` 3.00–3.25:1 passes only at ≥18.66 px bold (U05-1) |
| 1.4.11 · 2.4.1 · 2.4.6 · 2.4.7 | Pass, caveats | R05-2 fixed (`ink` on light chrome, white on the modal card and the tiles; the 1.43:1 `cta` ring is gone), R05-3 fixed (skip link, `<main id="main">` on every surface, profile `<h1>`/`<h2>`). The white tile ring's worst backdrop is a 1 px overlap onto the worst family pastel at 3.20:1 (§5.4, U05-2) |
| 2.2.2 | Pass on a visible tab | R05-5 accepted risk: four panels refetch every 30 s while the tab is visible; SWR stops the interval while it is hidden and none of the four overrides that (§5.4, §9 Q2) |
| Rest | Pass, caveats | 4.1.3 (`LiveDataNotice.tsx:23`, `Toast.tsx:19`); trap (`Modal.tsx:100-118`); `lang="en"` (`app/layout.tsx:25`); hue never alone (`Tile.tsx`); amount field still lacks `aria-invalid` (`Modals.tsx:301`) |

### 3.2 Copy inventory

1. **Two labels for one rule.** Client "Name must be 2–32 characters." (`Modals.tsx:345`) vs server "at least 2"/"32 characters max" (`lib/validate.ts:96-97`).
2. **A lock the code does not honour.** `emails/outbid.tsx:2-3` names the subject and body it intends; `:40-70` renders others.
3. **Profile drift:** "elements claimed" (`:132`), "elements" (`:156`), "Elements held" (`:164`) in `app/s/[domain]/page.tsx`; "✦ OFFICIALLY ON THE TABLE ✦" (`:107`) reads as endorsement on the page that disclaims it (`:199`).
4. **"counts a verified redirect"** (`emails/receipt.tsx`) vs **"visits are counted"** (`app/s/[domain]/page.tsx:148`) — the counter counts click-throughs (`03` §3).
5. **Honest:** the money rules match the code (ledger §3b); "we do not offer refunds" did not — fixed (R05-6).

Items 1–4 were not findings; this pass left them exactly as reviewed (it changed only the `<h1>`/`<h2>` and the landmark on that page, §7 R05-3).

### 3.3 Facts the UI states that the server does not guarantee

"held for 15 min" (`Modals.tsx:395`; R04-2) · "verified redirect" (3.2.4) · "actioned within 72 hours" and "we'll be in touch" (R05-7 — now backed by a mail queued in the same request, §7) · "No Stripe keys configured" (R05-8 — now rendered only in provider mode `dev`).

## 4. The path, walked

`/` serves `lang="en"` and Plausible only when `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is set (`app/layout.tsx:22,25,27-29`); one `<h1>`, no `<main>` (§5.2). Arrow keys move the grid (`lib/gridNav.ts`) and checkout traps focus (`Modal.tsx:100-118`). Typing "A" in the name field paints the 3.76:1 error; a server rejection adds a second div with the same id (R05-1, R05-4). Paying is the irreversible point (`04` §4); `/pay/<id>` answers anyone who guesses it (R05-8).

**4.1 After the fix pass.** The changes below are the only deltas from the path walked above; §5.4 verifies them and §7 states each one against its finding.

- **Muted and error text moved to the AA half of the palette.** Seven rendered error sites are red-700 instead of red-500, and the two `ink/60` panel labels are `ink/70` (§7 R05-1).
- **Every focusable custom control draws a ring, and the ring is chosen per surface.** `outline-none` survives in exactly three files (`IcyInput`, `Modal`, `SearchPill`), each with a `focus-visible:outline-2 outline-offset-2` companion in a colour that clears 3:1 on *that* surface; the selected-tile and active-icon states carry an `ink` ring too (§7 R05-2).
- **The product has a bypass block and a landmark.** The layout's first focusable element is "Skip to main content", outside the subtree the modal inerts; every surface now holds exactly one `<main id="main">`, and the profile page opens with an `<h1>` and names its grid with an `<h2>` (§7 R05-3).
- **One element per error id.** Each checkout field renders one node per message id, holding the client hint and the server reason together, so `aria-describedby` always resolves to one element (§7 R05-4).
- **The refunds section describes the shipped reversal path** rather than a rule the ledger breaks (§7 R05-6).
- **A report and a waitlist join now raise mail.** Two new templates and two new queue types; the intake routes enqueue in the same transaction as the row and then drain with a bounded budget, and the daily outbox job is the retry (§7 R05-7).
- **The dev simulator is behind the provider mode.** `/pay/[paymentId]` is a server gate that 404s anything but `dev`; the simulator itself moved to a client component behind it (§7 R05-8).

## 5. Live evidence

**5.1** Contrast from the real tokens (`node`, 2026-09-14T16:56:55Z): red-500 3.76:1 white, 3.49:1 icy; `cta` #FFC93C ring 1.43:1 icy, 1.54:1 white; `money` #B8860B 3.25:1 white / 3.00:1 goldwash; red-700 6.47:1 white, 6.00:1 icy; white outline on the worst exotic #9F7BEF 3.20:1.
**5.2** Served HTML, `curl.exe -s -o <f>.html -w "%{http_code} %{size_download}"`, 2026-09-14T16:56:16Z, in `files\evidence05\`: home 200 149431, rules 200 17057, contact 200 11673, pay/probe-0000 200 7366. Home `<main` 0, "skip to" 0, `<h1` 1. Pay carries "DEV SIMULATOR" and "Simulate failure". Rules: "we do not offer refunds" 2, `<main` 1.
**5.3** Blast radius (`Select-String`): `text-red-500` 10 hits, all `Modals.tsx`; `ink/60` at `TerritoryView.tsx:81`, `WorldOrder.tsx:36`; `text-money` 22 hits in 12 files; the profile's heading match only `:164` `<h3>`.

**5.4 Fix verification** (2026-09-14, this worktree — the checkout the fixes were written in — plus two `npx next dev` processes on this host: 3111 with no Stripe keys, 3112 with dummy `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` and `PAYMENTS_LIVE=true`; bodies in `files\evidence05\`). These probes ran *after* the fixes landed and replace this doc's `4.x` line numbers as the evidence for what the code now does.

| # | Probe | Result |
| --- | --- | --- |
| 5.4.1 | `/` (3111) | 200: "Skip to main content" at byte 2130, `<main id="main">` at 2388, `#app-root` at 2403 — the skip link is first in the document, the landmark is the inerted shell's parent, and the link is outside the subtree `Modal.tsx` disables (`app/layout.tsx:33-37`, `app/page.tsx:443`) |
| 5.4.2 | `/elements/C` (3111) | 200, exactly one `id="main"` — the signed-out element shell of the two branches in `app/elements/[sym]/page.tsx` |
| 5.4.3 | `/legal/rules` (3111) | 200, one `id="main"`; body holds "Refunds &amp; disputes" and the reversal sentence, and **zero** hits for "no refunds" or "do not offer refunds" (was 2 — §5.2) |
| 5.4.4 | `/pay/nonexistent-id` (3111, no keys) | 200 with `id="main"` 1, "DEV SIMULATOR" 1, `#FFCE4B` 1 — the simulator still serves where it is meant to |
| 5.4.5 | `/pay/anything` (3112, Stripe configured) | **404**, body "Page not found", `DEV SIMULATOR` 0, `#FFCE4B` 0, `id="main"` 0 |
| 5.4.6 | `POST /api/dev/pay` (3112) | 403 `{"error":"Disabled when Stripe is enabled."}` — the API gate that already existed (`app/api/dev/pay/route.ts:16`) now agrees with the page |

- **Contrast (R05-1).** `lib/a11y.test.ts` computes every number from the palette rather than transcribing it: red-700 ≥ 4.5:1 on white and icy, red-500 < 4.5:1 on both as the negative control, and `ink/70` ≥ 4.5:1 white / icy against `ink/60` below it — with the alpha compositing done in the test (`over()`), so a future token edit that moves `ink` breaks the claim instead of silently invalidating it. Every `.tsx` under `components/` and `app/` is swept for `text-red-500` (none) and for a bare `outline-none` (none). Two honest limits: the `co-*-error` nodes are the smallest text in the product (`text-xs`), and red-700 still clears 6.47:1 on the white card and 6.00:1 on icy, so the small size is not what makes that group tight; and the pair closest to the floor is `ink/70` at 5.63:1 white / 5.46:1 icy. §5.1's own `ink/60` figure is the one number in this document the pass recomputed — it is **4.14:1** on white and **4.02:1** on icy, not the 3.62–3.95:1 the draft quoted, and it is below the floor either way, so the fix is unchanged; the corrected values are the ones the test asserts.
- **Focus indicators (R05-2).** The sweep pins the `outline-none` inventory to exactly `components/IcyInput.tsx`, `components/Modal.tsx` and `components/SearchPill.tsx` — three entries, extended on purpose rather than by accident — requires a `focus-visible:outline` on the same line as every `outline-none`, and requires the *pairing*: `ink` for the light chrome, white for the modal card and the tile link. It also asserts the failures that choose the colours: `ink` on the stage below 3:1, `cta` on icy below 3:1 (the ring this pass deleted), `#FFFFFF` on icy below 3:1, and `ink` on white and on icy above 3:1 (the fourth failing pair, `#FFCE4B` on white, is asserted by the R05-8 block, where the amber appears as a surface).
- **Why the tile ring is white, not `ink`.** A tile's ring is drawn 2 px outside its border box, over the 3 px board gutter, so it is read against the page behind the board (`.stage-shell`, `app/globals.css:28-32`), not against the tile fill: white scores 20.17:1 on the gradient's top stop and 11.38:1 on its lightest (bottom) stop, while `ink` on that stage is 1.19:1. Measured, therefore: white is the only one of the two that survives. The exception §5.1 records is real but narrow — with `outline-offset: 2px` and a 2 px ring in a 3 px gutter, 1 px of the ring can overlap the neighbouring tile, where the worst family pastel `#9F7BEF` gives 3.20:1, above 1.4.11's 3:1 with no margin (U05-2, now answered).
- **Landmarks and the bypass block (R05-3).** The test asserts the skip link precedes `{children}` in the layout, that the layout contains no `app-root` (a link inside the shell would be inerted with it), and that `--z-skip` sits between `--z-preview` and `--z-modal` so the revealed link is above the preview layer and below an open modal. `id="main"` appears exactly once in each of `app/page.tsx`, `app/s/[domain]/page.tsx`, `app/legal/[slug]/page.tsx`, `app/pay/[paymentId]/PaySimulator.tsx` and `lib/boundaryChrome.tsx`, and twice in `app/elements/[sym]/page.tsx` where the signed-in and signed-out shells are separate branches and only one renders. The profile page is asserted to carry `<h1 ` and `<h2 `.
- **One element per id (R05-4).** For each of `url`, `title`, `pitch` the test counts exactly one `id="co-<field>-error"`, requires an `aria-describedby` that names it, and requires the server branch to be inside that same node (`serverField?.field === "url"` → a `font-bold` span within 120 characters), which is what makes "both branches true" impossible rather than unlikely.
- **The refunds copy (R05-6).** Probe 5.4.3 is the whole claim: the served rules page no longer says refunds do not exist, and says instead that a payment refunded by us or by the issuer after a dispute reverses the stake behind it — which is what `lib/recompute.ts:116,165` writes on `charge.refunded`/`PAYMENT_REVERSED` (`lib/stripe.ts:325-327,340`). The chargeback sentence was already true and is unchanged. **Deviation from the proposed fix:** the doc asked the wording change to be made by doc `16`; the contradiction is a copy defect in this pass's own scope, so it was fixed here and `16` can reword it as it likes — the requirement is only that the page stop contradicting the ledger.
- **The two mails (R05-7).** `emails/report.tsx` and `emails/waitlist.tsx` are new, both routed through `esc()` (`emails/escape.ts`) because the report `reason` is 280 characters of free text and the reported `domain` is whatever the visitor typed — the only other templates interpolate fields that `domainFromUrl` has already validated, so they are left alone. `lib/outbox.ts` gains `REPORT_EMAIL`/`WAITLIST_EMAIL` (`:20-21`), the two payload types (`:48,56`) and the two worker cases (`:98,103`); `lib/email.ts` gains `sendReportEmail` (`:153`) and `sendWaitlistEmail` (`:174`). `app/api/report/route.ts` enqueues at `:62` and drains at `:74`; `app/api/waitlist/route.ts` at `:58` and `:63`. The drain is bounded on purpose — `drainDueWithin(3_000, 5, [...])` — because the intake routes answer 200 by design and must never be held open by a 60-second vendor call; whatever the budget does not cover is picked up by the existing 04:00 `/api/jobs/outbox` cron, which claims untyped rows, so both types drain there too (well inside the 72 hours the page promises). Dedupe keys are stable across retries and distinct per event (`report-mail:<id>`, `waitlist-mail:<address>:<hour>`), no migration is needed (`EmailLog.template` is a plain string and `claimDueOutbox` casts the type), and the report mail goes to `REPORT_NOTIFY_EMAIL` — defaulting to the `abuse@` address the legal pages already print, now documented in `README.md:41` and `.env.example:18`. **Limit of this evidence:** no vendor send was observed here (no `RESEND_API_KEY`, no `DATABASE_URL` in this checkout), so what is proven is the enqueue/drain wiring, the copy, the escaping and the failure containment — all pinned in `lib/intakeMail.test.ts` — not the delivery; the DB-gated worker case runs in CI.
- **The pay gate (R05-8).** `app/pay/[paymentId]/page.tsx` is now a server component that calls `getProviderMode()` and `notFound()` unless the mode is `dev`, marked `force-dynamic` so the mode is read per request rather than frozen into a build. The simulator moved verbatim into `app/pay/[paymentId]/PaySimulator.tsx`, keeping its `<main id="main">` and its amber surface. Probes 5.4.4 and 5.4.5 are the two halves: in `dev` nothing changed for an operator, and with Stripe configured the page that used to advertise a missing configuration is a 404. **Deviation from the proposed fix:** the doc offered "move it under `/dev`" as an alternative; the mode gate was kept because the simulator's own API already refuses every non-`dev` mode (`app/api/dev/pay/route.ts:16,24`), so the page and the endpoint that backs it now share one condition instead of two address-based ones.
- **R05-5 is not in that list on purpose.** It is the one finding this pass did **not** change, and §7 records it as accepted risk with the library source that made the drafted impact wrong.
- **Suite result.** `npx vitest run` → **470 passed, 71 skipped, 6 failed** (547). The six are the pre-existing line-ending artifact this checkout already had (`lib/legalMeta.test.ts` ×5, `lib/claimFace.test.ts` ×1); they reproduce with this pass set aside. `npx tsc --noEmit` → exit 0; `npx next lint` → "No ESLint warnings or errors". §5.1's and §5.3's own figures are the pre-fix ones and are kept as such: `text-red-500` is now 0 sites and `text-ink/60` is 0 sites, and the red-700 count is **7**, not the 10 §5.3 counted, because three of those ten were pairs of mutually exclusive branches that the R05-4 fix collapsed into one element each.
- **This pass added 25 tests** (`lib/a11y.test.ts` 25 → 39 blocks, `lib/intakeMail.test.ts` new with 11) **and changed 24 source files while adding 5** (32 files in the diff once these three review docs are counted): the two templates plus `emails/escape.ts`, `PaySimulator.tsx` and the new test file. `lib/moderation.test.ts` also needed one teardown fix — the new report mail leaves an `EmailLog`-backed outbox row, and the suite's clean-up now deletes `report-mail:<id>` before the report it references.

## 6. Failure and edge matrix

| Trigger | What the user gets | Acceptable? |
| --- | --- | --- |
| Checkout error, then a re-broken field | red-700 text, one element per field id, described once | Yes — R05-1, R05-4 fixed |
| Tab into amount or search | a 2 px ring at 2 px offset, `ink` on light chrome | Yes — R05-2 fixed (a `cta` ring measured 1.43:1) |
| Screen reader on `/` or a profile | skip link, one `<main id="main">`, profile `<h1>` + `<h2>` | Yes — R05-3 fixed |
| Tab open an hour | 120 refetches while visible, **zero** while hidden; the stale copy already says updates are paused | Judgment, accepted — R05-5 (§9 Q2) |
| Refund on a settled stake | reversal row written; the rules now describe exactly that | Yes for the copy — R05-6 fixed; the reversal itself is still unobserved (probe table) |
| Report filed at 23:00 | row written and a `REPORT_EMAIL` attempted in the same request; retried by the 04:00 job | Yes — R05-7 fixed |
| Opening `/pay/<id>` | 404 outside mode `dev`; the simulator in `dev` | Yes — R05-8 fixed |

The row that carries the most risk is the last one: the gate is a server component reading `getProviderMode()`, so it is correct per request, and the simulator's copy can no longer be served to a visitor on a configured deployment.

## 7. Findings

### R05-1 — Error text misses the project's own contrast budget · P2 · a11y

*The description below is the reviewed state; the block after it is what this pass changed, and §4.1 has the post-fix anchors.*

- Evidence: ten `text-red-500` sites (`Modals.tsx:284,331,332,345,346,359,360,372,421,422`) and two `ink/60` labels (`TerritoryView.tsx:81`, `WorldOrder.tsx:36`) measure 3.49–3.95:1 (§5.1, §5.3) against the 4.5:1 budget the palette documents per token (`tailwind.config.ts:17-48`).
- Reproduction: open checkout on `/` and type "A" in the name field.
- Proposed fix: red-700 #B91C1C (6.47:1) and `ink/70` (5.43:1), both ratios asserted in `lib/a11y.test.ts`.
- **Status.** fixed
- **Fix.** The seven rendered error sites are red-700 (`components/Modals.tsx:310,358,374,390,404,458,459`) and the two panel labels are `text-ink/70` (`components/TerritoryView.tsx:81`, `components/WorldOrder.tsx:36`) — the exact colours the draft proposed, and the only two places outside the tile palette that were below the budget. The count moved 10 → 7 without deleting a message: three of the ten were pairs of mutually exclusive branches that R05-4 collapsed into a single element (§7 R05-4), so the fix pack's own change to one finding is what changed the other one's census.
- **Evidence.** §4.1, §5.4; `lib/a11y.test.ts` — the R05-1 block asserts red-700 ≥ 4.5:1 on white and icy, red-500 < 4.5:1 on both (the negative control), `ink/70` ≥ 4.5:1 on white and icy with `ink/60` below it, no `text-ink/60` in either panel, and no `text-red-500` anywhere under `components/` or `app/`.
- **Reproduction.** `npx vitest run lib/a11y.test.ts` (39 blocks, all pass). By hand: `/` → checkout → type "A" in the name field; the hint is #B91C1C.

### R05-2 — The only focus indicator is a 1.43:1 ring; search has none · P2 · a11y

*As above: the reviewed state first, the fix after it.*

- Evidence: `IcyInput.tsx:11` is `outline-none focus:ring-2 focus:ring-cta`; `cta` #FFC93C (`tailwind.config.ts:30`) is 1.43:1 icy / 1.54:1 white against 1.4.11's 3:1, and the same token marks the selected tile (`PeriodicGrid.tsx:258`) and active icon (`IconBtn.tsx:23`). `SearchPill.tsx:117` has no indicator; exotic tiles' white outline (`globals.css:585-587`) is 3.20:1 on the worst backdrop (U05-2).
- Reproduction: tab into a checkout field, then search.
- Proposed fix: a 2 px `ink` offset outline, a ring on search, and a test that every `outline-none` in `components/` has a ≥3:1 companion.
- **Status.** fixed
- **Fix.** Every focusable custom control that had suppressed its outline now draws `focus-visible:outline-2 outline-offset-2` in a colour chosen per surface: `outline-ink` on the light chrome (`components/IcyInput.tsx:11`, `components/SearchPill.tsx:117`, `components/IconBtn.tsx:21`) and `outline-white` where the surface behind the ring is dark (`components/Modal.tsx:111`, the modal card, and `components/Tile.tsx:63`, the board). The `cta` ring this finding named is gone, and so is the token's use as a focus colour. **Deviation from the proposed fix:** the doc proposed one 2 px `ink` outline everywhere; on the board that ring would measure 1.19:1 against the stage the tiles float on, so the tile keeps white — which is what `.exotic-tile:focus-visible` already did (`app/globals.css:586-589`) and is now consistent for every tile rather than only the exotic four.
- **Evidence.** §4.1, §5.4, §6; `lib/a11y.test.ts` — the `outline-none` inventory is pinned to exactly three files, every `outline-none` must have its `focus-visible:outline` on the same line, the ring colour per surface is asserted, and so are the ratios that force the choice (`ink` on stage 1.19:1, `cta` on icy 1.43:1, `#FFFFFF` on icy < 3:1, `ink` on white and icy ≥ 3:1).
- **Reproduction.** `npx vitest run lib/a11y.test.ts` (passes). By hand: tab through the home board, the search pill, the modal card and the checkout fields — each shows a ring; `npx vitest run lib/a11y.test.ts -t outline-none` fails if a fourth bare `outline-none` appears.

### R05-3 — No landmark and no skip link where the product lives · P3 · a11y

- Evidence: home served zero `<main` and no "skip to" (§5.2), and `app/s/[domain]/page.tsx` matched `<main|<h1|<h2|<h3` once — `:164` `<h3>Elements held</h3>` in a plain `<div>` — so it had no landmark either (§5.3); legal, element and pay pages did.
- Reproduction: `curl.exe -s https://www.periodictable.lol/ | Select-String '<main'` → nothing.
- Proposed fix: `<main>` on home and the profile, a skip link as the layout's first focusable element, and an `<h1>`/`<h2>` on the profile.
- **Status.** fixed
- **Fix.** `app/layout.tsx:33-37` opens with a `sr-only focus:not-sr-only` link to `#main`, deliberately outside `#app-root` because `Modal.tsx` sets `inert` on that subtree — a skip link inside it would be inert exactly when a modal is open. Its z-index is a token, `--z-skip: 65` (`app/globals.css:12`), placed above the preview layer and below an open modal. Home wraps its shell in `<main id="main">` (`app/page.tsx:443`); the profile's outermost `<div>` became `<main id="main">` and its title and grid caption became `<h1>` and `<h2>` (`app/s/[domain]/page.tsx:100,111,167`); the element (both branches), legal and boundary-chrome shells gained the `id` on the `<main>` they already had. **Caveat, pre-existing and out of scope:** `app/not-found.tsx` renders `BoundaryNotice` only, so on a 404 the skip link's target is absent — probe 5.4.5 shows that document has no `main` at all, and adding one there is a change to the boundary chrome this pass did not make.
- **Evidence.** §4.1, §5.4; `lib/a11y.test.ts` — skip link before `{children}`, no `app-root` in the layout, `--z-preview < --z-skip < --z-modal`, exactly one `id="main"` per surface (two in the element page's two branches), and `<h1 `/`<h2 ` on the profile; probes 5.4.1–5.4.3 are the served-HTML halves.
- **Reproduction.** `npx vitest run lib/a11y.test.ts` (passes). By hand on a dev server: `/` → press Tab once, the link appears and jumps past the board; view source and count `<main`.

### R05-4 — Client and server errors share one element id · P3 · a11y

- Evidence: `Modals.tsx:331`/`:332` both rendered `id="co-url-error"`, `:345`/`:346` `co-title-error`, `:359`/`:360` `co-pitch-error`, and each field's `aria-describedby` (`:329,343,357`) named that one id — with both branches true the document held duplicate ids and the description resolved to the first div.
- Reproduction: submit a valid title, then edit it to one character while the reply is in flight.
- Proposed fix: separate id for the server branch, both listed, or one source rendering one message; pin with a render test.
- **Status.** fixed
- **Fix.** Took the third option, because it is the one a source-pinned test can hold: each field renders exactly one node with that id (`components/Modals.tsx:358,374,390`) and the node contains both the client hint and, when the server named the same field, the server's own message in a `<span className="font-bold">`. The `aria-describedby` attributes (`:355,371,387`) point at that single element and are only rendered when one of the two sources has something to say; `co-email-error` (`:404`) was already a single node and is unchanged.
- **Evidence.** §4.1, §5.4; `lib/a11y.test.ts` — one `id="co-<field>-error"` per field, an `aria-describedby` naming it, and the server branch asserted to live inside that same node.
- **Reproduction.** `npx vitest run lib/a11y.test.ts` (passes). By hand: submit a valid title, then edit it to one character while the reply is in flight — one red node, both sentences, one referent. A live DOM assertion needs jsdom, which this suite does not use (U05-3, U02-1).

### R05-5 — Four panels re-fetch every 30 s with no way to pause · P3 · a11y

- Evidence: `refreshInterval: 30000` at `app/page.tsx:67,73,76`, `ActivityCard.tsx:36`, `TerritoryView.tsx:31`, `WorldOrder.tsx:23`, with no `visibilitychange` guard in those files or `lib/liveState.ts`. WCAG 2.2.2 covers auto-updating content past five seconds: a tab open an hour refetches 480 times, numbers shift under a pointer, and no panel is `aria-live`.
- Reproduction: open `/` and watch the network panel.
- Proposed fix: pause when hidden, add a "live updates" toggle; if always-live is deliberate, record accepted risk in §9.
- **Status.** accepted-risk
- **Fix.** None — and the drafted impact does not reproduce. The four surfaces call `useSWR` with `refreshInterval` and no other polling option, and SWR only fires an interval tick while the document is visible: `if (!getCache().error && (refreshWhenHidden || getConfig().isVisible()) && …)` (`node_modules/swr/dist/use-swr-guqrv3k1.js:624`, with `isActive = () => getConfig().isVisible() && getConfig().isOnline()` at `:121`). A hidden tab therefore refetches zero times, not 480; a tab that is *being read* refetches 120 times an hour, which is the feature §2's actors want — a live board. The interrupted-pause copy the draft asked for already exists for the case that matters, a failed refresh: "Last known data — live updates are paused." (`lib/liveState.ts:39`). On 4.1.3 the panels are deliberately not `aria-live`: a number that changes every 30 seconds announcing itself would interrupt a screen-reader user mid-sentence, and the two events a person must not miss — data unavailable and a completed action — already announce (`components/LiveDataNotice.tsx:23`, `components/Toast.tsx:19`). **Deviation from the proposed fix:** no pause toggle was added. A toggle would give the visitor a control whose off state removes the product's main claim, and the cost the draft named (traffic and movement under a reader who has walked away) does not occur.
- **Evidence.** §4.1, §5.4, §6; `lib/a11y.test.ts` — no `.tsx` under `components/` or `app/` matches `refreshWhenHidden` (so no surface can opt back in), all four surfaces still set `refreshInterval: 30000`, and `lib/liveState.ts` still carries the paused copy.
- **Reproduction.** `npx vitest run lib/a11y.test.ts -t R05-5` (passes). By hand: open `/`, hide the tab for ten minutes, then look at the network panel — no requests while hidden, the interval resumes when the tab returns.

### R05-6 — "No refunds" contradicts the shipped reversal path · P3 · content

- Evidence: `/legal/rules` served "we do not offer refunds" twice (§5.2), written at `app/legal/[slug]/page.tsx:81-84`, while `lib/recompute.ts:116` describes reversing "a settled payment's contribution to the ledger (refund/chargeback)" and writes `kind: "refund"` at `:165`, driven by `lib/stripe.ts:325-327` (`charge.refunded`) and `:340` (`PAYMENT_REVERSED`); the chargeback sentence (`:84`) did match.
- Reproduction: refund a settled payment in Stripe test mode — the row is written while the page says none exist; **not run** (see the probe table).
- Proposed fix: say a chargeback or an operator-granted refund reverses a stake; wording belongs to doc `16`.
- **Status.** fixed (copy)
- **Fix.** The heading is "Refunds & disputes" (`app/legal/[slug]/page.tsx:86`) and the paragraph now reads that all stakes are final, that a payment refunded by us or by the card issuer after a dispute reverses the stake behind it, and that a payment problem should be raised with us before a dispute is filed (`:88-89`). The false sentence is gone from the served page — 0 hits for "no refunds" or "do not offer refunds", where §5.2 counted 2. **Deviation from the proposed fix:** the doc assigned the wording to doc `16`; a page contradicting the ledger is this pass's own defect class (§3.2 item 5), so it is fixed here, and `16` remains free to reword it.
- **Evidence.** §4.1, §5.4 (probe 5.4.3); `app/legal/[slug]/page.tsx:86-89` against `lib/recompute.ts:116,165` and `lib/stripe.ts:325-327,340`.
- **Reproduction.** `curl.exe -s http://localhost:3111/legal/rules | Select-String "Refunds|no refunds"` on a dev server (one "Refunds", zero "no refunds"). The reversal itself still needs a test-mode refund: not run here.

### R05-7 — Two promises nothing keeps · P3 · content

- Evidence: "actioned within 72 hours" (`app/legal/[slug]/page.tsx:104`, served by `/legal/contact`, §5.2) against the only report surface, a pull queue (`app/api/admin/reports/route.ts`, `take: 50`): `emails/` held just `outbid.tsx` and `receipt.tsx`, so nothing said a report arrived. The waitlist toast promised "we'll be in touch" (`Modals.tsx:192`) while a join wrote a row and an audit entry and sent nothing (`app/api/waitlist/route.ts:39,44`).
- Reproduction: join the waitlist with a real address, or file a report — neither sent mail.
- Proposed fix: one mail per new report and per waitlist row (Resend is wired, `lib/email.ts`), or soften both strings.
- **Status.** fixed
- **Fix.** Took the first option, in the shape the rest of the system already uses — a queue row in the same transaction as the event, drained by the existing worker. `emails/report.tsx` and `emails/waitlist.tsx` join the template set (`emails/escape.ts` escapes both, because the report `reason` is free text); `lib/outbox.ts` grows `REPORT_EMAIL`/`WAITLIST_EMAIL` with their payloads (`:20-21,48,56`) and worker cases (`:98,103`); `lib/email.ts` grows `sendReportEmail` (`:153`) and `sendWaitlistEmail` (`:174`). Each intake route enqueues (`app/api/report/route.ts:62`, `app/api/waitlist/route.ts:58`) and then drains with a deliberately small budget, `drainDueWithin(3_000, 5, [type])` (`:74` and `:63`), so the always-200 intake is never held open by a slow vendor call; anything left is drained by the 04:00 `/api/jobs/outbox` cron, which claims untyped rows, well inside the 72 hours the contact page promises. The report mail goes to `REPORT_NOTIFY_EMAIL`, defaulting to the `abuse@` address the legal pages print (documented at `README.md:41`, `.env.example:18`). Dedupe keys are per event and stable across retries (`report-mail:<id>`, `waitlist-mail:<address>:<hour>`), payloads carry only values already audited (no IP), no migration is needed, and the unknown-type throw in the worker is preserved. **Deviation from the proposed fix:** the alternative — softening both strings — was rejected as the work of deleting a promise the product can now keep.
- **Evidence.** §4.1, §5.4; `lib/intakeMail.test.ts` (11 tests: subject and body copy of both templates, `esc()` on the interpolated free text, `REPORT_NOTIFY_EMAIL` wiring and its default, enqueue-before-drain ordering, the exact `drainDueWithin(3_000, 5, […])` budget, the catch → `console.warn` → still `ok: true` containment, both dedupe keys, both worker cases, and the preserved unknown-type throw).
- **Reproduction.** `npx vitest run lib/intakeMail.test.ts` (passes). With a database and a key, a report sends to `REPORT_NOTIFY_EMAIL` and a join sends its confirmation — not observed in this checkout (no `DATABASE_URL`, no `RESEND_API_KEY`), where the DB-gated worker case is skipped as everywhere else.

### R05-8 — Production serves the dev-simulator copy on /pay/[paymentId] · P3 · content

- Evidence: `/pay/probe-0000` answered 200 with "DEV SIMULATOR", "No Stripe keys configured — this simulator stands in for the real checkout." and "Simulate failure" (draft's capture; the same route after the fix is §5.4.4), from `app/pay/[paymentId]/page.tsx:52,55,93`. The API was correctly gated — `app/api/dev/pay/route.ts:15` 403s unless provider mode is `dev` — so the page was inert but stated a configuration fact that is false in production.
- Reproduction: open any `/pay/<id>` on the live site.
- Proposed fix: render it only in mode `dev` and 404 otherwise, or move it under `/dev`; test with a bogus id in a live-mode build.
- **Status.** fixed
- **Fix.** The route is now a server gate: `getProviderMode() !== "dev"` → `notFound()` (`app/pay/[paymentId]/page.tsx:17`), marked `export const dynamic = "force-dynamic"` (`:5`) so the provider mode is read per request instead of being frozen into a build. The simulator moved unchanged into `app/pay/[paymentId]/PaySimulator.tsx`, a client component that keeps its `<main id="main">` and its amber surface. **Deviation from the proposed fix:** the "move it under `/dev`" alternative was not taken, because the endpoint behind the page already refuses every non-`dev` mode (`app/api/dev/pay/route.ts:16,24`) — one condition now governs both, and moving the page would have left two address-based rules to keep in step.
- **Evidence.** §4.1, §5.4 (probes 5.4.4, 5.4.5, 5.4.6); `lib/a11y.test.ts` — the page has no `"use client"`, it calls `getProviderMode()`, it calls `notFound()`, it is `force-dynamic`, and the simulator keeps its landmark and its amber-with-dark-text surface.
- **Reproduction.** `npx vitest run lib/a11y.test.ts -t R05-8` (passes). By hand: start a dev server with `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`PAYMENTS_LIVE=true` set and open `/pay/anything` — 404; start one without them and the same URL serves the simulator.

## 8. Acceptance criteria

Ticked boxes are verified by §5.4; the unticked one is a probe this pass could not run.

- [x] No `text-red-500` on an error path; text tokens ≥4.5:1, asserted in `lib/a11y.test.ts` (R05-1: red-700 on all seven sites, `ink/70` on both panel labels)
- [x] Every `outline-none` in `components/` has a ≥3:1 indicator, search included (R05-2: three files, each with a ring chosen against its own backdrop; the `cta` ring is gone)
- [x] Home and the profile render `<main>`, the layout carries a skip link, no page starts below `<h1>` (R05-3; probes 5.4.1–5.4.3, with the `not-found` caveat recorded in §7)
- [x] No rendered modal holds a duplicate id; every `aria-describedby` resolves to one element (R05-4; pinned at source, since the suite has no DOM)
- [x] `/pay/<id>` 404s in a live-mode build; panels pause when hidden or always-live is accepted in §9 (R05-8 probe 5.4.5; R05-5 accepted risk on §9 Q2, matching SWR's own visibility gate)
- [x] The refunds section stops contradicting the reversal path it describes (R05-6, probe 5.4.3 — copy only)
- [x] A report and a waitlist join each raise mail, and neither can hold the intake open (R05-7, `lib/intakeMail.test.ts`; the vendor send itself is unverified here — no key, no `DATABASE_URL`)
- [ ] A real refund proves R05-6's reversal end to end — still open: the probe was not run, so what is verified is the copy against the code path, not the path itself

## 9. Open questions

1. **Prices as text.** `text-money` (3.00–3.25:1) has 22 sites; `moneyink` #5F4700 (8.79:1) beats auditing every rendered size, and U05-1 decides. *Still open — untouched by the fix pack, which changed only the error and muted tokens.*
2. **Is the always-live board a feature?** *Answered by the fix: yes on a visible tab, and moot on a hidden one. The drafted cost — 480 refetches in an hour — does not occur, because SWR 2.5.1 gates the interval on document visibility and none of the four surfaces overrides it (§7 R05-5). R05-5 is therefore recorded as accepted risk rather than fixed, and no toggle was added: the paused copy already covers the state that needs one (`lib/liveState.ts:39`).*

## 10. Cross-references

- Ledger §3b (prices, floor, takeover), §7 (provider keys): cited, not re-derived.
- `02` U02-1 is why §3.1 says "Unverified" and why R05-4's duplicate-id claim is pinned at source; `03` R03-4 owns `aria-expanded`, R05-2 its focus only; `04` R04-2's string side is §3.3.
- `doc/project-review/plan.md:67`, `files/validation-matrix.md:132`: today's reduced motion and live regions are correct *because of* that review; the red-500 miss was a gap in its contrast fix, and it is closed now.
- `lib/a11y.test.ts` is the machine-checked counterpart of this document: every fix above names the assertion that holds it, and the `outline-none` inventory, the token ratios and the polling options are asserted rather than transcribed.

## 11. Change log

| Date | Commit | Change |
| --- | --- | --- |
| 2026-09-14 | `6616a49` | First draft, batch 1 |
| 2026-09-14 | (working tree) | Fix pass for R05-1…R05-4 and R05-6…R05-8, with R05-5 recorded as accepted risk: red-700 + `ink/70` across the error and muted text, per-surface focus rings on all five `outline-none`/tile controls, the layout skip link and a single `<main id="main">` per surface, one element per error id, the refunds copy, `emails/{report,waitlist}.tsx` with two new queue types and a bounded in-request drain, and the `/pay/<id>` provider-mode gate. 25 new tests in `lib/a11y.test.ts` (+14) and `lib/intakeMail.test.ts` (new, 11). `npx vitest run` → 470 passed / 71 skipped / 6 failed (all 6 pre-existing CRLF artifacts of this Windows checkout; reproduce with the pass stashed), `npx tsc --noEmit` and `npx next lint` clean, two live dev-server probes recorded in §5.4. Working tree, uncommitted. |

## 12. UNKNOWN log

| Id | Unknown | What settles it |
| --- | --- | --- |
| U05-1 | Whether the 22 `text-money` sites (e.g. `SearchPill.tsx:157`) render ≥18.66 px bold — which 3.00–3.25:1 passes — or are failing small text | `getComputedStyle` over `.text-money` at 1280/360 px; unchanged by this pass |
| U05-2 | Whether the white `.exotic-tile:focus-visible` outline clears 3:1 on every exotic theme | **Answered:** the outline is drawn 2 px outside the tile, so it is read against the board's dark stage (20.17:1 at the top gradient stop, 11.38:1 at the lightest) and not against the tile fill; the only surface it can touch that is light is a 1 px overlap onto a neighbouring tile, where the worst family pastel `#9F7BEF` gives 3.20:1 — over 1.4.11's 3:1 with no margin, so no exotic theme, and no standard tile, puts the ring on a failing backdrop (§5.4, §7 R05-2) |
| U05-3 | Tab order, focus visibility and 1.4.10 reflow at 400 % zoom | Blocked by U02-1 (`02` §5.8); this pass added source and served-HTML checks, not a rendered DOM walk |
