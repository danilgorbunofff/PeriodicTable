# Handoff Checklist — periodictable.lol prod launch

> Last updated: 2026-09-10. Work continues on another PC: `git clone`,
> copy `.env` values from a safe place (never commit `.env`), `npm ci`.

## Where things stand

- [x] App deployed on Vercel (`periodic-table` project, auto-deploys from `main`)
- [x] Neon Postgres connected, migrated (122 elements live)
- [x] Custom domain live: `periodictable.lol` → 308 → `www.periodictable.lol` → app
- [x] All 6 read APIs return 200 on the custom domain
- [x] Payments safely paused (checkout returns `403 waitlist:true`)
- [x] `NEXT_PUBLIC_APP_URL=https://www.periodictable.lol` (type Config, redeployed)
- [x] Resend domain `periodictable.lol` verified (DNS via GoDaddy)
- [x] Stats card copy fixed (`{n} unclaimed`, no `from $5`)
- [x] `.env.example` kill-switch line fixed

## NOW — unblock the email live test

- [ ] Resend → API Keys → confirm `periodictable-prod` key exists (Sending access)
  - Note: a key shared in chat on 2026-09-09 proved INVALID (`API key is invalid`).
    Do NOT reuse it — create a fresh one.
- [ ] Vercel → Environment Variables → `RESEND_API_KEY` = fresh `re_…` key → Save
- [ ] Vercel → confirm `EMAIL_FROM` = `periodictable.lol <hi@periodictable.lol>`
- [ ] Deployments → ⋯ → Redeploy
- [ ] Live test: local simulator checkout with a real recipient email →
      `POST /api/dev/pay` → `POST /api/jobs/outbox` → expect `EmailLog.status=sent`
      and a real receipt in the inbox
- [ ] Rotate the key after any chat exposure (delete + recreate + update Vercel + redeploy)

## NEXT — remaining prod connections

- [ ] Turnstile bot keys (`TURNSTILE_SECRET` + `NEXT_PUBLIC_TURNSTILE_SITEKEY`)
      from Cloudflare dashboard. Without them, bot checks silently pass.
- [ ] Upstash Redis (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`).
      Without it, rate limits are per-instance memory (bypassable on serverless).
- [ ] Vercel Cron for `/api/jobs/outbox` + `/api/jobs/screenshot`
      (repo has no `vercel.json` — nothing drains receipts/previews on a schedule).
      Auth with `CRON_SECRET` bearer. Until then, send/preview emails pile up unsent.
- [ ] Plausible analytics (`NEXT_PUBLIC_PLAUSIBLE_DOMAIN`) — optional, skip if unwanted.
- [ ] Whop live keys (`WHOP_API_KEY` + `WHOP_WEBHOOK_SECRET`) + webhook URL
      `https://www.periodictable.lol/api/webhooks/whop` registered in Whop dashboard.
- [ ] `PAYMENTS_LIVE=true` + `NEXT_PUBLIC_PAYMENTS_LIVE=true` — LAST step only,
      after all gates below. Redeploy required (public var bakes at build).

## NEXT — code fixes required before real money

1. [ ] Prove Whop contract in test mode (endpoint shape, signature header,
       payment-id location, paid-event types). Current values are guesses
       (`lib/whop.ts`). Save signed fixtures as tests.
2. [ ] Server-side charge verification before granting stakes
       (webhook amount currently trusted; `null` skips validation).
3. [ ] Idempotent provider session creation (orphan sessions → `reference-mismatch`).
4. [ ] Refunds / disputes / `PENDING` expiry + reconciliation cron
       (`REFUNDED` enum value is never written today).
5. [ ] Prod magic-link email actually sends (`lib/manage.ts` only `console.error`s;
       owners get success but no link in production).
6. [ ] Failure states: grid/stats must show error panels, not fake
       all-`Unclaimed $5` / zero data (`app/page.tsx` vs `TerritoryView.tsx` pattern).
7. [ ] Activity feed leaks HIDDEN listings; early-adopter board can show wrong tile;
       stats sums hidden money while boards filter `VISIBLE`.
8. [ ] Wire `requireProdEnv()` at runtime (currently zero call sites) and add
       `ADMIN_TOKEN` to `REQUIRED_PROD_ENV` (`lib/env.ts`).
9. [ ] Fix CI live rehearsal env (`VERCEL_ENV=preview`, not prod `npm run start` —
       simulator can never run on a production build by design).
10. [ ] A11y/mobile sweep (44px targets, combobox semantics, toast-while-modal,
        mobile camera) + real browser/axe E2E (today: static string tests only).

## Reference

- Live site: https://www.periodictable.lol
- Vercel project: `periodic-table` (Build Command must include `prisma migrate deploy`)
- Env vars set (values in Vercel, never in repo): `DATABASE_URL`, `WHOP_API_KEY`,
  `WHOP_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL`, `RESEND_API_KEY`, `EMAIL_FROM`,
  `CLICK_SALT`, `TURNSTILE_SECRET`, `NEXT_PUBLIC_TURNSTILE_SITEKEY`, `CRON_SECRET`,
  `NEXT_PUBLIC_PAYMENTS_LIVE`, `ADMIN_TOKEN`, `UPSTASH_*`
- Money smoke test (local, needs local Postgres + seeds):
  `BASE_URL=http://localhost:3100 ADMIN_TOKEN=… WHOP_WEBHOOK_SECRET=… bash scripts/rehearse-release.sh live`
- Paused smoke test: `BASE_URL=… bash scripts/rehearse-release.sh paused`
- Full local gate: `npm ci` → `prisma migrate deploy` (local DB) → `npm run lint` →
  `npm run typecheck` → `TEST_DATABASE_URL=… npm run test:ci` (must be 0 skipped) →
  `npm run audit:prod` → prod-env gate fail-without / pass-with secrets
- Registrar: GoDaddy. `A @ → 216.198.79.1` (Vercel-assigned), `CNAME www → periodictable.lol.`
  Mail rows (`MX`, `email`, `secureserver DKIM`) belong to GoDaddy mail — do not touch.
- Resend + GoDaddy mail coexist (different DKIM/SPF hostnames, no conflict).
