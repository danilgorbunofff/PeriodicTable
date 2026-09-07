# 01 — Checkout Flow (Whop)

**Parent:** Phase 3 README · **Covers:** ROADMAP §3.1–3.3, §7.5 checkout, §10 POSTs

## UX (drawer → modal → provider → back)
1. Rail CTA: **only** `[ Claim a spot — for $51 ]` (take-lead price). Amount is editable in checkout (user may type $5 to join the ladder). No secondary link on the rail.
2. Modal `Stake on Carbon 🚩`: reminder line, tabs `🌐 Product URL | @ Social`, URL input (https normalize, blocklist check), `$ stake` input (min = chosen path), live `👑 $51 takes #1 in Carbon!` or `Joins ladder at #4`, `[ Continue to checkout → ]`, `🔒 Secure payment via Whop · it's an ad buy, not a bet…`, `maybe later`
3. `POST /api/checkout { elementSym, startup{domain,title(≤32),pitch(≤140),url,linkType}, amountUsd, path: take|join, idempotencyKey(uuid) }` → validate (pricing.ts + URL + lengths + Turnstile) → create `Payment{pending}` → Whop session → `{ checkoutUrl }` → redirect
4. `POST /api/webhooks/whop` (verify signature): `paid` → idempotent apply (lookup `providerRef`/`idempotencyKey` first) → recompute tx → success redirect `?paid=C` → toast + confetti-lite + drawer refresh

## Validation matrix
| Path | Amount rule | Server check |
|------|-------------|--------------|
| First claim (empty tile) | `== 5+` any | `amount>=5` |
| Take #1 | `>= leader+1` | reject `<= leader` with `Add $N more` |
| Join ladder | `>= 5` | lands #N, no crown change |
| Reclaim (known startup) | `>= reclaimFor` | quote TTL 5min, recompute pre-charge |

## Acceptance
- [ ] Expired quote (leader changed mid-checkout) → modal shows `Price moved to $X — continue?` instead of charging stale
- [ ] Webhook double-fire test → pool increments once
- [ ] Failed payment → `Payment.failed`, no rank change, error toast with retry

## Files
- `components/CheckoutForm.tsx`, `app/api/checkout/route.ts`, `app/api/webhooks/whop/route.ts`, `lib/whop.ts`, `lib/validate.ts`
