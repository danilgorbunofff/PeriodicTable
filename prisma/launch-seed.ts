/* Launch seed (Phase 5, spec 01-seed-instrument.md): 11 inventory seats — the
 * site's own seat on Pt (Platinum, the element the app icon is built from) and
 * the ten platforms this site is actually built with (Next.js, React,
 * TypeScript, Prisma, Neon, Vercel, Tailwind, Stripe, Resend, Vitest), one seat
 * per element, never two, so no tile carries a price ladder and every captured
 * tile quotes exactly one dollar over its holder (`MIN_STAKE` +
 * TAKEOVER_MARGIN, lib/pricing.ts). The ten sit on standard-tier elements, not
 * on the cultural-elite or exotic tiles (C, Si, Ti, Pt, Au, U, Hbar, Ps, Uue,
 * DM): those stay free for buyers. Real domains are deliberate: a tile draws
 * its holder's icon through `/api/favicon` (this site's own proxy — see
 * faviconFor in lib/screenshots.ts), so a real domain is what makes a real icon
 * render.
 * The seats are NOT customers: lib/launchInventory.ts is the single list, and
 * scripts/clear-launch-inventory.ts is the guarded way back out.
 * Pass --fresh to first wipe all existing rows (FK-safe order) + reset element
 * aggregates; a bare run stays idempotent append-only: upserts startups/stakes
 * by (element,startup), never mutates existing stakes, re-runs converge.
 * Ranking reuses shared rankStakes + assertLedgerInvariants (lib/pricing.ts);
 * historical ts preserved by design.
 *
 * R17-5: this is the one irreversible script in the repo, so `--fresh` is
 * guarded (lib/seedGuard.ts). Against a non-loopback database it refuses
 * unless both `--allow-remote` and `--confirm=<host>` are given, prints the
 * host and the row counts of all twelve tables before deleting anything, and
 * reports the total it wiped. A bare run is the documented production seed
 * step and stays unguarded — it appends.
 * Usage: DATABASE_URL=... tsx prisma/launch-seed.ts [--fresh [--allow-remote --confirm=<host>]]
 */
import { PrismaClient } from "@prisma/client";
import { MIN_STAKE, rankStakes, assertLedgerInvariants } from "../lib/pricing";
import { faviconFor } from "../lib/screenshots";
import { seedGuard } from "../lib/seedGuard";

const prisma = new PrismaClient();
const FRESH = process.argv.includes("--fresh");
const H = 3600_000;
const NOW = Date.now();

type SeedSeat = {
  domain: string;
  title: string;
  pitch: string;
  symbol: string;
  ts: number;
  /** A local asset for a seat whose icon must not depend on the icon service
   *  (the site's own seat draws the app icon); everything else goes through the
   *  proxy, `faviconFor`. */
  logo?: string;
};

/* One seat per element, all at the floor. The amounts are not restated here: a
   seat costs `MIN_STAKE`, and the price of beating it is derived the same way
   the checkout derives it. Pt is the site's own seat (the element the app icon
   draws); the ten below it are the platforms this site runs on, on standard
   elements so the elite and exotic tiles stay free. */
