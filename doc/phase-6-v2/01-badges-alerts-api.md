# 01 — Badges, Alerts & Public API

**Parent:** Phase 6 README

## Items
- [ ] **🏅 Early Adopter badges:** first 100 stakes get permanent badge in drawer + board tab already stubbed. *Trigger: 100 stakes in first week.*
- [ ] **👀 Watch alerts:** follow element → email on any new stake (not just dethrone). Digest mode. *Trigger: reclaim email CTR >15%.*
- [ ] **🧪 Public API:** `GET /public/elements`, `/board`, `/activity` (key-gated, 60/min) + docs page. *Trigger: 3+ inbound asks.*
- [ ] **↔️ Social link type parity:** `@ handle` checkout already stubbed; add profile avatar + platform icons. *Trigger: >20% checkouts choose Social.*
- [ ] **📊 Founder dashboard:** `/you/:domain` — stakes, ranks, clicks, reclaim buttons. *Trigger: repeat stakers >10.*

## Notes
- Board `Early Adopter` tab UI ships in Phase 1 mock; real badge logic is THIS file, not earlier.
- Alerts reuse Resend infra from Phase 3; add `Watch{startupId,elementId}` table then.
