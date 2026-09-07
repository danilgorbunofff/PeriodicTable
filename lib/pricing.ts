/* Pricing engine — single server-side truth for every dollar number
   (doc/phase-2-ledger/02-pricing-ranks.md, ROADMAP §3). */

export const MIN_STAKE = 5;

export const takeLeadPrice = (leaderTotal?: number) =>
  leaderTotal == null ? MIN_STAKE : leaderTotal + 1;

export const joinMin = () => MIN_STAKE;

export const reclaimFor = (
  leaderTotal: number | undefined,
  userTotal: number | undefined
) => (leaderTotal == null ? MIN_STAKE : Math.max(1, leaderTotal + 1 - (userTotal ?? 0)));

export const validateTopUp = (
  amount: number,
  leaderTotal: number | undefined,
  isNew: boolean
): string | null => {
  if (!Number.isInteger(amount) || amount < 1) return "Whole dollars only, min $1 top-up.";
  if (isNew) {
    if (amount < MIN_STAKE && (leaderTotal == null || amount < leaderTotal + 1)) {
      return `First join is $${MIN_STAKE}+ (or take #1 at $${takeLeadPrice(leaderTotal)}).`;
    }
    if (leaderTotal != null && amount <= leaderTotal) {
      // ties are rejected — must clear the current #1
      return `Add $${leaderTotal + 1 - amount} more to take #1.`;
    }
  }
  return null;
};

export type DethroneInfo = {
  dethroned: boolean;
  oldLeader?: { domain: string; amountUsd: number } | null;
  newLeader: { domain: string; amountUsd: number; rank: number };
};

/** Pure rank math over an element's stakes (used by recompute + tests). */
export function rankStakes<T extends { amountUsd: number }>(stakes: T[]): (T & { rank: number; isLeader: boolean })[] {
  const sorted = [...stakes].sort((a, b) => b.amountUsd - a.amountUsd);
  return sorted.map((s, i) => ({ ...s, rank: i + 1, isLeader: i === 0 }));
}
