# 03 — Abuse, Legal & Performance

**Parent:** Phase 4 README · **Covers:** ROADMAP §13, §6 responsive

## Abuse
- [ ] Cloudflare Turnstile on checkout submit (server verify); honeypot field
- [ ] Rate limits (Upstash): `/api/checkout` 5/IP/hr, `/go` 30/IP/hr, `/api/search` 60/IP/min
- [ ] Domain blocklist + `report` button per rank row (→ `Report{stakeId,reason}` + email to ops); DMCA/takedown playbook in `doc/phase-5-launch/`
- [ ] Startup self-attest checkbox `I own or may promote this URL` (ownership verify in V2)

## Legal (visible copy, do not drop)
- Checkout: `🔒 Secure payment via Whop · it's an ad buy, not a bet · by continuing you agree to the rules & terms.`
- HowItWorks footer: `Periodic data: IUPAC Standard. Classifications are illustrative, not a chemical statement.`
- Footer bar: `About & disclaimer · Rules & payments · Contact` → `/legal/{about,rules,contact}` stub pages
- `?` No refunds/withdrawals — stake = ad inventory. Stated pre-charge.

## Perf & a11y
- [ ] Grid memo (`React.memo(Tile)`), SWR dedupe 30s, images lazy + `sizes`, font display swap
- [ ] No CLS: drawer/modal use transform only; reserve 380px via overlay (never reflow grid)
- [ ] Keyboard: Tab reaches every tile, Enter opens, Esc closes stack (search→preview→drawer→modal→toast), focus returns, `aria-label="{Symbol} {Name}, {claimed|unclaimed}"`
- [ ] Targets: Lighthouse mobile Perf ≥90, a11y 100, axe `npm run a11y` clean; Playwright keyboard suite green

## Files
- `lib/abuse.ts`, `lib/rateLimit.ts`, `app/legal/*`, `tests/a11y/*`, `tests/perf.md`
