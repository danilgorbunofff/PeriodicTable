# periodictable.lol

King-of-the-Hill staking ads on a living periodic table — a worldmap.lol twin.
Every element is an open multi-tenant leaderboard ranked by total stake:
plant a flag from $5, take the #1 crown at current-leader + $1, top up to reclaim.

- Product authority: `doc/ROADMAP.md`
- Visual authority: `doc/DESIGN-SYSTEM.md` (wins on any look conflict)
- Audit + hardening plan: `doc/project-review/plan.md` (payments stay **off** until all release gates pass)
- Runbooks: `ops/rollback.md`, `ops/takedown.md`

## Stack

Next.js 14 App Router + Tailwind, Prisma 6 + Postgres, Whop (payments),
Resend (email), Cloudflare Turnstile (bot checks). Hosting: Vercel.

## Local setup

```bash
npm ci
cp .env.example .env   # then fill DATABASE_URL (below)
npx prisma migrate deploy
npx tsx prisma/seed.ts # 122 elements + demo stakes (optional)
npm run dev            # http://localhost:3000
```

Any Postgres 16 works (Neon/Supabase pooled URI for serverless, local
`postgres:16-alpine` via Docker for offline work).

## Environment

| Var | Dev | Production |
|---|---|---|
| `DATABASE_URL` | required | required |
| `WHOP_API_KEY` / `WHOP_WEBHOOK_SECRET` | optional (absent = dev pay simulator) | **required** |
| `NEXT_PUBLIC_APP_URL` | default localhost | **required, https** |
| `TURNSTILE_SECRET` | optional (absent = checks pass locally) | **required** |
| `CLICK_SALT` | default dev salt | **required, private random** |
| `CRON_SECRET` | optional locally | **required** |
| `RESEND_API_KEY` / `EMAIL_FROM` | optional (absent = emails logged, not sent) | **required** |
| `PAYMENTS_LIVE` / `NEXT_PUBLIC_PAYMENTS_LIVE` | default live (simulator) | **fail-closed**: payments run only when explicitly `"true"` **and** Whop keys are set |

Validate production config explicitly (used by CI and the deploy runbook):

```bash
node scripts/check-prod-env.mjs
VERCEL_ENV=production NODE_ENV=production node scripts/check-prod-env.mjs
```

## Database

```bash
npx prisma migrate deploy  # clean deploy / prod (reproducible from repo)
npx prisma migrate dev --name <change>  # local schema iteration
npx prisma validate && npx prisma format --check
```

Baseline: `prisma/migrations/0000_baseline/` (matches `prisma/schema.prisma`
exactly; verified by `migrate deploy` on an empty DB + seed). Later phases add
migrations that must preserve existing stakes, payments, clicks, reports, and
email logs.

## Scripts

| Command | What |
|---|---|
| `npm run dev` / `build` / `start` | run / production-build / serve |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm test` | vitest (unit + DB integration; DB tests **must not skip** in CI) |
| `TEST_DATABASE_URL=… npm test` | run integration tests against a separate local DB |

DB integration tests only run against localhost Postgres (or with
`VITEST_ALLOW_REMOTE_DB=1`) — they skip anywhere else so fixtures can never
touch shared data. CI provides an ephemeral Postgres service.
| `npm run check-prod-env` | fail-closed production config gate |
| `npm run audit:prod` | prod dependency audit vs `ops/accepted-advisories.json` |

## CI (`.github/workflows/ci.yml`)

Install → `prisma validate/format/generate` → `migrate deploy` on ephemeral
Postgres → lint → typecheck → tests (fails if any DB test skips) → prod audit
→ prod-env gate (must fail without secrets, pass with them) → production build
with a database (must emit no Prisma configuration errors).

## Dependency policy

Transitive security pins live in `package.json#overrides` (`postcss`,
`deepmerge-ts`). `npm run audit:prod` fails on any unaccepted high/critical
runtime advisory. `next@14.2.35` (latest 14.x) has one accepted high with a
recorded rationale + expiry in `ops/accepted-advisories.json`; the breaking
major upgrade (Next 16 + React 19) is tracked separately and re-audited before
live payments.

## Payments status: OFF

