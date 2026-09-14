# 05 — Accessibility and content

| Field | Value |
| --- | --- |
| Phase · batch | 05 · 1 |
| Status | draft |
| Date · commit | 2026-09-14 · `6616a49` + live build (§5.2) |
| Reviewer | review agent |

| Probe not run | Why | Residue |
| --- | --- | --- |
| DOM pass, keyboard walk (axe, focus order, zoom) | headless Chrome writes nothing (`02` §5.8; U02-2) | none |
| Refund to prove R05-6 | read-only default | reversal + `refund` row |

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
| 1.4.3 small text | Fail | R05-1: red-500 3.76:1 white / 3.49:1 icy; `ink/60` 3.62–3.95:1 |
| 1.4.3 large text | Unverified | `text-money` 3.00–3.25:1 passes only at ≥18.66 px bold (U05-1) |
| 1.4.11 · 2.4.1 · 2.4.6 · 2.4.7 | Fail | R05-2 (`cta` ring 1.43:1 icy / 1.54:1 white; `SearchPill.tsx:117` none), R05-3 (home no `<main>`, no skip link; profile headings start at `<h3>`) |
| 2.2.2 | Conditional | R05-5: four panels refetch every 30 s; none is `aria-live` |
| Rest | Pass, caveats | 4.1.3 (`LiveDataNotice.tsx:23`, `Toast.tsx:19`); trap (`Modal.tsx:100-118`); `lang="en"` (`app/layout.tsx:25`); hue never alone (`Tile.tsx`); amount field lacks `aria-invalid` (`Modals.tsx:301`) |

### 3.2 Copy inventory

1. **Two labels for one rule.** Client "Name must be 2–32 characters." (`Modals.tsx:345`) vs server "at least 2"/"32 characters max" (`lib/validate.ts:96-97`).
2. **A lock the code does not honour.** `emails/outbid.tsx:2-3` names the subject and body it intends; `:40-70` renders others.
3. **Profile drift:** "elements claimed" (`:132`), "elements" (`:156`), "Elements held" (`:164`) in `app/s/[domain]/page.tsx`; "✦ OFFICIALLY ON THE TABLE ✦" (`:107`) reads as endorsement on the page that disclaims it (`:199`).
4. **"counts a verified redirect"** (`emails/receipt.tsx`) vs **"visits are counted"** (`app/s/[domain]/page.tsx:148`) — the counter counts click-throughs (`03` §3).
5. **Honest:** the money rules match the code (ledger §3b); "we do not offer refunds" does not (R05-6).

### 3.3 Facts the UI states that the server does not guarantee

"held for 15 min" (`Modals.tsx:395`; R04-2) · "verified redirect" (3.2.4) · "actioned within 72 hours" and "we'll be in touch" (R05-7) · "No Stripe keys configured" (R05-8).

## 4. The path, walked

