# Phase 6 — V2 (Post-Launch, Do Not Build Now)
### Ideas parked so MVP ships

**Goal:** capture every tempting extra in one place with trigger metrics, so nobody scope-creeps Phases 0–5.

**Rule:** start a V2 item only when its trigger metric hits AND MVP funnel is stable for 2 weeks.

**Sub-phases:**
1. `01-badges-alerts-api.md` — retention + platform plays
2. `02-monetization-shaders.md` — revenue + wow-factor plays

**Global non-goals for V2 (still no):** timers/expiry, fractional tile ownership, on-chain settlement (revisit at $50k pool).

**Two maintenance items on this page itself (R20-13, review date 2026-12-31):**

1. **Say where each trigger metric is read** (owed when R19-1 closes — the
   client-side half is unreadable while
   `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is unset). The rule above is only checkable
   by someone other than its author if the reading location is written down
   next to the trigger: for the funnel half it is `/api/admin/ops` → `funnel`
   (server-side, `ClickEvent` + `Payment`, authoritative for money), and for the
   per-item triggers it is the saved views on that dashboard once they exist.
   `doc/phase-5-launch/03-launch-week-questions.md` carries the queries that
   read them by hand in the meantime; when one of them is typed the same way
   three times, it should become a saved view or an alarm rather than a
   paragraph here, because an unnamed metric is one nobody re-reads.
2. **Re-read the `$50k` threshold in the non-goals line above.** It was chosen
   before the board had a dollar in it (0 stakes, 0 payments, 2026-09-16). At
   the 2026-12-31 re-read, restate it against actual pool size or say plainly
   that the number was a placeholder — an unrevisited threshold is a decision
   pretending to be a measurement.

Both are re-read dates, not build tasks: the register that raised them
(`doc/review/20-post-launch-and-debt.md` §7 R20-13) is re-read on the same
schedule.
