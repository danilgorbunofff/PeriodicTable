/* Launch seed (Phase 5, spec 01-seed-instrument.md): 18 inventory seats across
 * six real developer-tool companies — one seat per element, never two, so no tile
 * carries a price ladder and every captured tile quotes exactly one dollar over
 * its holder (`MIN_STAKE` + `TAKEOVER_MARGIN`, lib/pricing.ts).
 * The six are picked to read as plausible neighbours, not as stage dressing:
 * companies a software audience knows and a general audience does not
 * (2026-09-16 — the household-name set made the board look fake to a fresh
 * visitor). Fame is not what makes a seat honest; lib/launchInventory.ts carries
 * the full note, and the About sentence is the answer a sceptic actually needs.
 * Real domains are deliberate: a tile draws its holder's icon through
 * `/api/favicon` (this site's own proxy — see faviconFor in lib/screenshots.ts),
 * so a real domain is what makes a real icon render.
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
};

/* One seat per element, three elements per holder, all at the floor. The
   amounts are not restated here: a seat costs `MIN_STAKE`, and the price of
   beating it is derived the same way the checkout derives it. */
const SEATS: SeedSeat[] = [
  { domain: "resend.com", title: "Resend", pitch: "Email API for developers.", symbol: "C", ts: NOW - 1 * H },
  { domain: "resend.com", title: "Resend", pitch: "Email API for developers.", symbol: "Ne", ts: NOW - 21 * H },
  { domain: "resend.com", title: "Resend", pitch: "Email API for developers.", symbol: "Ti", ts: NOW - 33 * H },
  { domain: "lemonsqueezy.com", title: "Lemon Squeezy", pitch: "Payments and merchant of record for indie software.", symbol: "Au", ts: NOW - 3 * H },
  { domain: "lemonsqueezy.com", title: "Lemon Squeezy", pitch: "Payments and merchant of record for indie software.", symbol: "Ag", ts: NOW - 13 * H },
  { domain: "lemonsqueezy.com", title: "Lemon Squeezy", pitch: "Payments and merchant of record for indie software.", symbol: "Cu", ts: NOW - 25 * H },
  { domain: "cal.com", title: "Cal.com", pitch: "Open-source scheduling infrastructure.", symbol: "Si", ts: NOW - 5 * H },
  { domain: "cal.com", title: "Cal.com", pitch: "Open-source scheduling infrastructure.", symbol: "B", ts: NOW - 17 * H },
  { domain: "cal.com", title: "Cal.com", pitch: "Open-source scheduling infrastructure.", symbol: "Ga", ts: NOW - 29 * H },
  { domain: "railway.app", title: "Railway", pitch: "Ship apps without wiring up the infrastructure.", symbol: "H", ts: NOW - 7 * H },
  { domain: "railway.app", title: "Railway", pitch: "Ship apps without wiring up the infrastructure.", symbol: "He", ts: NOW - 19 * H },
  { domain: "railway.app", title: "Railway", pitch: "Ship apps without wiring up the infrastructure.", symbol: "O", ts: NOW - 27 * H },
  { domain: "neon.tech", title: "Neon", pitch: "Serverless Postgres with branching.", symbol: "Fe", ts: NOW - 9 * H },
  { domain: "neon.tech", title: "Neon", pitch: "Serverless Postgres with branching.", symbol: "Co", ts: NOW - 23 * H },
  { domain: "neon.tech", title: "Neon", pitch: "Serverless Postgres with branching.", symbol: "Ni", ts: NOW - 31 * H },
  { domain: "replicate.com", title: "Replicate", pitch: "Run open-source models behind one API.", symbol: "DM", ts: NOW - 11 * H },
  { domain: "replicate.com", title: "Replicate", pitch: "Run open-source models behind one API.", symbol: "U", ts: NOW - 15 * H },
  { domain: "replicate.com", title: "Replicate", pitch: "Run open-source models behind one API.", symbol: "Pu", ts: NOW - 35 * H },
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
    t("ClaimReservation", prisma.claimReservation),
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
        logoUrl: faviconFor(s.domain, 64),
      },
      update: { title: s.title, pitch: s.pitch },
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