`/` serves `lang="en"` and Plausible only when `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is set (`app/layout.tsx:22,25,27-29`); one `<h1>`, no `<main>` (§5.2). Arrow keys move the grid (`lib/gridNav.ts`) and checkout traps focus (`Modal.tsx:100-118`). Typing "A" in the name field paints the 3.76:1 error; a server rejection adds a second div with the same id (R05-1, R05-4). Paying is the irreversible point (`04` §4); `/pay/<id>` answers anyone who guesses it (R05-8).

## 5. Live evidence

**5.1** Contrast from the real tokens (`node`, 2026-09-14T16:56:55Z): red-500 3.76:1 white, 3.49:1 icy; `cta` #FFC93C ring 1.43:1 icy, 1.54:1 white; `money` #B8860B 3.25:1 white / 3.00:1 goldwash; red-700 6.47:1 white, 6.00:1 icy; white outline on the worst exotic #9F7BEF 3.20:1.
**5.2** Served HTML, `curl.exe -s -o <f>.html -w "%{http_code} %{size_download}"`, 2026-09-14T16:56:16Z, in `files\evidence05\`: home 200 149431, rules 200 17057, contact 200 11673, pay/probe-0000 200 7366. Home `<main` 0, "skip to" 0, `<h1` 1. Pay carries "DEV SIMULATOR" and "Simulate failure". Rules: "we do not offer refunds" 2, `<main` 1.
**5.3** Blast radius (`Select-String`): `text-red-500` 10 hits, all `Modals.tsx`; `ink/60` at `TerritoryView.tsx:81`, `WorldOrder.tsx:36`; `text-money` 22 hits in 12 files; the profile's heading match only `:164` `<h3>`.

## 6. Failure and edge matrix

| Trigger | What the user gets | Acceptable? |
| --- | --- | --- |
| Checkout error, then a re-broken field | faint red text; two divs, one id | No — R05-1, R05-4 |
| Tab into amount or search | 1.43:1 ring, or none | No — R05-2 |
| Screen reader on `/` or a profile | no skip link, no `<main>` | No — R05-3 |
| Tab open an hour | 480 refetches, numbers shift mid-read | Judgment — R05-5 |
| Refund on a settled stake | reversal row written; rules say never | No — R05-6 |
| Report filed at 23:00 | row waits in a pull queue | No — R05-7 |
| Opening `/pay/<id>` | simulator copy, inert buttons | No — R05-8 |

## 7. Findings

### R05-1 — Error text misses the project's own contrast budget · P2 · a11y
Ten `text-red-500` sites (`Modals.tsx:284,331,332,345,346,359,360,372,421,422`) and two `ink/60` labels (`TerritoryView.tsx:81`, `WorldOrder.tsx:36`) measure 3.49–3.95:1 (§5.1, §5.3) against the 4.5:1 budget the palette documents per token (`tailwind.config.ts:17-48`). Repro: open checkout on `/` and type "A" in the name field. Fix: red-700 #B91C1C (6.47:1) and `ink/70` (5.43:1), both ratios asserted in `lib/a11y.test.ts`. Status: open.

### R05-2 — The only focus indicator is a 1.43:1 ring; search has none · P2 · a11y
`IcyInput.tsx:11` is `outline-none focus:ring-2 focus:ring-cta`; `cta` #FFC93C (`tailwind.config.ts:30`) is 1.43:1 icy / 1.54:1 white against 1.4.11's 3:1, and the same token marks the selected tile (`PeriodicGrid.tsx:258`) and active icon (`IconBtn.tsx:23`). `SearchPill.tsx:117` has no indicator; exotic tiles' white outline (`globals.css:585-587`) is 3.20:1 on the worst backdrop (U05-2). Repro: tab into a checkout field, then search. Fix: a 2 px `ink` offset outline, a ring on search, and a test that every `outline-none` in `components/` has a ≥3:1 companion. Status: open.

### R05-3 — No landmark and no skip link where the product lives · P3 · a11y
Home serves zero `<main` and no "skip to" (§5.2), and `app/s/[domain]/page.tsx` matches `<main|<h1|<h2|<h3` once — `:164` `<h3>Elements held</h3>` in a plain `<div>` — so it has no landmark either (§5.3); legal, element and pay pages do. Repro: `curl.exe -s https://www.periodictable.lol/ | Select-String '<main'` → nothing. Fix: `<main>` on home and the profile, a skip link as the layout's first focusable element, and an `<h1>`/`<h2>` on the profile. Status: open.

### R05-4 — Client and server errors share one element id · P3 · a11y
`Modals.tsx:331`/`:332` both render `id="co-url-error"`, `:345`/`:346` `co-title-error`, `:359`/`:360` `co-pitch-error`, and each field's `aria-describedby` (`:329,343,357`) names that one id — with both branches true the document holds duplicate ids and the description resolves to the first div. Repro: submit a valid title, then edit it to one character while the reply is in flight. Fix: separate id for the server branch, both listed, or one source rendering one message; pin with a render test. Status: open.

### R05-5 — Four panels re-fetch every 30 s with no way to pause · P3 · a11y
`refreshInterval: 30000` at `app/page.tsx:67,73,76`, `ActivityCard.tsx:36`, `TerritoryView.tsx:31`, `WorldOrder.tsx:23`, with no `visibilitychange` guard in those files or `lib/liveState.ts`. WCAG 2.2.2 covers auto-updating content past five seconds: a tab open an hour refetches 480 times and numbers shift under a pointer, and no panel is `aria-live`, so the cost is movement and traffic. Repro: open `/` and watch the network panel. Fix: pause when hidden, add a "live updates" toggle; if always-live is deliberate, record accepted risk in §9. Status: open.

