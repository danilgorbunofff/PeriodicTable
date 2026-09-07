# 02 — Pricing Engine & Rank Recompute

**Parent:** Phase 2 README · **Covers:** ROADMAP §3 (all), §10 pricing

## Objective
Single server-side truth for every dollar number shown in drawer, checkout, and email.

## `lib/pricing.ts`
```ts
export const MIN_STAKE = 5;
export const takeLeadPrice = (leaderTotal?: number) => leaderTotal == null ? 5 : leaderTotal + 1;
export const joinMin = () => 5;
export const reclaimFor = (leaderTotal: number | undefined, userTotal: number | undefined) =>
  leaderTotal == null ? 5 : Math.max(1, leaderTotal + 1 - (userTotal ?? 0));
export const validateTopUp = (amount: number, leaderTotal?: number, isNew: boolean) => {
  if (!Number.isInteger(amount) || amount < 1) return 'Whole dollars only, min $1 top-up.';
  if (isNew && amount < 5 && (leaderTotal == null || amount < leaderTotal + 1)) return 'First join is $5+ (or take #1 at $X).';
  return null;
};
```

## Recompute transaction (the invariant)
After every paid top-up, in ONE Prisma `$transaction`: upsert Stake (add amount), `orderBy amountUsd desc` all stakes for element, set `rank/isLeader`, update `Element{currentLeaderId,totalPoolUsd,stakeCount}`, insert `ActivityLog{kind: stake|reclaim|join}`. Detect dethrone (leader changed) → return `{ dethroned, newLeader, oldLeader }` for Phase-3 email.

## Tests (`pricing.test.ts` + `recompute.test.ts`)
- [ ] Canonical: A $20 → B $21 → reclaim quote $2 → A pays → A #1 $22
- [ ] Tie rejected: stake == #1 fails validation with `Add $1 more`
- [ ] Self top-up while #1 keeps crown, moat grows
- [ ] New joiner $5 on contested tile lands #N, face unchanged
- [ ] Concurrent top-ups (Promise.all x2) → exactly one leader, pool = sum

## Acceptance
- [ ] All tests green; no price computed client-side (grep `+ 1` in components → only display)
