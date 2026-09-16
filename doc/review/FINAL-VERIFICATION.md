# Final verification — PR `26` audit

| Field | Value |
| --- | --- |
| Purpose | Close-out record for the final-verification audit: go/no-go verdict, per-wave evidence, remaining limitations. |
| Verdict | **GO** — conditional on the accepted limitations in §3 (none of which block launch; all are outside what a code + contract audit can reach). |
| Date | 2026-09-16 |
| Audit branch | `danilgorbunofff-final-verification-audit` (verification worktree on a separate host from the fix worktree; findings merged via PR `26`) |
| Commit verified | `HEAD` of `main` after the `26` fix pack + doc amendment wave (see §2, wave 5) |
| Sources | PR `26` body and its fix-pack commit; the six auditor report docs `01`–`20`; `FINDINGS.md`; the session verifiers (`verify-anchors`, `check-register`, `anchor_audit.py`); `ops/accepted-advisories.json` |

## 1. Verdict

**GO.** Every finding raised by the six auditor docs that was accepted for fixing has landed (R-fix passes across docs 02–14), the two P0 build blockers (F-016, F-017) are fixed with regression pins, the known-debt items (F-007, F-008) are triaged with a dated acceptance gate, and the full clean-room suite passes. The remaining "unknowns" are the ones no local audit can retire: a real Stripe charge, a real Resend send, and the browser-level checks U05-1/U05-3. Each is bounded, listed in §3, and already tracked in the per-doc UNKNOWN logs.

## 2. Evidence, per wave

| Wave | Check | Result |
| --- | --- | --- |
| Build | `npm run build` (production mode, this audit) | **GREEN** — 122 prerender paths; no `UnhandledSchemeError` (F-016 fix: startup emit lives in `lib/prisma.ts`, server-only); type-check accepts all route-file exports (F-017 fix: `MAX_BATCH_DOMAINS` moved to `lib/moderation.ts`) |
| Suites | `npm test` on the audit worktree | 860 passed / 0 failed (no-DB mode; DB-dependent tests skip, not fail) |
| Clean room | Full suite re-run in a clean clone of the audit branch | **1024/1024 passed in 27s** (clean-room runner; the delta versus 860 is DB-backed tests that the clean room provisions a local Postgres for) |
| Smoke | Production-mode smoke walk, `NODE_ENV=production` | **21/21 probes green**: home 200; stats/elements/C/activity/search/board 200; element page 200; robots/sitemap 200; og/C + og/home 200 (documented SVG fallback); unknown page 404; jobs/config 401 no-auth / 503 with 6 named findings when authed; jobs/outbox GET 401 no-auth; checkout 403 "Payments are disabled…" |
| Static | `npx tsc --noEmit`, `npx next lint` | clean |
| Anchors | `verify-anchors.mjs` + `anchor_audit.py` over `doc/review/*.md` | Final run (after the full amendment wave): **1897 citations, 0 DEFECTS, 6 UNRESOLVED, 17 drift-later** — the six are the known false-positive class (references to `lib/applyPayment.ts`, which the R04-2 fix deleted; every such cite carries an "at authoring" amendment note); the 17 are dated evidence/fix-record citations of `app/legal/[slug]/page.tsx` (the file shrank 168→83 lines when the fix pass refactored it into `lib/legalDocs.ts`), each an at-the-time citation per the audit tool's own classification. The amendment wave added ~60 "Amended 2026-09-16 (PR `26` audit)" notes and no new defects |
| Register | `check-register.mjs` over `FINDINGS.md` ↔ per-doc registers | consistent; F-018 recorded as valid and folded into F-010 |
| npm audit | F-007 triage | 1 critical + 3 high + 2 moderate, **all dev-chain**; gate `ops/accepted-advisories.json` **expires 2026-12-31** — re-triage before that date |
| Deploy safety | F-008 | `prisma postinstall` is blocked by `allowScripts`, but `npm run build` runs `prisma generate`, so deploys are safe |
| Docs | Amendment wave over `doc/review/*.md` (docs 01–08, 11–14, 16, `FINDINGS`, `00-REVIEW-PLAN`) | every present-tense `file:line` claim that drifted is annotated with today's value; change-log rows added; historical cites untouched |

## 3. Remaining limitations (accepted, not launch-blocking)

1. **Live Stripe send** — no real card charge was attempted; the payment path is verified by contract tests, the simulator gates (404 production → 403 disabled → 429 budget), and webhook signature/failure handling in test. The first real charge (U04-3, J4) remains an operator task.
2. **Live Resend send** — `sendReportEmail` / `sendWaitlistEmail` are covered by intake-mail tests and a bounded in-request drain; no production send was performed ( REPORT_NOTIFY_EMAIL default documented at `README.md:42`, `.env.example:26`).
3. **OG PNG pixel render** — the `og` routes return 200 with the documented SVG fallback; actual PNG rasterization in a real crawler was not verified.
4. **U05-1 / U05-3 browser checks** — keyboard-only traversal focus screenshots (U05-1) and claimed-tile/missing-logo/hidden-listing renders (U05-3) are unit/contract-covered; the browser-level passes remain in doc 05's UNKNOWN log.
5. **Production Neon data** — the audit never wrote to the production database (all DB work on `localhost:55433`); live-data questions (U04-1/U04-2) stay open by design.

## 4. Debt register carried forward

| ID | What | Gate |
| --- | --- | --- |
| F-007 | dev-chain npm audit findings accepted | re-triage before **2026-12-31** (`ops/accepted-advisories.json`) |
| F-008 | `prisma postinstall` blocked by `allowScripts` | safe (build runs `prisma generate`); revisit if the build step is removed |
| R05-5 | red-700 + `ink/70` contrast accepted as risk | documented in doc 05 |
| U0x-* | per-doc UNKNOWNs (§3 items 1–5 and the doc UNKNOWN logs) | operator tasks |