### R05-6 — "No refunds" contradicts the shipped reversal path · P3 · content
`/legal/rules` serves "we do not offer refunds" twice (§5.2), written at `app/legal/[slug]/page.tsx:81-84`, while `lib/recompute.ts:116` describes reversing "a settled payment's contribution to the ledger (refund/chargeback)" and writes `kind: "refund"` at `:165`, driven by `lib/stripe.ts:325-327` (`charge.refunded`) and `:340` (`PAYMENT_REVERSED`); the chargeback sentence (`:84`) does match. Repro: refund a settled payment in Stripe test mode — the row is written while the page says none exist; not run (see the probe table). Fix: say a chargeback or an operator-granted refund reverses a stake; wording belongs to doc `16`. Status: open.

### R05-7 — Two promises nothing keeps · P3 · content
"actioned within 72 hours" (`app/legal/[slug]/page.tsx:104`, served by `/legal/contact`, §5.2) against the only report surface, a pull queue (`app/api/admin/reports/route.ts`, `take: 50`): `emails/` holds just `outbid.tsx` and `receipt.tsx`, so nothing says a report arrived. The waitlist toast promises "we'll be in touch" (`Modals.tsx:192`) while a join writes a row and an audit entry and sends nothing (`app/api/waitlist/route.ts:39,44`). Repro: join the waitlist with a real address, or file a report — neither sends mail. Fix: one mail per new report and per waitlist row (Resend is wired, `lib/email.ts`), or soften both strings. Status: open.

### R05-8 — Production serves the dev-simulator copy on /pay/[paymentId] · P3 · content
`/pay/probe-0000` answers 200 with "DEV SIMULATOR", "No Stripe keys configured — this simulator stands in for the real checkout." and "Simulate failure" (`files\evidence05\pay.html`), from `app/pay/[paymentId]/page.tsx:52,55,93`. The API is correctly gated — `app/api/dev/pay/route.ts:15` 403s unless provider mode is `dev` — so the page is inert but states a configuration fact that is false in production. Repro: open any `/pay/<id>` on the live site. Fix: render it only in mode `dev` and 404 otherwise, or move it under `/dev`; test with a bogus id in a live-mode build. Status: open.

## 8. Acceptance criteria

- [ ] No `text-red-500` on an error path; text tokens ≥4.5:1, asserted in `lib/a11y.test.ts`.
- [ ] Every `outline-none` in `components/` has a ≥3:1 indicator, search included.
- [ ] Home and the profile render `<main>`, the layout carries a skip link, no page starts below `<h1>`.
- [ ] No rendered modal holds a duplicate id; every `aria-describedby` resolves to one element.
- [ ] `/pay/<id>` 404s in a live-mode build; panels pause when hidden or always-live is accepted in §9.

## 9. Open questions

1. **Prices as text.** `text-money` (3.00–3.25:1) has 22 sites; `moneyink` #5F4700 (8.13:1) beats auditing every rendered size, and U05-1 decides.
2. **Is the always-live board a feature?** If yes, R05-5 becomes accepted risk with a line here.

## 10. Cross-references

- Ledger §3b (prices, floor, takeover), §7 (provider keys): cited, not re-derived.
- `02` U02-1 is why §3.1 says "Unverified"; `03` R03-4 owns `aria-expanded`, R05-2 its focus only; `04` R04-2's string side is §3.3.
- `doc/project-review/plan.md:67`, `files/validation-matrix.md:132`: today's reduced motion and live regions are correct *because of* that review; the red-500 miss is a gap in its contrast fix.
- `lib/a11y.test.ts` is the machine-checked counterpart; each fix names the assertion to add.

## 11. Change log

| Date | Commit | Change |
| --- | --- | --- |
| 2026-09-14 | `6616a49` | First draft, batch 1 |

## 12. UNKNOWN log

| ID | Unknown | What settles it |
| --- | --- | --- |
| U05-1 | Whether the 22 `text-money` sites (e.g. `SearchPill.tsx:157`) render ≥18.66 px bold — which 3.00–3.25:1 passes — or are failing small text | `getComputedStyle` over `.text-money` at 1280/360 px |
| U05-2 | Whether the white `.exotic-tile:focus-visible` outline clears 3:1 on every exotic theme | Focus each theme's tile, sample outline vs background |
| U05-3 | Tab order, focus visibility and 1.4.10 reflow at 400 % zoom | Blocked by U02-1 (`02` §5.8) |
