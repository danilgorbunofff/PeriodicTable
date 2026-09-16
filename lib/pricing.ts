/* Pricing engine — single server-side truth for every dollar number
   (doc/phase-2-ledger/02-pricing-ranks.md, ROADMAP §3 + Phase 3 remediation).
   Validators are split by intent (first join / join / top-up / take) so each
   rule is testable in isolation. A tie is refused against every total already
   on the board — that check runs *before* commit, so two simultaneous claims
   can still land on the same amount (R09-3); rank order is deterministic, so
   the resulting pair is always ordered the same way. */

export const MIN_STAKE = 5;

export const takeLeadPrice = (leaderTotal?: number) =>
  leaderTotal == null ? MIN_STAKE : leaderTotal + 1;

export const joinMin = () => MIN_STAKE;

/** The smallest whole-dollar bid at or above `floor` that no total on the board
 * already holds. This is the "smallest acceptable amount" a bidder can actually
 * land (R09-6), and the amount a live take quote has to leave room below to
 * keep the tile biddable at all (R09-1). */
export const smallestFreeAmount = (existingTotals: number[], floor: number = MIN_STAKE): number => {
  const taken = new Set(existingTotals);
  let amount = floor;
  while (taken.has(amount)) amount += 1;
  return amount;
};

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
 * price lands on the ladder — but never tied with a total already on the board
 * (P1-02, R09-3). Concurrent claims are not visible here by design. */
export const validateJoin = (amount: number, existingTotals: number[]): string | null => {
  const floor = validateFirstJoin(amount);
  if (floor) return floor;
  if (existingTotals.includes(amount)) {
    return ` $${amount} is already on the board — add $1 to stand clear of the tie.`.trim();
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
    return `$${priorTotal + amount} would tie a bid already on the board — add $1 to stand clear.`;
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
 * - Contested + newcomer + amount < leader+1 → JOIN ($5+, no committed tie)
 * - Existing holder + resulting total retakes the lead → RECLAIM
 * - Otherwise → STAKE (top-up / moat, no committed tie)
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
 * created, then id. A tie is only refused against rows already committed, so an
 * equal pair can exist; the order stays total regardless, so recomputation can
 * never flip ranks unpredictably (R09-3).
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
 * The invariant checks, as data rather than as a throw (R12-2). Kept separate
 * so the pre-commit writer (assertLedgerInvariants, on the write path) and the
 * read-only detector (aggregateDrift, in lib/recompute.ts) ask the SAME
 * questions — a detector with its own copy of the rules answers a different
 * question than the writer enforces, which is how a drift report ends up green
 * while settlement rejects.
 *
 * Order matters: assertLedgerInvariants throws the first entry, so the message
 * a failing write produces is unchanged.
 */
export function ledgerInvariantFailures(
  ranked: { id: string; startupId: string; amountUsd: number; rank: number; isLeader: boolean }[],
  aggregate: { totalPoolUsd: number; stakeCount: number; currentLeaderId: string | null }
): string[] {
  const failures: string[] = [];
  for (let i = 0; i < ranked.length; i++) {
    if (ranked[i].rank !== i + 1) failures.push(`rank gap at index ${i}`);
  }
  const leaders = ranked.filter((r) => r.isLeader);
  const liveBids = ranked.filter((r) => r.amountUsd > 0);
  if (liveBids.length === 0) {
    // No live bid: every stake on the element was reversed away. The rows
    // remain (click history / first-claims reference them), so there is simply
    // no leader to point at.
    if (leaders.length !== 0) failures.push(`leader without a live bid (${leaders.length})`);
    if (aggregate.currentLeaderId !== null) failures.push("leader on unbid element");
  } else {
    if (leaders.length !== 1) failures.push(`expected 1 leader, saw ${leaders.length}`);
    if (!ranked[0].isLeader) failures.push("rank 1 is not the leader");
    if (aggregate.currentLeaderId !== leaders[0].startupId) failures.push("currentLeaderId mismatch");
  }
  const pool = ranked.reduce((sum, s) => sum + s.amountUsd, 0);
  if (aggregate.totalPoolUsd !== pool) failures.push(`pool ${aggregate.totalPoolUsd} != sum ${pool}`);
  if (aggregate.stakeCount !== ranked.length) failures.push(`count ${aggregate.stakeCount} != rows ${ranked.length}`);
  return failures;
}

/**
 * Ledger invariants asserted before commit (Phase 3 item 9). Throws on any
 * violation — the transaction aborts instead of persisting corrupt state.
 */
export function assertLedgerInvariants(
  ranked: { id: string; startupId: string; amountUsd: number; rank: number; isLeader: boolean }[],
  aggregate: { totalPoolUsd: number; stakeCount: number; currentLeaderId: string | null }
): void {
  const failures = ledgerInvariantFailures(ranked, aggregate);
  if (failures.length > 0) throw new Error(`ledger-invariant: ${failures[0]}`);
}
