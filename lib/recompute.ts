import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { rankStakes, assertLedgerInvariants, type DethroneInfo } from "./pricing";
import { withTxnRetry } from "./txn";

export type RecomputeResult = {
  element: { symbol: string; totalPoolUsd: number; stakeCount: number };
  stake: { id: string; domain: string; amountUsd: number; rank: number; isLeader: boolean };
  info: DethroneInfo;
};

export type StakeKind = "stake" | "reclaim" | "join";

/**
 * Invariant: after any stake change for an element, re-rank every stake,
 * update the Element aggregate, and log activity — in ONE transaction.
 * Dethrone detection feeds Phase-3 emails.
 *
 * Phase 2: accepts an outer transaction client so settlement can commit the
 * payment transition, reservation consumption, stake, aggregates, and outbox
 * rows atomically. Without `tx`, wraps itself as before.
 *
 * Phase 3: takes a transaction-scoped advisory lock on the element FIRST, so
 * concurrent applications for the same element serialize even when called
 * standalone. Re-entrant (same lock twice in one tx is a no-op).
 */
export async function applyStakeTx(
  params: {
    elementId: number;
    startupId: string;
    addUsd: number;
    kind: StakeKind;
    city?: string | null;
    paymentId?: string | null;
  },
  tx?: Prisma.TransactionClient
): Promise<RecomputeResult> {
  if (tx) return applyStakeInTx(tx, params);
  // Standalone callers (seeds, tests) get the same Serializable + bounded-retry
  // guarantees as settle/checkout — never default isolation without retry.
  return withTxnRetry(() =>
    prisma.$transaction((t) => applyStakeInTx(t, params), { isolationLevel: "Serializable" })
  );
}

type RankedStake = {
  id: string;
  startupId: string;
  amountUsd: number;
  createdAt: Date;
  startup: { domain: string };
  rank: number;
  isLeader: boolean;
};

/**
 * Re-rank every stake on the element, persist rank/isLeader, recompute the
 * aggregate, assert invariants, and write the Element row — the post-mutation
 * half of every stake change. Shared by apply and reverse so the two money
 * paths cannot drift apart (Phase 3 items 4 and 9).
 *
 * An empty element (every stake reversed away) is legal here: currentLeaderId
 * goes null, which is exactly what assertLedgerInvariants requires for no rows.
 */
async function rerankElementTx(
  tx: Prisma.TransactionClient,
  elementId: number
): Promise<{
  elementSymbol: string;
  totalPoolUsd: number;
  ranked: RankedStake[];
  newLeader: RankedStake | null;
}> {
  const element = await tx.element.findUniqueOrThrow({
    where: { id: elementId },
    select: { id: true, symbol: true },
  });

  // Deterministic secondary order from rankStakes — createdAt, then id.
  const all = await tx.stake.findMany({
    where: { elementId },
    select: { id: true, startupId: true, amountUsd: true, createdAt: true, startup: { select: { domain: true } } },
  });
  const ranked = rankStakes(all);
  for (const r of ranked) {
    await tx.stake.update({
      where: { id: r.id },
      data: { rank: r.rank, isLeader: r.isLeader },
    });
  }

  const newLeader = ranked.find((r) => r.isLeader) ?? null;
  const totalPoolUsd = ranked.reduce((sum, s) => sum + s.amountUsd, 0);

  // Invariants BEFORE commit (Phase 3 item 9): exactly one leader, gap-free
  // ranks, pool/count/leader agreement. Throws abort the tx.
  assertLedgerInvariants(ranked, {
    totalPoolUsd,
    stakeCount: ranked.length,
    currentLeaderId: newLeader?.startupId ?? null,
  });

  await tx.element.update({
    where: { id: elementId },
    data: {
      currentLeaderId: newLeader?.startupId ?? null,
      totalPoolUsd,
      stakeCount: ranked.length,
    },
  });

  return { elementSymbol: element.symbol, totalPoolUsd, ranked, newLeader };
}

/**
 * Reverse a settled payment's contribution to the ledger (refund/chargeback).
 *
 * The stake row is DECREASED, never deleted: ClickEvent.stakeId is required, so
 * deleting a stake with served clicks is impossible without discarding click
 * history, and the row also anchors FirstClaim. amountUsd is clamped at 0 by
 * refusing to go negative — a removal larger than the stake means the ledger
 * disagrees with the payments, so it throws a ledger-invariant error for
 * operator review rather than absorbing the difference silently.
 *
 * Clicks already delivered are deliberately not clawed back — they happened.
 *
 * A missing stake row is a ledger invariant, not a no-op: the only caller is
 * the PAID reversal path, and settle applies the stake in the same committed
 * transaction that marks the payment PAID. Throwing routes it to operator
 * review instead of recording a reversal that unwound nothing.
 */
