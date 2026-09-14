# Findings register

Every finding from every phase doc, in one place. The phase doc is the work; this is the index over it. A finding's text is written in its phase doc first and mirrored here — never only here.

**IDs.** `R<phase>-<n>`, two-digit phase, e.g. `R04-3`. Ids are append-only: a fixed or rejected finding keeps its id forever, because the ledger and the commit history reference them.

**Severity.** P0 blocks announce (money can be lost, created or misrepresented; data can leak; legal exposure; a silent undetectable failure). P1 must fix before announce. P2 first week. P3 backlog. Full definitions in `00-REVIEW-PLAN.md` §4.

**Category.** `money` · `correctness` · `security` · `privacy` · `legal` · `ux` · `a11y` · `perf` · `ops` · `content` · `seo` · `data` · `testing`

**Status.** `open` · `fixed` · `wontfix` · `accepted-risk` — the last two require a reason in the phase doc's open-questions section.

**Rules.** No row without evidence: a `file:line` or a dated probe recorded in the phase doc's live-evidence section, and a reproduction someone else can run. Where no evidence is yet possible the row is `UNKNOWN` in the evidence column together with the exact command or dashboard step that would settle it. Secrets are never recorded here.

## P0

| ID | Phase | Category | Summary | Evidence | Status | Fixed in |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

## P1

| ID | Phase | Category | Summary | Evidence | Status | Fixed in |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

## P2

| ID | Phase | Category | Summary | Evidence | Status | Fixed in |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

## P3

| ID | Phase | Category | Summary | Evidence | Status | Fixed in |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

## UNKNOWN — evidence not yet obtainable

| ID | Phase | Category | What is unknown | Command or dashboard step that settles it |
| --- | --- | --- | --- | --- |
| | | | | |

## Summary

| Doc | Phase | Status | P0 | P1 | P2 | P3 | Last reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 00 | Review plan | draft | — | — | — | — | 2026-09-14 |
| 01 | Discovery and unfurl | not started | — | — | — | — | — |
| 02 | Shell and static surfaces | not started | — | — | — | — | — |
| 03 | The board | not started | — | — | — | — | — |
| 04 | Element detail and pricing | not started | — | — | — | — | — |
| 05 | Accessibility and content | not started | — | — | — | — | — |
| 06 | Checkout before payment | not started | — | — | — | — | — |
| 07 | Payment provider integration | not started | — | — | — | — | — |
| 08 | Settlement and ledger integrity | not started | — | — | — | — | — |
| 09 | Ownership and competition | not started | — | — | — | — | — |
| 10 | Email and notifications | not started | — | — | — | — | — |
| 11 | API contracts | not started | — | — | — | — | — |
| 12 | Data layer | not started | — | — | — | — | — |
| 13 | Jobs and cron | not started | — | — | — | — | — |
| 14 | Security | not started | — | — | — | — | — |
| 15 | Performance, concurrency, cost, resilience | not started | — | — | — | — | — |
| 16 | Legal, privacy, tax | not started | — | — | — | — | — |
| 17 | Operator tooling and runbooks | not started | — | — | — | — | — |
| 18 | Observability, analytics, alerts | not started | — | — | — | — | — |
| 19 | Launch and marketing readiness | not started | — | — | — | — | — |
| 20 | Post-launch and debt | not started | — | — | — | — | — |
