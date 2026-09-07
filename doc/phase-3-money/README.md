# Phase 3 — Money (Day 10–13)
### Checkout → webhook → ledger → emails → click proofs

**Goal:** real dollars move. $5 first claim, $51 takeover, $2 reclaim all work end-to-end on staging with Whop webhooks, idempotent ledger applies, and exact-price outbid emails.

**Why now:** ledger is true (Phase 2); chrome converts (Phase 1). This phase connects them with money.

**Inputs:** ROADMAP §3.3–3.4, §7.5 checkout, §9 Payment/ClickEvent, §10 POSTs.

**Outputs:**
- `POST /api/checkout` + Whop session + `POST /api/webhooks/whop` idempotent apply
- Dual CTA (take #1 vs join $5) + live 👑 line + validation
- Resend `outbid` + `receipt` emails with exact reclaim price
- `GET /go/:stakeId` click redirect + counting + `🟢 clicks` in drawer

**Done =**
- [ ] Staging: fresh domain claims white tile $5 → appears #1; rival $6 takes it; victim email quotes exact reclaim; victim reclaims
- [ ] Double webhook delivery → single top-up (idempotency test green)
- [ ] Price shown at open revalidated pre-charge (≤5min quote TTL)

**Sub-phases:**
1. `01-checkout-flow.md` — form, validation, session, webhook apply
2. `02-emails-reengagement.md` — outbid + receipt templates, queue, unsubscribe
3. `03-clicks-attribution.md` — redirect, counting, anti-fraud, display

**Non-goals:** screenshot previews (Phase 4), animated sheens, referral cuts.
