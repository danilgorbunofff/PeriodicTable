/* Launch seed (Phase 5, spec 01-seed-instrument.md): 8–12 recognizable real
 * startups across marquee elements + contested C ladder ($50/$24/$9) + 72h
 * activity backlog. Real domains are deliberate: tile logos come from Google's
 * favicon service (s2/favicons?domain=…), so real domains → real logos.
 * Pass --fresh to first wipe all existing demo rows (FK-safe order) + reset
 * element aggregates; a bare run stays idempotent append-only: upserts
 * startups/stakes by (element,startup), never mutates existing stakes, re-runs
 * converge. Ranking reuses shared rankStakes + assertLedgerInvariants
 * (lib/pricing.ts); historical ts preserved by design.
 * Usage: DATABASE_URL=... tsx prisma/launch-seed.ts [--fresh]
 */
import { PrismaClient } from "@prisma/client";
import { rankStakes, assertLedgerInvariants } from "../lib/pricing";

const prisma = new PrismaClient();
const FRESH = process.argv.includes("--fresh");
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
  { domain: "stripe.com", title: "Stripe", pitch: "Payments infrastructure for the internet.", symbol: "C", amount: 50, clicks: 267, city: "San Francisco", ts: NOW - 1 * H },
  { domain: "coinbase.com", title: "Coinbase", pitch: "The easiest place to buy and sell crypto.", symbol: "Au", amount: 88, clicks: 412, city: "San Francisco", ts: NOW - 3 * H },
  { domain: "adyen.com", title: "Adyen", pitch: "The financial technology platform of choice.", symbol: "C", amount: 24, clicks: 55, city: "Amsterdam", ts: NOW - 2 * H },
  { domain: "squareup.com", title: "Square", pitch: "Financial services for local commerce.", symbol: "C", amount: 9, clicks: 12, city: "San Francisco", ts: NOW - 20 * H },
  { domain: "nvidia.com", title: "NVIDIA", pitch: "Accelerated computing for the AI era.", symbol: "Si", amount: 34, clicks: 98, city: "Santa Clara", ts: NOW - 5 * H },
  { domain: "coinbase.com", title: "Coinbase", pitch: "The easiest place to buy and sell crypto.", symbol: "Pt", amount: 42, clicks: 84, city: "San Francisco", ts: NOW - 7 * H },
  { domain: "anthropic.com", title: "Anthropic", pitch: "AI safety and research.", symbol: "DM", amount: 66, clicks: 190, city: "San Francisco", ts: NOW - 30 * H },
  { domain: "cloudflare.com", title: "Cloudflare", pitch: "The connectivity cloud for a faster internet.", symbol: "H", amount: 12, clicks: 41, city: "San Francisco", ts: NOW - 8 * H },
  { domain: "cloudflare.com", title: "Cloudflare", pitch: "The connectivity cloud for a faster internet.", symbol: "He", amount: 10, clicks: 28, city: "San Francisco", ts: NOW - 18 * H },
  { domain: "supabase.com", title: "Supabase", pitch: "Open source Postgres at the edge.", symbol: "Fe", amount: 21, clicks: 73, city: "Remote-first", ts: NOW - 26 * H },
  { domain: "cloudflare.com", title: "Cloudflare", pitch: "The connectivity cloud for a faster internet.", symbol: "O", amount: 15, clicks: 46, city: "San Francisco", ts: NOW - 11 * H },
  { domain: "huggingface.co", title: "Hugging Face", pitch: "The AI community building the future.", symbol: "U", amount: 39, clicks: 76, city: "New York", ts: NOW - 50 * H },
];

async function recompute(elementId: number) {
  const stakes = await prisma.stake.findMany({ where: { elementId } });
  const ranked = rankStakes(stakes);
  const pool = ranked.reduce((sum, s) => sum + s.amountUsd, 0);
  const leader = ranked.length > 0 ? ranked[0].startupId : null;
  assertLedgerInvariants(
    ranked.map((r) => ({ id: r.id, startupId: r.startupId, amountUsd: r.amountUsd, rank: r.rank, isLeader: r.isLeader })),
    { totalPoolUsd: pool, stakeCount: ranked.length, currentLeaderId: leader }
  );
  for (const r of ranked) {
    await prisma.stake.update({ where: { id: r.id }, data: { rank: r.rank, isLeader: r.isLeader } });
  }
  await prisma.element.update({ where: { id: elementId }, data: { totalPoolUsd: pool, stakeCount: ranked.length, currentLeaderId: leader } });
}

async function main() {
  if (FRESH) {
    // Demo-data reset, FK-safe order (deepest dependents first). Never used in
    // production flows — only when explicitly passed --fresh.
    for (const table of [
      prisma.providerEvent,
      prisma.claimReservation,
      prisma.manageToken,
      prisma.manageSession,
      prisma.firstClaim,
      prisma.report,
      prisma.clickEvent,
      prisma.auditLog,
      prisma.activityLog,
      prisma.payment,
      prisma.stake,
      prisma.startup,
    ]) {
      await (table as { deleteMany: () => Promise<unknown> }).deleteMany();
    }
    await prisma.element.updateMany({
      data: { totalPoolUsd: 0, stakeCount: 0, currentLeaderId: null },
    });
    console.log("launch-seed --fresh: wiped demo rows + reset element aggregates");
  }
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
  for (const { elementId } of ids) {
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
