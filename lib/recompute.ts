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
      select: { id: true, symbol: true, currentLeaderId: true },
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

    // Re-rank every stake on the element (Phase 3 item 4: deterministic
    // secondary order from rankStakes — createdAt, then id).
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

    const newLeader = ranked[0];
    const totalPoolUsd = ranked.reduce((sum, s) => sum + s.amountUsd, 0);

    // Invariants BEFORE commit (Phase 3 item 9): exactly one leader, gap-free
    // ranks, pool/count/leader agreement. Throws abort the tx.
    assertLedgerInvariants(ranked, {
      totalPoolUsd,
      stakeCount: ranked.length,
      currentLeaderId: newLeader.startupId,
    });

    await tx.element.update({
      where: { id: elementId },
      data: {
        currentLeaderId: newLeader.startupId,
        totalPoolUsd,
        stakeCount: ranked.length,
      },
    });

    // Activity carries the truth (Phase 3 item 8 / P2-06): payment delta,
    // resulting total, and payment id — not just a cumulative number.
    const myRank = ranked.find((r) => r.id === stake.id)?.rank ?? stake.rank;
    await tx.activityLog.create({
      data: {
        domain: stake.startup.domain,
        elementSymbol: element.symbol,
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
      element: { symbol: element.symbol, totalPoolUsd, stakeCount: ranked.length },
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
