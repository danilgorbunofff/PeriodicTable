# 04 — Element detail and pricing

| Field | Value |
| --- | --- |
| Phase · batch | 04 · 1 |
| Status | draft |
| Date reviewed | 2026-09-14 |
| Commit reviewed | `3b0d007`; live build (§5.3) |
| Reviewer | review agent |

| Probe not run | Why | Residue |
| --- | --- | --- |
| Real $5 card payment (J4) | Operator deferral until batch 1 and checkout are fixed | 1 `Payment`, 1 `Stake`, 1 `ActivityLog`, a real charge |
| Direct Neon read | no `psql`, no `DATABASE_URL` here (§5.4) | None — read only |
| Element-page screenshots | Chrome 152 writes no PNG here (`02` §5.8) | None |
| Claimed-state render | Needs one live stake — the J4 rows | As J4 |

## 1. Scope

Owns S4: `/elements/[sym]` with metadata and JSON-LD, `/api/elements/[sym]`, every price those surfaces print (CTA, deep link, modal `need`), what `/api/checkout` and `lib/settle.ts` enforce, `reclaimFor`, `classifyAndValidate`, the 15-minute reservation, and what `/api/activity` shows for the same stake. Not owned: `03`, `05`-`09`, `11`, `15`.

Inspected whole: `app/elements/[sym]/page.tsx`, `app/api/elements/[sym]/route.ts`. Also `app/api/checkout/route.ts:143-360`, `app/api/activity/route.ts`, `lib/{pricing,reservations,moderation,audit,email}.ts` (email `:60-100`), `lib/settle.ts:150-180`, `lib/recompute.ts:130-235`, `lib/pricing.test.ts:91-95`, `components/{Modals,TerritoryView}.tsx`, `app/page.tsx:90-130`, `prisma/schema.prisma:212-220,338-344`.

## 2. Actors

- **Newcomer** — no `Stake` row for the domain in the form; floored at $5 (`app/api/checkout/route.ts:218`, `lib/pricing.ts:7,73`).
- **Returning holder** — a live row (`amountUsd > 0`) for their `startupId`; tops up from $1, owes only the shortfall.
- **Hidden holder, reversed bidder** — a `HIDDEN` row is off every ranked list but still counted in `pool`/`count` (`lib/moderation.ts`; `03` R03-2); a row left at `$0` is not a holding (`:215-217`).
- **Leader, rival, crawler** — the top of the hidden-filtered list sets every takeover price; the crawler reads title, H1, JSON-LD `ItemList` (`page.tsx:14-22,83-92`).

## 3. Intended behaviour

Entering a claimed element costs $5 at minimum; taking #1 costs a dollar over the leader — `takeLeadPrice` is $5 on an empty element, `leaderTotal + 1` otherwise (`lib/pricing.ts:9-10`). A returning holder pays only the shortfall: `reclaimFor` = `max(1, leaderTotal + 1 - myPriorTotal)`, or $5 while the element is empty (`lib/pricing.ts:15-18`), the delta the outbid mail quotes (`lib/email.ts:83`; ledger §4c `:280`). Landing exactly on an existing total is refused, not sold. A take is a promise: a `Reservation` holds the quote 15 minutes and settlement honours it or throws, never reprices (`lib/reservations.ts:5-7`, `lib/settle.ts:161`). Identity is the domain typed into the form — so only the domain presented at that moment can be priced.

## 4. The path, walked

**4.1 Page.** Lookup is `ELEMENTS.find((e) => e.symbol === symbol)`, no case folding (`page.tsx:15-16,26-27`); the query filters `moderationState != HIDDEN` (`:29-50`); takeover is `lead.amountUsd + 1`, else 5 (`:80-82`); the CTA deep-links `/?el=<SYM>&stake=<takeLead>` (`:127-130`) and a failed read serves a shell hardcoding `stake=5` (`:52-78`).

**4.2 Quote API.** `/api/elements/[sym]` reads the same filtered list (`route.ts:13`), sets `leaderIdx` to the first `amountUsd > 0` (`:30-31`), and with `?me=` adds `reclaimFor(leaderTotal, mine?.amountUsd)` off that filtered array (`:47-52`).

**4.3 Modal.** The payload's only consumer (`components/TerritoryView.tsx:42-43`) derives identity from the typed URL (`Modals.tsx:145-150`), prints `need` (reclaim delta, else `prices.takeLead`) plus a hold line when `takeQuoted` (`:154-166,393-395`), and a `min={1}` field (`:378`) nothing rewrites when `need` changes.

**4.4 Enforcement.** `POST /api/checkout` locks, releases expired holds and re-reads every stake in one transaction (`:182-196`); it prices off the first non-hidden, non-zero row (`:210-213`) but finds the caller by `startupId` unfiltered (`:215-218`), so a hidden row keeps `isNewHere`/`myPriorTotal` true while `existingTotals` still lets it force a tie (`:220-221`). `classifyAndValidate` maps the amount to TAKE/JOIN/RECLAIM/STAKE (`:222-241`); only TAKE reserves, at `leader + 1` (`:296-311`), and settlement throws `take-below-reserve` when short (`lib/settle.ts:161`).