const SEATS: SeedSeat[] = [
  { domain: "periodictable.lol", title: "PeriodicTable.lol", pitch: "Put your startup on the table. Literally.", symbol: "Pt", ts: NOW - 1 * H, logo: "/icon.png" },
  { domain: "vercel.com", title: "Vercel", pitch: "Deploy and host the modern web.", symbol: "H", ts: NOW - 2 * H },
  { domain: "nextjs.org", title: "Next.js", pitch: "The React framework for the web.", symbol: "N", ts: NOW - 3 * H },
  { domain: "react.dev", title: "React", pitch: "The library for web and native user interfaces.", symbol: "Al", ts: NOW - 5 * H },
  { domain: "typescriptlang.org", title: "TypeScript", pitch: "JavaScript with syntax for types.", symbol: "Fe", ts: NOW - 7 * H },
  { domain: "prisma.io", title: "Prisma", pitch: "Type-safe database access for Node.js and TypeScript.", symbol: "Zr", ts: NOW - 9 * H },
  { domain: "neon.tech", title: "Neon", pitch: "Serverless Postgres with branching.", symbol: "Xe", ts: NOW - 11 * H },
  { domain: "tailwindcss.com", title: "Tailwind CSS", pitch: "Utility-first CSS for rapid UI development.", symbol: "W", ts: NOW - 13 * H },
  { domain: "stripe.com", title: "Stripe", pitch: "Payments infrastructure for the internet.", symbol: "Pb", ts: NOW - 17 * H },
  { domain: "resend.com", title: "Resend", pitch: "Email API for developers.", symbol: "Rn", ts: NOW - 21 * H },
  { domain: "vitest.dev", title: "Vitest", pitch: "Next-generation testing framework.", symbol: "Og", ts: NOW - 25 * H },
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

/** Deepest dependents first (FK-safe), with the names the operator is shown
 *  before `--fresh` deletes anything (R17-5). Name and model travel together
 *  so a table cannot be wiped without appearing in the printout. */
type WipeTarget = {
  name: string;
  count: () => Promise<number>;
  deleteMany: () => Promise<unknown>;
};

function wipeTargets(): WipeTarget[] {
  const t = (name: string, model: { count: () => Promise<number>; deleteMany: () => Promise<unknown> }): WipeTarget => ({
    name,
    count: () => model.count(),
    deleteMany: () => model.deleteMany(),
  });
  return [
    t("ProviderEvent", prisma.providerEvent),
    t("ManageToken", prisma.manageToken),
    t("ManageSession", prisma.manageSession),
    t("FirstClaim", prisma.firstClaim),
    t("Report", prisma.report),
    t("ClickEvent", prisma.clickEvent),
    t("AuditLog", prisma.auditLog),
    t("ActivityLog", prisma.activityLog),
    t("Payment", prisma.payment),
    t("Stake", prisma.stake),
    t("Startup", prisma.startup),
  ];
}

/** The destructive half: print what is about to be lost, then lose it. */
async function freshWipe(host: string, local: boolean) {
  const targets = wipeTargets();
  const counts = await Promise.all(
    targets.map(async (t) => ({ name: t.name, rows: await t.count() })),
  );
  const total = counts.reduce((n, c) => n + c.rows, 0);
  console.log(
    `launch-seed --fresh: target ${host}${local ? "" : " (NOT a loopback host)"} — ` +
      `${total} rows in ${targets.length} tables are about to be deleted:`,
  );
  for (const { name, rows } of counts) {
    console.log(`  ${name.padEnd(18)} ${rows}`);
  }
  for (const target of targets) await target.deleteMany();
  await prisma.element.updateMany({
    data: { totalPoolUsd: 0, stakeCount: 0, currentLeaderId: null },
  });
  console.log(
    `launch-seed --fresh: wiped ${total} rows across ${targets.length} tables + reset element aggregates`,
  );
}

async function main() {
  const guard = seedGuard({
    fresh: FRESH,
    databaseUrl: process.env.DATABASE_URL,
    argv: process.argv.slice(2),
  });
  if (!guard.ok) {
    console.error(`launch-seed: refusing to run — ${guard.message}`);
    process.exit(2);
  }
  if (!FRESH) console.log(`launch-seed: appending to ${guard.host}`);
  if (FRESH) await freshWipe(guard.host, guard.local);
  for (const s of SEATS) {
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
        logoUrl: s.logo ?? faviconFor(s.domain, 64),
      },
      // The seeder owns these inventory rows, so a bare re-run also refreshes
      // the logo (the site's own seat moved from the proxy to /icon.png).
      update: { title: s.title, pitch: s.pitch, logoUrl: s.logo ?? faviconFor(s.domain, 64) },
    });
    const existing = await prisma.stake.findUnique({
      where: { elementId_startupId: { elementId: element.id, startupId: startup.id } },
    });
    if (!existing) {
      // clicksDelivered and city stay empty on purpose: a seat nobody bought
      // has not sent any traffic, and the seed does not invent a city for a
      // company that never told us one (doc/phase-5-launch/seed-list.csv).
      await prisma.stake.create({
        data: { elementId: element.id, startupId: startup.id, amountUsd: MIN_STAKE, clicksDelivered: 0 },
      });
      await prisma.activityLog.create({
        data: { domain: s.domain, elementSymbol: s.symbol, amountUsd: MIN_STAKE, kind: "join", city: null, createdAt: new Date(s.ts) },
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
