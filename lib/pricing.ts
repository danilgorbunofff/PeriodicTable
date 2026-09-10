/* Pricing engine — single server-side truth for every dollar number
   (doc/phase-2-ledger/02-pricing-ranks.md, ROADMAP §3 + Phase 3 remediation).
   Validators are split by intent (first join / join / top-up / take) so each
   rule is testable in isolation. Ties are ALWAYS rejected at validation time;
   settlement order is deterministic so a race can never flip ranks. */

export const MIN_STAKE = 5;

export const takeLeadPrice = (leaderTotal?: number) =>
  leaderTotal == null ? MIN_STAKE : leaderTotal + 1;

export const joinMin = () => MIN_STAKE;

export const reclaimFor = (
  leaderTotal: number | undefined,
  userTotal: number | undefined
) => (leaderTotal == null ? MIN_STAKE : Math.max(1, leaderTotal + 1 - (userTotal ?? 0)));

/** First-ever stake on an empty tile: $5 floor. */
export const validateFirstJoin = (amount: number): string | null => {
  if (!Number.isInteger(amount) || amount < 1) return "Whole dollars only, min $1 top-up.";
  if (amount < MIN_STAKE) return `First stake is $${MIN_STAKE}+.`;
  return null;
};

/** Newcomer joining a contested tile (P0-04): any $5+ amount below the take
 * price lands on the ladder — but never tied with another startup (P1-02). */
export const validateJoin = (amount: number, existingTotals: number[]): string | null => {
  const floor = validateFirstJoin(amount);
  if (floor) return floor;
  if (existingTotals.includes(amount)) {
    return ` $${amount} is taken — add $1 more to stand clear of the tie.`.trim();
  }
  return null;
};

/** Existing staker topping up: the RESULTING total must not tie another
 * startup (P1-02). Amount itself is the delta (integer $1+). */
export const validateTopUpAmount = (
  priorTotal: number,
  amount: number,
  otherTotals: number[]
): string | null => {
  if (!Number.isInteger(amount) || amount < 1) return "Whole dollars only, min $1 top-up.";
  if (otherTotals.includes(priorTotal + amount)) {
    return `$${priorTotal + amount} would tie another staker — add $1 more to stand clear.`;
  }
  return null;
};

/** Guaranteed take: the amount must reach the reserved winning total
 * (Phase 2 reservation). Checked again at settlement. */
export const validateTake = (amount: number, reservedTotal: number): string | null => {
  if (!Number.isInteger(amount) || amount < 1) return "Whole dollars only, min $1 top-up.";
  if (amount < reservedTotal) {
    return `Add $${reservedTotal - amount} more to take #1 at the held quote of $${reservedTotal}.`;
  }
  return null;
};

/**
 * Legacy preview validator (client-side hint only — Modals). Preserved for
 * backward compatibility; server truth is classifyAndValidate.
 */
export const validateTopUp = (
  amount: number,
  leaderTotal: number | undefined,
  isNew: boolean
): string | null => {
  if (!Number.isInteger(amount) || amount < 1) return "Whole dollars only, min $1 top-up.";
  if (isNew) {
    if (leaderTotal == null) return validateFirstJoin(amount);
    if (amount < MIN_STAKE) return `First join is $${MIN_STAKE}+ (or take #1 at $${takeLeadPrice(leaderTotal)}).`;
    if (amount <= leaderTotal) return null; // join lands below #1 (tie checked server-side)
    return null;
  }
  return null;
};

export type StakePath = "TAKE" | "JOIN" | "STAKE" | "RECLAIM";

export type Classification =
  | { ok: true; path: StakePath }
  | { ok: false; error: string; code: "PRICE_MOVED" | "BELOW_FLOOR" | "TIE" };

/**
 * Single classify+validate source for checkout pre-check AND the locked
 * in-tx revalidation (Phase 3 item 1). Inputs are a point-in-time leaderboard
 * snapshot; the tx re-runs this on fresh reads.
 *
 * - Empty tile + newcomer → JOIN (first join, $5+)
 * - Contested + newcomer + amount >= leader+1 → TAKE (reservation)
 * - Contested + newcomer + amount < leader+1 → JOIN ($5+, no ties)
 * - Existing holder + resulting total retakes the lead → RECLAIM
 * - Otherwise → STAKE (top-up / moat, no ties)
 */