## 5. Live evidence

2026-09-14, 16:32-16:33 +02:00, this host, `https://www.periodictable.lol`; bodies kept in `files\evidence04\`.

| # | Probe | Result |
| --- | --- | --- |
| 5.1 | `/api/elements/Au` `14:32:13Z` | 200, 170 B: `pool:0`, `count:0`, `stakes:[]`, `prices:{"takeLead":5,"joinMin":5}`; no `reclaim` without `?me=` |
| 5.2 | Same, `?me=probe-doc04.example` | 182 B, adds `"reclaim":5` — an unknown domain gets `MIN_STAKE` (`lib/pricing.ts:15-18`), not $1 |
| 5.3 | `/elements/Au` `14:33:08Z` | 200, 2,967 B, `X-Vercel-Cache: HIT`, `Age: 27`; body holds `0 stakers · $0 pool · take #1 for $5`, `href="/?el=Au&stake=5"` and an empty JSON-LD `ItemList`, not the shell's "Live standings load with a database connection." (`page.tsx:64`) — the live empty board at $5 |
| 5.4 | `psql --version`; `.env*`; `$env:DATABASE_URL` | no psql, no `.env`/`.env.local`, empty `DATABASE_URL` → no DB read this session; the ledger's machine check found `psql` on 2026-09-11 (`doc/PROD-READINESS-CHECKLIST.md:12`) |
| 5.5 | `/elements/au`, `/api/elements/au`, `/api/elements/AU` | 404 (1,909 / 54 / 54 B) vs `/elements/Au` 200 (§5.3) — case-sensitive on both surfaces |
| 5.6 | `/api/activity?limit=6` | `[]`, agreeing with `count:0` (§5.1) and the emptied prod state (ledger §7 `:296-302`) |
| 5.7 | Repo-wide grep `validateTake` | only `lib/pricing.test.ts:11,93-95` reference it (`lib/pricing.ts:53-58`) |

## 6. Failure and edge matrix

| State of the element | Page CTA | `prices` with `?me=` | Modal `need` | Server verdict for that amount |
| --- | --- | --- | --- | --- |
| Empty (production today) | $5 | `takeLead 5`, `joinMin 5`, `reclaim 5` | $5 | JOIN at $5+; $1-4 refused (`lib/pricing.ts:73`) |
| Visible leader at $L | $L+1 | `takeLead L+1` | $L+1 for a newcomer | TAKE at $L+1, reserved 15 min |
| Returning holder (prior $T, leader $L) | $L+1 | `reclaim max(1, L+1-T)` | the same delta | RECLAIM above `L`, top-up below; no reservation |
| Hidden holder (prior $T) | $L+1 | `reclaim L+1` — row filtered out | $L+1, `priorHere` false | RECLAIM/top-up from $T, never TAKE, so the hold line is false (R04-2) |
| Board moves after the quote | stale | — | stale | stale-high take → 409 + fresh `takeLead`; stale-low reclaim settles as a top-up, wins nothing (R04-1) |

A take quote writes a `Reservation` holding element, buyer, `reservedTotal` and a 15-minute expiry, during which no rival can take that element and the buyer's own top-ups cannot cross the held total (`lib/reservations.ts:5-7,33-49`); expiry is lazy and settlement throws when the payment is short of `reservedTotal` (`lib/settle.ts:161`). Only TAKE creates one (`app/api/checkout/route.ts:296-311`), so "held for 15 min" is true only for a newcomer's take. A rival top-up during a held take is refused (`:253-260,325-332`); a reclaim has no guard — re-classified under the lock it can silently become an ordinary top-up, settled but not crowned.

## 7. Findings

### R04-1 — A reclaim link's amount is never reconciled with the live board

- Severity P2 · Category: money · Confidence 8/10
- Evidence: the deep link sets the field once and toasts "Reclaim Au for $2 — past stake still counts." (`app/page.tsx:116-123`); the modal prints the live delta as `need` but never rewrites the field, guarding only the tie rule (`components/Modals.tsx:154-170,378`); the page quotes $L+1 to all comers, its DB-down shell hardcoding `stake=5` (`page.tsx:68-71,127-130`).
- Reproduction: pay a reclaim, raise the lead, reopen the older link — it pre-fills the older amount beside "👑 $X more reclaims #1": that payment tops up and retakes nothing.
- Proposed fix: set the field to `need` while untouched since the deep link; refuse submit while `priorHere && amount < need`.
- Status: open

### R04-2 — A hidden holder is priced as a newcomer and promised a hold never created

