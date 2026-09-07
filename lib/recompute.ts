import { prisma } from "./prisma";
import { rankStakes, type DethroneInfo } from "./pricing";

export type RecomputeResult = {
  element: { symbol: string; totalPoolUsd: number; stakeCount: number };
  stake: { domain: string; amountUsd: number; rank: number; isLeader: boolean };
  info: DethroneInfo;
};

/**
 * Invariant: after any stake change for an element, re-rank every stake,
 * update the Element aggregate, and log activity — in ONE transaction.
 * Dethrone detection feeds Phase-3 emails.
 */
export async function applyStakeTx(params: {
  elementId: number;
  startupId: string;
  addUsd: number;
  kind: "stake" | "reclaim" | "join";
  city?: string | null;
}): Promise<RecomputeResult> {
  const { elementId, startupId, addUsd, kind, city } = params;

  return prisma.$transaction(async (tx) => {
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

    // Re-rank every stake on the element
    const all = await tx.stake.findMany({
      where: { elementId },
      select: { id: true, startupId: true, amountUsd: true, startup: { select: { domain: true } } },
    });
    const ranked = rankStakes(all);
    for (const r of ranked) {
      if (r.rank !== 99 || r.isLeader) {
        await tx.stake.update({
          where: { id: r.id },
          data: { rank: r.rank, isLeader: r.isLeader },
        });
      }
    }

    const newLeader = ranked[0];
    const totalPoolUsd = ranked.reduce((sum, s) => sum + s.amountUsd, 0);

    await tx.element.update({
      where: { id: elementId },
      data: {
        currentLeaderId: newLeader.startupId,
        totalPoolUsd,
        stakeCount: ranked.length,
      },
    });

    await tx.activityLog.create({
      data: {
        domain: stake.startup.domain,
        elementSymbol: element.symbol,
        amountUsd: stake.amountUsd,
        kind,
        city: city ?? null,
      },
    });

    const oldLeader =
      prevLeaderStake && prevLeaderStake.startupId !== newLeader.startupId
        ? { domain: prevLeaderStake.startup.domain, amountUsd: prevLeaderStake.amountUsd }
        : null;

    return {
      element: { symbol: element.symbol, totalPoolUsd, stakeCount: ranked.length },
      stake: {
        domain: stake.startup.domain,
        amountUsd: stake.amountUsd,
        rank: newLeader.rank === stake.rank ? 1 : stake.rank,
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
  });
}
