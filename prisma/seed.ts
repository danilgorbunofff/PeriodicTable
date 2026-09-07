/* Seed: idempotent upsert of 122 elements (lib/elements.ts), 6 demo startups
   + 27 stakes (mocks/startups.ts MOCK_STAKES), then recompute ranks/pools
   and write ActivityLog rows. Safe to run repeatedly. */
import { PrismaClient, ChemicalFamily, PrestigeTier } from "@prisma/client";
import { ELEMENTS } from "../lib/elements";
import { MOCK_STAKES } from "../mocks/startups";

const prisma = new PrismaClient();

async function recomputeElement(elementId: number) {
  const stakes = await prisma.stake.findMany({
    where: { elementId },
    orderBy: { amountUsd: "desc" },
  });
  let pool = 0;
  let leaderId: string | null = null;
  for (let i = 0; i < stakes.length; i++) {
    pool += stakes[i].amountUsd;
    const isLeader = i === 0;
    await prisma.stake.update({
      where: { id: stakes[i].id },
      data: { rank: i + 1, isLeader },
    });
    if (isLeader) leaderId = stakes[i].startupId;
  }
  await prisma.element.update({
    where: { id: elementId },
    data: { totalPoolUsd: pool, stakeCount: stakes.length, currentLeaderId: leaderId },
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