export async function reverseStakeTx(
  params: { elementId: number; startupId: string; removeUsd: number; paymentId?: string | null },
  tx: Prisma.TransactionClient
): Promise<{ stakeId: string; remainingUsd: number; elementSymbol: string }> {
  const { elementId, startupId, removeUsd, paymentId } = params;
  // Serialize per element (Phase 3 item 1) — same lock as apply/settle/take.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${elementId})`;

  const stake = await tx.stake.findUnique({
    where: { elementId_startupId: { elementId, startupId } },
    include: { startup: { select: { domain: true } } },
  });

  if (!stake) throw new Error(`ledger-invariant:reverse-no-stake:${elementId}:${startupId}`);
  if (stake.amountUsd < removeUsd) {
    throw new Error(`ledger-invariant:reverse-below-zero:${stake.amountUsd}<${removeUsd}`);
  }

  const remainingUsd = stake.amountUsd - removeUsd;
  await tx.stake.update({
    where: { id: stake.id },
    data: { amountUsd: remainingUsd },
  });

  const { elementSymbol } = await rerankElementTx(tx, elementId);

  await tx.activityLog.create({
    data: {
      domain: stake.startup.domain,
      elementSymbol,
      amountUsd: remainingUsd,
      deltaUsd: -removeUsd,
      resultTotalUsd: remainingUsd,
      kind: "refund",
      paymentId: paymentId ?? null,
    },
  });

  return { stakeId: stake.id, remainingUsd, elementSymbol };
}

async function applyStakeInTx(
  tx: Prisma.TransactionClient,
  params: {
    elementId: number;
    startupId: string;
    addUsd: number;
    kind: StakeKind;
    city?: string | null;
    paymentId?: string | null;
  }
): Promise<RecomputeResult> {
  const { elementId, startupId, addUsd, kind, city, paymentId } = params;
  // Serialize per element (Phase 3 item 1). Held already by settle/checkout
  // take paths — re-entrant, no deadlock.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${elementId})`;
    const element = await tx.element.findUniqueOrThrow({
      where: { id: elementId },
      select: { id: true, currentLeaderId: true },
    });

    // Previous leader snapshot (for dethrone detection)
    const prevLeaderStake = element.currentLeaderId
      ? await tx.stake.findUnique({
          where: { elementId_startupId: { elementId, startupId: element.currentLeaderId } },
          include: { startup: { select: { domain: true } } },
        })
      : null;

    // Upsert stake (cumulative)
    const stake = await tx.stake.upsert({
      where: { elementId_startupId: { elementId, startupId } },
      create: { elementId, startupId, amountUsd: addUsd },
      update: { amountUsd: { increment: addUsd } },
      include: { startup: { select: { domain: true } } },
    });

    // Re-rank, recompute aggregates, assert invariants, persist the element.
    const { elementSymbol, ranked, totalPoolUsd, newLeader } = await rerankElementTx(tx, elementId);
    // Unreachable: the upsert above guarantees at least one row.
    if (!newLeader) throw new Error("ledger-invariant:apply-without-leader");

    // Activity carries the truth (Phase 3 item 8 / P2-06): payment delta,
    // resulting total, and payment id — not just a cumulative number.
    const myRank = ranked.find((r) => r.id === stake.id)?.rank ?? stake.rank;
    await tx.activityLog.create({
      data: {
        domain: stake.startup.domain,
        elementSymbol,
        amountUsd: stake.amountUsd,
        deltaUsd: addUsd,
        resultTotalUsd: stake.amountUsd,
        kind,
        city: city ?? null,
        paymentId: paymentId ?? null,
      },
    });

    const oldLeader =
      prevLeaderStake && prevLeaderStake.startupId !== newLeader.startupId
        ? { domain: prevLeaderStake.startup.domain, amountUsd: prevLeaderStake.amountUsd }
        : null;

    // FirstClaim (Phase 1): the first stake ever on an element records the
    // immutable early-adopter fact. upsert(update:{}) keeps the earliest
    // winner under the element lock above.
    await tx.firstClaim.upsert({
      where: { elementId },
      create: {
        elementId,
        startupId,
        stakeId: stake.id,
        claimedAt: stake.createdAt,
        source: "ledger",
        confidence: "HIGH",
      },
      update: {},
    });

    return {
      element: { symbol: elementSymbol, totalPoolUsd, stakeCount: ranked.length },
      stake: {
        id: stake.id,
        domain: stake.startup.domain,
        amountUsd: stake.amountUsd,
        rank: myRank, // persisted row, not a stale pre-rerank read (P2-01)
        isLeader: newLeader.startupId === startupId,
      },
      info: {
        dethroned: !!oldLeader,
        oldLeader,
        newLeader: {
          domain: newLeader.startup.domain,
          amountUsd: newLeader.amountUsd,
          rank: 1,
        },
      },
    };
}