`lib/flags.ts` + `lib/env.ts` default production payments to **disabled**.
Do not set `PAYMENTS_LIVE=true` in production until every release gate in
`doc/project-review/plan.md` is green. Emergency pause: set
`PAYMENTS_LIVE=false` (+ public mirror) — checkout returns `403 { waitlist: true }`.

## Ownership

**v1: a listing is set at checkout and is final.** Identity is derived
server-side from the validated URL/handle (`findOrCreateCheckoutStartup`),
and checkout never mutates an existing startup profile — a later stake on the
same domain only adds stake. Title, pitch, url, link and email come from the
buyer's checkout form, so what they submit is what ships.

Editing an existing listing is **not shipped in v1**. The magic-link backend
(`lib/manage.ts`, `/api/manage/*` → `PATCH /api/startups/[domain]`) exists and
is tested, but has no UI and production never emails the link, so it is
deliberately dormant and unreachable. Do not advertise it until the management
pages and delivery ship. Every mutation writes an `AuditLog` row.

## Payments (take quotes + settlement)

Contested takeovers hold a 15-minute guaranteed quote (`ClaimReservation`,
one ACTIVE per element). Settlement is atomic: provider-event claim,
reservation consume, stake + aggregates, paid-transition, and outbox enqueues
commit in one transaction (`lib/settle.ts`). Webhooks accept paid signals
only from an explicit allowlist; statusless/unrelated events are ignored and
recorded, never applied. Same-delivery twice applies once (event-id dedupe).

## Ledger rules

`lib/pricing.ts` is the single source: $5 floor everywhere, contested $5+
joins land below #1, ties are rejected at checkout, ranks are deterministic
(amount desc, earliest first). Each stake application takes a per-element
lock, asserts one leader + exact pool/count + gap-free ranks before commit,
and logs the payment delta + resulting total + payment id to the activity
feed. Never catch a unique violation inside a transaction — use upserts or
abort and replay.

## Read APIs (product truth)

`lib/api.ts` holds every wire contract; `fetchJson` throws structured
`ApiError` on non-2xx or shape mismatch so failures render as errors, never
as business state. Rankings are computed server-side (`lib/boards.ts`):
Table Order sums all stakes, By Element ranks leader single-stakes, Crowns
count then spend, Early Adopter counts FirstClaim medals. Stats report exact
units (claimed tiles, stake rows, summed USD). Search startup rows carry
their destination element + profile URL.

## Operations (jobs, abuse, moderation)

- Workers: `POST /api/jobs/outbox` (receipts, outbid, previews, analytics)
  and `POST /api/jobs/screenshot` (preview backfill) drain durable outbox
  rows in bounded, authenticated batches. Every delivery has a dedupe key,
  exponential backoff, persisted `lastError`, and an operator retry at
  `POST /api/admin/outbox/retry`. Job auth: `CRON_SECRET` bearer (required
  in production, always).
- Abuse: rate limits share atomic storage when `UPSTASH_REDIS_REST_URL` +
  `TOKEN` are set (memory fallback otherwise); client IPs come from trusted
  platform headers (`lib/ip.ts`); listing URLs reject credentials, IPs, and
  non-public hosts; security headers + allowlist CSP ship in `next.config.mjs`.
- Moderation: `ops/takedown.md` is executable — report queue, triage states,
  HIDE (all surfaces, stops /go, clears preview) / UNLIST (discovery only) /
  restore, all audited. Operator endpoints need `ADMIN_TOKEN` bearer.
  Financial history is never deleted; aggregates keep counting hidden stakes.
- Email: no addresses in URLs; unsubscribe is POST-first (RFC 8058 headers
  on outgoing mail, confirm form on GET).

## Accessibility

Remediation Phase 5: modals trap focus, inert the background, own Escape,
and restore the exact trigger; checkout is a labeled form with described
errors and polite async announcements; the 122-tile table is one tab stop
with arrow/Home/End navigation and Escape back to search; small text uses
AA-passing `*-ink` tokens (verified by `lib/a11y.test.ts` + axe audit);
touch layouts get 44px targets; reduced motion kills camera/ping/modal
movement; legal links render on every viewport.
