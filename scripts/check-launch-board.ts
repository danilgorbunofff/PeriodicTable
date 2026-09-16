/** Pre-launch board check: read the live board and say whether the price claim
 *  the launch copy makes is still true (lib/launchBoard.ts).
 *
 *  Read-only by construction — it has no write path and no `--apply` flag, so
 *  it is safe to point at production one minute before publishing, which is the
 *  only moment the answer matters. It reports the seeded shape: one unpaid seat
 *  per element at the floor, so a captured tile is beaten for exactly $6.
 *
 *  Exit 0 = the board matches that shape. Exit 1 = it does not, and each line
 *  says what would change a visitor's mind. A paid bidder is not a failure
 *  (that is the product working) and is reported as info; after real bids land
 *  the check is expected to warn, which is how you learn the copy needs to stop
 *  promising a $6 floor.
 *
 *  Usage:
 *    npm run db:check-board            # reads DATABASE_URL (.env)
 */

import { PrismaClient } from "@prisma/client";
import { readLaunchBoard } from "../lib/launchBoard";

const prisma = new PrismaClient();

const host = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
})();

async function main() {
  const stakes = await prisma.stake.findMany({
    select: {
      amountUsd: true,
      element: { select: { symbol: true } },
      startup: {
        select: {
          domain: true,
          // `status: PAID` is the only proof of purchase the schema has; a
          // PENDING/FAILED row must not read as a customer.
          payments: { where: { status: "PAID" }, select: { id: true }, take: 1 },
        },
      },
    },
  });

  const reading = readLaunchBoard(
    stakes.map((s) => ({
      domain: s.startup.domain,
      symbol: s.element.symbol,
      amountUsd: s.amountUsd,
      paid: s.startup.payments.length > 0,
    }))
  );

  console.log(`launch board — ${host}`);
  console.log(
    `${reading.totals.elements} claimed element(s), ${reading.totals.seats} seat(s), ` +
      `$${reading.totals.poolUsd} pooled, seeded takeover $${reading.totals.takeoverUsd}`
  );

  console.log("\nholders");
  for (const d of reading.domains) {
    console.log(
      `  ${d.paid ? "paid " : "     "} ${d.domain.padEnd(18)} ${String(d.tiles).padStart(3)} tile(s)  $${d.usd}` +
        (d.inventory ? "  [inventory]" : "")
    );
  }

  console.log("\ntiles");
  for (const t of reading.tiles) {
    console.log(
      `  ${t.symbol.padEnd(4)} pool $${String(t.poolUsd).padStart(4)}  beat $${String(t.takeoverUsd).padStart(4)}  ` +
        `${t.leader}${t.paid ? "" : " (unpaid)"}${t.stakeCount > 1 ? ` +${t.stakeCount - 1} more` : ""}`
    );
  }

  const warns = reading.issues.filter((i) => i.severity === "warn");
  const infos = reading.issues.filter((i) => i.severity === "info");
  for (const i of infos) console.log(`\n· info: ${i.message}`);
  for (const i of warns) console.log(`\n✖ ${i.kind}: ${i.message}`);

  if (!reading.ready) {
    console.error(
      `\n✖ launch board does not match the seeded shape (${warns.length} issue(s), ${infos.length} info).\n` +
        `  A visitor reading the landing copy would not find a $${reading.totals.takeoverUsd} takeover on these tiles.\n` +
        `  Fix: re-seed the live board (ops/database.md, "Launch inventory") or correct the copy.\n`
    );
    process.exit(1);
  }

  const contested = reading.tiles.filter((t) => t.stakeCount > 1).length;
  console.log(
    `\n✔ every unpaid seat is inventory, at the $${reading.totals.takeoverUsd - 1} floor, alone on its tile` +
      ` — a captured tile is beaten for $${reading.totals.takeoverUsd}` +
      (contested > 0 ? ` (${contested} paid tile(s) cost more, as they should)` : "") +
      `\n`
  );
}

main()
  .catch((err) => {
    console.error(`\n✖ launch board check failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
