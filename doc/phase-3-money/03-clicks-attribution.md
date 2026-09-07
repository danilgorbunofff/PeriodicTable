# 03 — Click Attribution (`/go` + Verified Counter)

**Parent:** Phase 3 README · **Covers:** ROADMAP §3.3 clicks, §7.4 clicks display

## Objective
Prove ad value publicly: every tile/drawer click-out is a counted, rate-limited redirect. Counter `🟢 N clicks delivered` is the trust badge.

## Flow
- [ ] Tile face (if #1) + drawer #1 card + hover preview link → `href="/go/:stakeId"` (target blank, rel sponsored nofollow)
- [ ] `GET /go/:stakeId`: lookup stake → rate-limit (Upstash: 1/IP/stake/10s, 30/IP/hr) → hash IP (`sha256(ip+salt)`, never store raw) → insert `ClickEvent{stakeId,ipHash,ua}` → `Stake.clicksDelivered++` → `302` to `startup.url`
- [ ] Drawer shows `🟢 {clicksDelivered} clicks delivered` emerald 12px; board shows clicks on hover in V2 only

## Anti-fraud (MVP minimum)
- Bot UA blocklist, self-click discount (owner domain referrer still counts — keep simple, note it), no double-count inside window
- Public counter = verified redirects only; never increment client-side

## Acceptance
- [ ] 10 rapid clicks same IP → +1; 2 IPs → +2 (test with curl)
- [ ] Dead URL → still counts then 302 (count intent, not success); stake deleted → 404 page with report link
- [ ] Counter updates in drawer within 30s poll

## Files
- `app/go/[stakeId]/route.ts`, `lib/clicks.ts`, `lib/rateLimit.ts`