export function classifyAndValidate(params: {
  amount: number;
  leaderTotal: number | undefined;
  isNewHere: boolean;
  myPriorTotal: number;
  existingTotals: number[];
}): Classification {
  const { amount, leaderTotal, isNewHere, myPriorTotal, existingTotals } = params;
  if (!Number.isInteger(amount) || amount < 1) {
    return { ok: false, error: "Whole dollars only, min $1 top-up.", code: "PRICE_MOVED" };
  }
  if (isNewHere && leaderTotal == null) {
    const err = validateFirstJoin(amount);
    return err ? { ok: false, error: err, code: "BELOW_FLOOR" } : { ok: true, path: "JOIN" };
  }
  if (isNewHere && leaderTotal != null) {
    if (amount >= leaderTotal + 1) return { ok: true, path: "TAKE" };
    const err = validateJoin(amount, existingTotals);
    return err
      ? { ok: false, error: err, code: err.includes("tie") || err.includes("taken") ? "TIE" : "BELOW_FLOOR" }
      : { ok: true, path: "JOIN" };
  }
  // Existing holder. (Own prior needs no exclusion: newTotal = prior + amount
  // with amount >= $1 can never equal prior.)
  const err = validateTopUpAmount(myPriorTotal, amount, existingTotals);
  if (err) return { ok: false, error: err, code: "TIE" };
  if (leaderTotal != null && myPriorTotal <= leaderTotal && myPriorTotal + amount > leaderTotal) {
    return { ok: true, path: "RECLAIM" };
  }
  return { ok: true, path: "STAKE" };
}

export type DethroneInfo = {
  dethroned: boolean;
  oldLeader?: { domain: string; amountUsd: number } | null;
  newLeader: { domain: string; amountUsd: number; rank: number };
};

/**
 * Pure rank math over an element's stakes (used by recompute + tests).
 * Deterministic secondary order (Phase 3 item 4): amount desc, then earliest
 * created, then id. Ties cannot occur post-validation, but the order is total
 * regardless so recomputation can never flip ranks unpredictably.
 */
export function rankStakes<T extends { amountUsd: number; createdAt?: Date | string | number; id?: string }>(
  stakes: T[]
): (T & { rank: number; isLeader: boolean })[] {
  const timeOf = (s: T) =>
    s.createdAt == null ? 0 : s.createdAt instanceof Date ? s.createdAt.getTime() : new Date(s.createdAt).getTime();
  const sorted = [...stakes].sort((a, b) => {
    if (b.amountUsd !== a.amountUsd) return b.amountUsd - a.amountUsd;
    if (timeOf(a) !== timeOf(b)) return timeOf(a) - timeOf(b);
    return (a.id ?? "").localeCompare(b.id ?? "");
  });
  return sorted.map((s, i) => ({
    ...s,
    rank: i + 1,
    // A fully reversed stake (amount 0) keeps its row — click history and
    // first-claims hang off it — but it is not a bid, so it can never hold the
    // rank-1 crown. Otherwise a charged-back bidder keeps the tile face for
    // free, which is the very inventory the reversal was supposed to give up.
    isLeader: i === 0 && s.amountUsd > 0,
  }));
}

/**
 * Ledger invariants asserted before commit (Phase 3 item 9). Throws on any
 * violation — the transaction aborts instead of persisting corrupt state.
 */
export function assertLedgerInvariants(
  ranked: { id: string; startupId: string; amountUsd: number; rank: number; isLeader: boolean }[],
  aggregate: { totalPoolUsd: number; stakeCount: number; currentLeaderId: string | null }
): void {
  const fail = (msg: string): never => {
    throw new Error(`ledger-invariant: ${msg}`);
  };
  for (let i = 0; i < ranked.length; i++) {
    if (ranked[i].rank !== i + 1) fail(`rank gap at index ${i}`);
  }
  const leaders = ranked.filter((r) => r.isLeader);
  const liveBids = ranked.filter((r) => r.amountUsd > 0);
  if (liveBids.length === 0) {
    // No live bid: every stake on the element was reversed away. The rows
    // remain (click history / first-claims reference them), so there is simply
    // no leader to point at.
    if (leaders.length !== 0) fail(`leader without a live bid (${leaders.length})`);
    if (aggregate.currentLeaderId !== null) fail("leader on unbid element");
  } else {
    if (leaders.length !== 1) fail(`expected 1 leader, saw ${leaders.length}`);
    if (!ranked[0].isLeader) fail("rank 1 is not the leader");
    if (aggregate.currentLeaderId !== leaders[0].startupId) fail("currentLeaderId mismatch");
  }
  const pool = ranked.reduce((sum, s) => sum + s.amountUsd, 0);
  if (aggregate.totalPoolUsd !== pool) fail(`pool ${aggregate.totalPoolUsd} != sum ${pool}`);
  if (aggregate.stakeCount !== ranked.length) fail(`count ${aggregate.stakeCount} != rows ${ranked.length}`);
}
