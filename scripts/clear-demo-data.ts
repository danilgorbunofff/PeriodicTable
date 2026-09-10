/** Launch cleanup: remove the placeholder listings `prisma/launch-seed.ts`
 *  wrote into the grid, so a brand-new territory map does not read as "taken"
 *  by real companies that never claimed anything (HANDOFF §1).
 *
 *  Dry run by default. Provenance-guarded: a candidate is only touched when it
 *  still looks exactly as the seed left it — no notification email, no payment,
 *  no manage token/session, no operator moderation. A single deviation aborts
 *  the whole run, because a half-seeded/half-real batch is worse than either.
 *
 *  The dry run executes the identical code path inside a transaction that is
 *  rolled back, so the printed plan is exactly what --apply will do.
 *
 *  Usage:
 *    npm run db:clear-demo                                  # plan only
 *    npm run db:clear-demo -- --apply --allow-remote         # write
 *  Flags:
 *    --apply             execute (default: print the plan and roll back)
 *    --allow-remote      required with --apply for a non-local host
 *    --force             proceed despite PAID payment(s) elsewhere in the DB
 *    --purge-email-log   also delete EmailLog rows (smoke-test residue, no FK)
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { rankStakes, assertLedgerInvariants } from "../lib/pricing";
import { DEMO_STARTUP_DOMAINS, assessDemoStartups, type DemoStartupRow } from "../lib/demoData";

const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ALLOW_REMOTE = argv.includes("--allow-remote");
const FORCE = argv.includes("--force");
const PURGE_EMAIL_LOG = argv.includes("--purge-email-log");

const isLocal = (url: string) => /(localhost|127\.0\.0\.1)/.test(url);

function die(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

class Rollback extends Error {}

/** Same rank/pool derivation the seed and the ledger share — never hand-rolled. */
async function recomputeElement(db: Prisma.TransactionClient, elementId: number) {
  const stakes = await db.stake.findMany({ where: { elementId } });
  const ranked = rankStakes(stakes);
  const pool = ranked.reduce((sum, s) => sum + s.amountUsd, 0);
  const leaderId = ranked.length > 0 ? ranked[0].startupId : null;
  assertLedgerInvariants(
    ranked.map((r) => ({
      id: r.id,
      startupId: r.startupId,
      amountUsd: r.amountUsd,
      rank: r.rank,
      isLeader: r.isLeader,
    })),
    { totalPoolUsd: pool, stakeCount: ranked.length, currentLeaderId: leaderId }
  );
  for (const r of ranked) {
    await db.stake.update({ where: { id: r.id }, data: { rank: r.rank, isLeader: r.isLeader } });
  }
  await db.element.update({
    where: { id: elementId },
    data: { totalPoolUsd: pool, stakeCount: ranked.length, currentLeaderId: leaderId },
  });
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) die("DATABASE_URL is not set (use: npm run db:clear-demo)");

  let host = "(unparseable url)";
  try {
    host = new URL(url).host || host;
  } catch {
    /* keep placeholder — the guard below still applies */
  }

  console.log(`target: ${host}`);
  console.log(`mode:   ${APPLY ? "APPLY (writes)" : "DRY RUN (rolls back)"}${PURGE_EMAIL_LOG ? " + purge-email-log" : ""}`);

  if (APPLY && !isLocal(url) && !ALLOW_REMOTE) {
    die(`refusing to write to a non-local database (${host}) without --allow-remote`);
  }

  // ---- 1. candidates + provenance guard -------------------------------------
  const found = await prisma.startup.findMany({
    where: { domain: { in: [...DEMO_STARTUP_DOMAINS] } },
    select: {
      id: true,
      domain: true,
      email: true,
      moderatedBy: true,
      moderatedReason: true,
      _count: { select: { payments: true, manageTokens: true, manageSessions: true } },
    },
  });

  const rows: DemoStartupRow[] = found.map((s) => ({
    id: s.id,
    domain: s.domain,
    email: s.email,
    moderatedBy: s.moderatedBy,
    moderatedReason: s.moderatedReason,
    paymentCount: s._count.payments,
    manageTokenCount: s._count.manageTokens,
    manageSessionCount: s._count.manageSessions,
  }));

  const { removable, blocked } = assessDemoStartups(rows);

  for (const { row, reasons } of blocked) {
    console.error(`  ! ${row.domain} — ${reasons.join("; ")}`);
  }
  if (blocked.length > 0) {
    die(
      `${blocked.length} candidate(s) carry real-customer signals — refusing to delete anything.\n` +
        `  Resolve those rows by hand, then re-run.`
    );
  }

  if (removable.length === 0) {
    console.log("\nNo demo rows found on the allowlist. Nothing to do.");
    return;
  }

  // A paid payment anywhere means money moved: never clean up around that silently.
  const paidTotal = await prisma.payment.count({ where: { status: "PAID" } });
  if (paidTotal > 0 && !FORCE) {
    die(
      `this database has ${paidTotal} PAID payment(s) — real money moved here.\n` +
        `  Re-run with --force only if you are certain those rows are unrelated to the demo seed.`
    );
  }

  // ---- 2. the blast radius --------------------------------------------------
  const demoIds = removable.map((r) => r.id);
  const demoStakes = await prisma.stake.findMany({
    where: { startupId: { in: demoIds } },
    select: { id: true, elementId: true },
  });
  const demoStakeIds = demoStakes.map((s) => s.id);
  const ledElements = await prisma.element.findMany({
    where: { currentLeaderId: { in: demoIds } },
    select: { id: true },
  });
  const affectedElementIds = [
    ...new Set([...demoStakes.map((s) => s.elementId), ...ledElements.map((e) => e.id)]),
  ].sort((a, b) => a - b);

  const outboxIds = (
    await prisma.outboxEvent.findMany({
      where: { type: "PREVIEW_GENERATE" },
      select: { id: true, payload: true },
    })
  )
    .filter((e) => {
      const payload = e.payload as { startupId?: string } | null;
      return !!payload?.startupId && demoIds.includes(payload.startupId);
    })
    .map((e) => e.id);

  console.log(`\ndemo rows: ${removable.length} startups, ${demoStakeIds.length} stakes on ${affectedElementIds.length} elements`);
  console.log(`  ${removable.map((r) => r.domain).join(", ")}`);
  console.log(`  elements: ${affectedElementIds.join(", ")}`);

  // ---- 3. child-first plan, shared by dry run and apply ---------------------
  type Step = { label: string; run: (tx: Prisma.TransactionClient) => Promise<number> };
  const del = (label: string, run: Step["run"]): Step => ({ label, run });

  const children: Step[] = [
    del("providerEvent", async (tx) => (await tx.providerEvent.deleteMany({ where: { payment: { startupId: { in: demoIds } } } })).count),
    del("claimReservation", async (tx) => (await tx.claimReservation.deleteMany({ where: { startupId: { in: demoIds } } })).count),
    del("manageSession", async (tx) => (await tx.manageSession.deleteMany({ where: { startupId: { in: demoIds } } })).count),
    del("manageToken", async (tx) => (await tx.manageToken.deleteMany({ where: { startupId: { in: demoIds } } })).count),
    del("firstClaim", async (tx) =>
      (await tx.firstClaim.deleteMany({
        where: { OR: [{ startupId: { in: demoIds } }, { stakeId: { in: demoStakeIds } }] },
      })).count),
    del("report", async (tx) =>
      (await tx.report.deleteMany({
        where: { OR: [{ startupId: { in: demoIds } }, { stakeId: { in: demoStakeIds } }] },
      })).count),
    del("clickEvent", async (tx) => (await tx.clickEvent.deleteMany({ where: { stakeId: { in: demoStakeIds } } })).count),
    del("auditLog", async (tx) => (await tx.auditLog.deleteMany({ where: { startupId: { in: demoIds } } })).count),
    del("payment", async (tx) => (await tx.payment.deleteMany({ where: { startupId: { in: demoIds } } })).count),
    del("stake", async (tx) => (await tx.stake.deleteMany({ where: { startupId: { in: demoIds } } })).count),
    del("activityLog", async (tx) =>
      (await tx.activityLog.deleteMany({
        where: { paymentId: null, domain: { in: [...DEMO_STARTUP_DOMAINS] } },
      })).count),
  ];

  // Must follow the stake delete (pools drop to zero) and precede the startup
  // delete, because Element.currentLeaderId references Startup.
  const parents: Step[] = [
    del("outboxEvent", async (tx) => (outboxIds.length ? (await tx.outboxEvent.deleteMany({ where: { id: { in: outboxIds } } })).count : 0)),
    del("startup", async (tx) => (await tx.startup.deleteMany({ where: { id: { in: demoIds } } })).count),
    ...(PURGE_EMAIL_LOG
      ? [del("emailLog", async (tx) => (await tx.emailLog.deleteMany({ where: { to: { endsWith: ".dev" } } })).count)]
      : []),
  ];

  const deleted: Record<string, number> = {};
  const runPlan = async (tx: Prisma.TransactionClient) => {
    for (const step of children) deleted[step.label] = await step.run(tx);
    for (const elementId of affectedElementIds) await recomputeElement(tx, elementId);
    for (const step of parents) deleted[step.label] = await step.run(tx);
    if (!APPLY) throw new Rollback();
  };

  await prisma
    .$transaction(runPlan, { timeout: 120_000, maxWait: 20_000 })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });

  const width = Math.max(...Object.keys(deleted).map((k) => k.length));
  console.log(APPLY ? "\ndeleted:" : "\nplan (rolled back, nothing written):");
  for (const [label, count] of Object.entries(deleted)) {
    if (count > 0) console.log(`  ${label.padEnd(width)}  ${count}`);
  }

  if (!APPLY) {
    console.log(`\nnothing written. to execute:\n  npm run db:clear-demo -- --apply${isLocal(url) ? "" : " --allow-remote"}\n`);
    return;
  }

  // ---- 4. verify the public surface ----------------------------------------
  const [leftover, stakes, pool, claimed] = await Promise.all([
    prisma.startup.count({ where: { domain: { in: [...DEMO_STARTUP_DOMAINS] } } }),
    prisma.stake.count(),
    prisma.stake.aggregate({ _sum: { amountUsd: true } }),
    prisma.element.count({ where: { stakeCount: { gt: 0 } } }),
  ]);

  console.log(`\nverify: ${leftover} demo startup(s) left, ${stakes} stake(s), $${pool._sum.amountUsd ?? 0}, ${claimed} claimed element(s)`);
  if (leftover > 0) die("demo rows survived the cleanup — investigate before announcing.");

  const elements = await prisma.element.findMany({
    where: { OR: [{ stakeCount: { gt: 0 } }, { totalPoolUsd: { gt: 0 } }, { currentLeaderId: { not: null } }] },
    select: { symbol: true, stakeCount: true, totalPoolUsd: true, currentLeaderId: true },
  });
  if (elements.length > 0) {
    console.error("  ! element aggregates still non-zero:", JSON.stringify(elements));
    die("aggregate reset incomplete.");
  }
  console.log("aggregates reset: every element is unclaimed with a $0 pool.");
}

main()
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
