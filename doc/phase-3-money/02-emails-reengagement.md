# 02 — Transactional Emails & Re-engagement

**Parent:** Phase 3 README · **Covers:** ROADMAP §3.4, §7.6

## Objective
Every dethrone prints money via a 60-second exact-price email. Plus receipts. No newsletter, no drip — two templates only.

## Templates (Resend + react-email, `emails/`)
- **outbid.tsx** — Subject `You were knocked off C (Carbon) 👑`; Body: `B (b.com) just took #1 with $21. Reclaim it for $2.00 → [Reclaim now]` (deep link `/elements/C?reclaim=startupId`); footer `Past stake still counts · it's an ad buy, not a bet · unsubscribe`
- **receipt.tsx** — Subject `You're #1 in C (Carbon) 🎉`; Body: amount, element, rank, `🟢 clicks` explainer, manage link

## Pipeline
- [ ] Recompute tx returns `{ dethroned }` → enqueue email job (Upstash QStash or in-route `fetch` Resend in MVP) within 60s
- [ ] Reclaim CTA deep link prefills checkout with `reclaimFor` amount
- [ ] Unsubscribe per startup (`unsubToken`); suppressed list checked before send
- [ ] Log sends in `EmailLog{to,template,elementSym,amount}` for debugging (or Resend webhooks in V2)

## Copy lock (do not reword without PM)
- Subject/body above; CTA `Reclaim now`; reassurance `your past stake still counts, so nothing's wasted`

## Acceptance
- [ ] Staging takeover → victim inbox <60s with correct `$X.00` (assert in E2E via Mailhog/Resend test mode)
- [ ] Unsubscribed victim → no send, logged `suppressed`
- [ ] Receipt shows integer dollars, no cents drift

## Files
- `emails/outbid.tsx`, `emails/receipt.tsx`, `lib/email.ts`, `app/api/emails/preview/route.ts` (dev only)
