# 03 — Read APIs & Frontend Wiring

**Parent:** Phase 2 README · **Covers:** ROADMAP §10 (GETs), §7.2–7.4 live

## Endpoints
- [ ] `GET /api/elements` → 122 tiles `{ symbol,name,gridRow,gridCol,family,tier,pool,count,leader{domain,logoUrl,amount} }`, `Cache-Control: s-maxage=10`
- [ ] `GET /api/elements/:sym` → detail + `stakes[]` ranked (logo,domain,pitch,amount,clicks) + `prices{takeLead,joinMin}` (+ `reclaimFor` when `?me=startupId`)
- [ ] `GET /api/stats` → `{ elementsLive:122, totalBids, onSale }` (Upstash cache 30s in Phase 3; in-memory now)
- [ ] `GET /api/activity?limit=6` → `{ domain,elementSymbol,elementName,amount,kind,city,createdAt }` desc
- [ ] `GET /api/board?tab=crowns|by-element|early` → rows `{ domain,logoUrl,elementSym,elementName,total }`
- [ ] `GET /api/search?q=` → ≤8 `{ type:startup|element, domain?, symbol?, name? }`

## Frontend wiring
- [ ] Replace mocks with SWR: grid `useSWR('/api/elements')`, drawer `useSWR('/api/elements/'+sym)`, stats/activity/board same, `refreshInterval: 30000`, optimistic CTA price display while revalidating
- [ ] Loading skeletons: tile pulse, drawer shimmer rows, activity shimmer (no blank cards)
- [ ] Error states: `Couldn't load C — retry` inline, never full-page crash

## Acceptance
- [ ] Cold load → grid paints from API <800ms after TTF on staging
- [ ] Stake via seed script → drawer/stats/activity update within 30s poll, no refresh
- [ ] Search `car` returns Carbon + attached startups first

## Files
- `app/api/**/route.ts`, `lib/api.ts`, `hooks/useElement.ts`, rewired components
