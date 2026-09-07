/* Launch seed (Phase 5, spec 01-seed-instrument.md): 8–12 friendly startups
 * across marquee elements + contested C ladder ($50/$24/$9) + 72h activity backlog.
 * Idempotent: upserts startups/stakes by (element,startup), backfills activity.
 * Usage: DATABASE_URL=... tsx prisma/launch-seed.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const H = 3600_000;
const NOW = Date.now();

type SeedStake = {
  domain: string;
  title: string;
  pitch: string;
  symbol: string;
  amount: number;
  clicks: number;
  city: string;
  ts: number;
  email?: string;
};

const STAKES: SeedStake[] = [
  { domain: "aurum.fi", title: "Aurum", pitch: "Gold-grade treasury for onchain teams.", symbol: "Au", amount: 88, clicks: 412, city: "Singapore", ts: NOW - 3 * H },
  { domain: "acme.dev", title: "Acme", pitch: "Instant infra for ambitious startups.", symbol: "C", amount: 50, clicks: 267, city: "Berlin", ts: NOW - 1 * H },
  { domain: "beta.acme.dev", title: "Acme Beta", pitch: "Second seat on carbon — climbing.", symbol: "C", amount: 24, clicks: 55, city: "Berlin", ts: NOW - 2 * H },
  { domain: "gamma.tools", title: "Gamma", pitch: "Third seat, watching the crown.", symbol: "C", amount: 9, clicks: 12, city: "Oslo", ts: NOW - 20 * H },
  { domain: "waferly.io", title: "Waferly", pitch: "Chip-grade CI that never flakes.", symbol: "Si", amount: 34, clicks: 98, city: "Prague", ts: NOW - 5 * H },
  { domain: "aurum.fi", title: "Aurum", pitch: "Gold-grade treasury for onchain teams.", symbol: "Pt", amount: 42, clicks: 84, city: "Singapore", ts: NOW - 7 * H },
  { domain: "darkpool.gg", title: "Darkpool", pitch: "Stealth infra for funds that move quietly.", symbol: "DM", amount: 66, clicks: 190, city: "Zurich", ts: NOW - 30 * H },
  { domain: "hydro.dev", title: "Hydro", pitch: "The lightest edge runtime.", symbol: "H", amount: 12, clicks: 41, city: "Austin", ts: NOW - 8 * H },
  { domain: "hydro.dev", title: "Hydro", pitch: "The lightest edge runtime.", symbol: "He", amount: 10, clicks: 28, city: "Austin", ts: NOW - 18 * H },
  { domain: "ferrous.cloud", title: "Ferrous", pitch: "Ironclad Postgres hosting.", symbol: "Fe", amount: 21, clicks: 73, city: "Toronto", ts: NOW - 26 * H },
  { domain: "hydro.dev", title: "Hydro", pitch: "The lightest edge runtime.", symbol: "O", amount: 15, clicks: 46, city: "Austin", ts: NOW - 11 * H },
  { domain: "darkpool.gg", title: "Darkpool", pitch: "Stealth infra for funds that move quietly.", symbol: "U", amount: 39, clicks: 76, city: "Zurich", ts: NOW - 50 * H },
];

async function recompute(elementId: number) {
  const stakes = await prisma.stake.findMany({ where: { elementId }, orderBy: { amountUsd: "desc" } });
  let pool = 0;
  let leader: string | null = null;
  for (let i = 0; i < stakes.length; i++) {
    pool += stakes[i].amountUsd;
    await prisma.stake.update({ where: { id: stakes[i].id }, data: { rank: i + 1, isLeader: i === 0 } });
    if (i === 0) leader = stakes[i].startupId;
  }
  await prisma.element.update({ where: { id: elementId }, data: { totalPoolUsd: pool, stakeCount: stakes.length, currentLeaderId: leader } });
}

async function main() {
  for (const s of STAKES) {
    const element = await prisma.element.findUnique({ where: { symbol: s.symbol } });
    if (!element) {
      console.warn(`launch-seed: unknown symbol ${s.symbol}, skipping`);
      continue;
    }
    const startup = await prisma.startup.upsert({
      where: { domain: s.domain },
      create: {
        domain: s.domain,
        title: s.title,
        pitch: s.pitch,
        url: `https://${s.domain}`,
        logoUrl: `https://www.google.com/s2/favicons?domain=${s.domain}&sz=64`,
        ...(s.email ? { email: s.email } : {}),
      },
      update: { title: s.title, pitch: s.pitch },
    });
    const existing = await prisma.stake.findUnique({
      where: { elementId_startupId: { elementId: element.id, startupId: startup.id } },
    });
    if (!existing) {
      await prisma.stake.create({
        data: { elementId: element.id, startupId: startup.id, amountUsd: s.amount, clicksDelivered: s.clicks },
      });
      await prisma.activityLog.create({
        data: { domain: s.domain, elementSymbol: s.symbol, amountUsd: s.amount, kind: "stake", city: s.city, createdAt: new Date(s.ts) },
      });
    }
  }
  const ids = await prisma.stake.findMany({ distinct: ["elementId"], select: { elementId: true } });
  for (const { elementId } of ids) await recompute(elementId);
  const [elements, startups, stakes] = await Promise.all([
    prisma.element.count(),
    prisma.startup.count(),
    prisma.stake.count(),
  ]);
  console.log(`launch-seed ok: ${elements} elements, ${startups} startups, ${stakes} stakes`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
