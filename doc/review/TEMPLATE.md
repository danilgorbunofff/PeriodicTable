# Phase NN — <title>

<!--
Copy this file to doc/review/NN-<slug>.md and fill it in. Keep every heading, in this
order. A section with nothing to say keeps its heading and says "None found" or
"Not applicable — <reason>": an empty section must be a statement, not an omission.
Rules for what goes in each section are in doc/review/00-REVIEW-PLAN.md sections 3 and 4.
-->

| | |
| --- | --- |
| Phase | NN |
| Batch | 1 / 2 / 3 / 4 / 5 |
| Status | not started / in progress / draft / reviewed / closed |
| Date reviewed | YYYY-MM-DD |
| Commit reviewed | `<sha>` |
| Reviewer | |

## 1. Scope

**Owns.** The matrix cells quoted from `doc/review/00-REVIEW-PLAN.md` §1 — name the stage, the layer, or the cross-cutting role.

**Does not own.** Adjacent areas that belong to another phase doc, by number, so nothing is silently dropped twice.

**Paths inspected.** Every file actually opened, with `file:line` where a claim depends on it.

## 2. Actors

The ten-actor checklist from §1. `n/a` requires a reason.

| Actor | Applies | What this phase must check for them |
| --- | --- | --- |
| Anonymous visitor | | |
| Paying customer | | |
| Defending holder | | |
| Losing bidder | | |
| Operator | | |
| Attacker | | |
| Crawler / unfurl bot | | |
| Email recipient | | |
| Payment provider | | |
| Future maintainer | | |

## 3. Intended behaviour

What the code means to do, claim by claim, each with `file:line`. If a claim is aspirational (a comment or doc says one thing and the code does another), say so here rather than in the findings.

## 4. The path, walked

The real sequence, step by step: what the user or system does, what request goes out, what comes back, what changes in state. Written so someone who has never opened this repo can follow it. Note the exact point where a state change becomes irreversible.

1.
2.
3.

## 5. Live evidence

Dated, reproducible output. Every claim in §6 and §7 must trace to a line here or to a `file:line` in §3. Secrets are never printed — reference them by name and state what their presence was proven by.

```
<command>
<output>
```

## 6. Failure and edge matrix

| Trigger | Current behaviour | What the user sees | What the operator sees | Acceptable? |
| --- | --- | --- | --- | --- |
| | | | | |

## 7. Findings

One block per finding. The same text is mirrored into `doc/review/FINDINGS.md`.

### R<NN>-1 — <one-line summary>

- **Severity.** P0 / P1 / P2 / P3 (definitions in §4 of the plan)
- **Category.** money / correctness / security / privacy / legal / ux / a11y / perf / ops / content / seo / data / testing
- **Evidence.** `file:line`, or a dated probe from §5
- **Reproduction.** the shortest sequence that shows it
- **Proposed fix.** what to change, and the test that would prove it
- **Status.** open / fixed / wontfix / accepted-risk

## 8. Acceptance criteria

Observable conditions under which this phase is done. Each written so it can be tested rather than read.

- [ ]

## 9. Open questions

Decisions only the operator can make, each phrased as a question with options and a recommendation.

## 10. Cross-references

Ledger sections, other phase docs, tests, and prior review artifacts (`doc/project-review/`) that this doc must not contradict — and where a past fix is what makes a current behaviour correct, say so explicitly so it is never re-reported as new.

## 11. Change log

| Date | Commit | Change |
| --- | --- | --- |
| | | |