- Severity P3 · Category: correctness · Confidence 8/10
- Evidence: `?me=` and the modal answer from the hidden-filtered list (`app/api/elements/[sym]/route.ts:13,47-52`; `components/Modals.tsx:150-153`), but checkout looks the caller up unfiltered (`app/api/checkout/route.ts:215-218`) and reserves only TAKE (`:296-311`).
- Reproduction: hide a domain that holds stake, open the element with `?me=<it>` — `reclaim` is the full takeover price and the modal promises a hold nothing backs.
- Proposed fix: answer "what do I already hold" unfiltered (e.g. `myPriorTotal` in the payload) and drive `priorHere`/`takeQuoted` from it.
- Status: open · static-only today, no HIDDEN row exists (ledger §7 `:296-302`; U04-2)

### R04-3 — The take-floor validator is dead code

- Severity P3 · Category: testing · Confidence 9/10
- Evidence: `validateTake` (`lib/pricing.ts:53-58`) is referenced only by its own test (§5.7); the floor lives in `reservedTotal` and `lib/settle.ts:161`.
- Proposed fix: call it on the TAKE branch before the reservation is written, or delete it and move its cases onto `classifyAndValidate`.
- Status: open

### R04-4 — A lowercase symbol is a dead end on both surfaces

- Severity P3 · Category: seo · Confidence 9/10
- Evidence: both lookups compare the raw segment with `ELEMENTS[].symbol` (`app/elements/[sym]/page.tsx:16,27`; `app/api/elements/[sym]/route.ts:25`), `?el=` matches exactly (`app/page.tsx:108`), and `/elements/au` → 404 while `/elements/Au` → 200 (§5.5).
- Reproduction: `/elements/au` and `/api/elements/AU` both 404; `https://www.periodictable.lol/elements/au` in a browser shows the not-found page.
- Proposed fix: uppercase the segment before lookup, or 308-redirect to the canonical symbol; make `?el=` agree.
- Status: open

## 8. Acceptance criteria

- [ ] An empty element quotes $5 on all four surfaces — CTA, deep link, `prices.takeLead`, modal `need` (§5.1-5.3)
- [ ] A newcomer below `leader + 1` cannot take #1; a tie is refused, not sold; a holder's price is `max(1, leader + 1 − prior)` wherever printed — mail, modal, ledger §3b `:84` (§6)
- [ ] A stale link cannot be paid as a reclaim when it no longer reclaims (R04-1); no surface promises a hold unless a `Reservation` row exists (R04-2)
- [ ] `ActivityLog` records amount paid and resulting total for every path (§12, U04-1)
- [ ] A `HIDDEN` domain never reaches ranked list, JSON-LD or modal, at any price (§6)
- [ ] `/elements/<symbol>` and `/api/elements/<symbol>` answer alike for `au`, `Au`, `AU` (R04-4)
- [ ] One real $5 payment closes the claimed-state render and receipt — J4, U04-3

## 9. Open questions

1. Is the $1 accumulate floor for a non-leader intended, or should money that moves no crown step higher (`lib/pricing.ts:112-145`; `components/Modals.tsx:391-393`)?
2. Should the outbid mail quote the delta (it does, `lib/email.ts:83`) or the resulting total?
3. May the element page stop quoting a takeover price to visitors who already hold stake (R04-1)?
4. Backfill pre-Phase-3 `ActivityLog` rows or leave them NULL (`prisma/schema.prisma:343`)? Is `/elements/au` → 404 acceptable (R04-4)?

## 10. Cross-references

- Ledger §3b `:82-84`, §4c `:176-178,280`, §7 `:296-302,316`, `:12` — cited, not re-derived.
- Plan §2 `:98-99`, §4 `:183-186`; siblings `03` §5.7 and R03-2 (same hidden-row split), `02` §5.8 (no screenshots), `05`-`08`.
- `doc/project-review/` is history: its identity and audit contracts are cited, not re-reported.

## 11. Change log

- 2026-09-14: first draft from the §5 reads and probes; nothing fixed, no production write, no payment attempted.

## 12. UNKNOWN log

| Id | Unknown | What settles it |
| --- | --- | --- |
| U04-1 | Whether the `ActivityLog` rows carry `deltaUsd`/`resultTotalUsd` or pre-Phase-3 NULLs, and what the feed prints | `psql "$DATABASE_URL"`, SQL in a temp `.sql` piped in (`-c` breaks on PascalCase) |
| U04-2 | Whether any production `Stake` row belongs to a `HIDDEN` startup (decides R04-2's reach) | Same connection: `SELECT count(*) FROM "Stake" s JOIN "Startup" u ON u.id = s."startupId" WHERE u."moderationState" = 'HIDDEN';` |
| U04-3 | Claimed-state render, receipt shape, real $5 charge | J4 — one real card payment, then the element page and the Stripe dashboard; residue per the probe table |
