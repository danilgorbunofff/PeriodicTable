/* Seed: idempotent upsert of 122 elements (lib/elements.ts), 6 demo startups
   + 27 stakes (mocks/startups.ts MOCK_STAKES), then recompute ranks/pools
   and write ActivityLog rows. Safe to run repeatedly (append-only: existing
   stakes are never mutated, only ranked; re-runs converge).
   Ranking reuses the shared rankStakes + assertLedgerInvariants path
   (lib/pricing.ts) so seeded state can never drift from production invariants.
   Historical createdAt/ts are preserved intentionally — applyStakeTx would
   stamp now(), which would rewrite history. */
import { PrismaClient, ChemicalFamily, PrestigeTier } from "@prisma/client";
import { ELEMENTS } from "../lib/elements";
import { MOCK_STAKES } from "../mocks/startups";
import { rankStakes, assertLedgerInvariants } from "../lib/pricing";

const prisma = new PrismaClient();

async function recomputeElement(elementId: number) {
  const stakes = await prisma.stake.findMany({ where: { elementId } });
  const ranked = rankStakes(stakes);
  const pool = ranked.reduce((sum, s) => sum + s.amountUsd, 0);
  const leaderId = ranked.length > 0 ? ranked[0].startupId : null;
  assertLedgerInvariants(
    ranked.map((r) => ({ id: r.id, startupId: r.startupId, amountUsd: r.amountUsd, rank: r.rank, isLeader: r.isLeader })),
    { totalPoolUsd: pool, stakeCount: ranked.length, currentLeaderId: leaderId }
  );
  for (const r of ranked) {
    await prisma.stake.update({ where: { id: r.id }, data: { rank: r.rank, isLeader: r.isLeader } });
  }
  await prisma.element.update({
    where: { id: elementId },
    data: { totalPoolUsd: pool, stakeCount: ranked.length, currentLeaderId: leaderId },
  });
}

async function main() {
  // 1) Elements (122 tiles)
  for (const e of ELEMENTS) {
    await prisma.element.upsert({
      where: { id: e.id },
      create: {
        id: e.id,
        symbol: e.symbol,
        name: e.name,
        atomicMass: e.atomicMass,
        gridRow: e.gridRow,
        gridCol: e.gridCol,
        family: e.family as ChemicalFamily,
        tier: e.tier as PrestigeTier,
      },
      update: {
        symbol: e.symbol,
        name: e.name,
        atomicMass: e.atomicMass,
        gridRow: e.gridRow,
        gridCol: e.gridCol,
        family: e.family as ChemicalFamily,
        tier: e.tier as PrestigeTier,
      },
    });
  }

  // 2) Startups + stakes (only if the element has no stakes yet — keeps demo
  //    data but never duplicates on re-run)
  for (const m of MOCK_STAKES) {
    const element = await prisma.element.findUnique({ where: { symbol: m.symbol } });
    if (!element) {
      console.warn(`seed: unknown symbol ${m.symbol}, skipping`);
      continue;
    }
    const startup = await prisma.startup.upsert({
      where: { domain: m.domain },
      create: {
        domain: m.domain,
        title: m.title,
        pitch: m.pitch,
        url: `https://${m.domain}`,
        logoUrl: m.logo,
        claimedAt: new Date(m.ts),
      },
      update: {
        title: m.title,
        pitch: m.pitch,
        logoUrl: m.logo,
      },
    });
    const existing = await prisma.stake.findUnique({
      where: { elementId_startupId: { elementId: element.id, startupId: startup.id } },
    });
    if (!existing) {
      await prisma.stake.create({
        data: {
          elementId: element.id,
          startupId: startup.id,
          amountUsd: m.amount,
          clicksDelivered: m.clicks,
        },
      });
      await prisma.activityLog.create({
        data: {
          domain: m.domain,
          elementSymbol: m.symbol,
          amountUsd: m.amount,
          kind: m.firstClaim ? "join" : "stake",
          city: m.city ?? null,
          createdAt: new Date(m.ts),
        },
      });
    }
  }

  // 3) Recompute ranks + pools for every element that has stakes
  const withStakes = await prisma.stake.findMany({
    where: {},
    distinct: ["elementId"],
    select: { elementId: true },
  });
  for (const { elementId } of withStakes) {
    await recomputeElement(elementId);
  }

  // 4) FirstClaim records for seeded elements (earliest stake wins; source seed)
  for (const { elementId } of withStakes) {
    const first = await prisma.stake.findFirst({
      where: { elementId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (first) {
      await prisma.firstClaim.upsert({
        where: { elementId },
        create: {
          elementId,
          startupId: first.startupId,
          stakeId: first.id,
          claimedAt: first.createdAt,
          source: "seed",
          confidence: "MEDIUM",
        },
        update: {},
      });
    }
  }

  const [elements, startups, stakes, logs] = await Promise.all([
    prisma.element.count(),
    prisma.startup.count(),
    prisma.stake.count(),
    prisma.activityLog.count(),
  ]);
  console.log(`seed ok: ${elements} elements, ${startups} startups, ${stakes} stakes, ${logs} activity rows`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
