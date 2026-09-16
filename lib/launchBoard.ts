/* Launch board reading (doc/phase-5-launch/01-seed-instrument.md).

   The launch claim is a price claim: the seeded inventory opens one seat per
   element at the floor, so a captured tile carries no ladder and the price of
   beating it is a single number (`takeLeadPrice(MIN_STAKE)` = $6). Nothing
   enforced that claim against a live database. The seed wrote the right rows
   and then time passed: prices were edited by hand, extra bidders appeared on
   seeded tiles, and the only way to find out was ad-hoc SQL after a launch
   audience had already seen the numbers.

   This module turns that reading into a pure function so the ops script
   (scripts/check-launch-board.ts) and its tests derive the same answer from the
   same rules. It opens no database connection and imports no Prisma types: a
   stake is a row of four fields, which is all the claim is about.

   Severity is the point. A *paid* rival is the product working — someone
   bought into a tile, and the tile is allowed to cost more than $6 afterwards;
   that is `info`, and `ready` stays true. An *unpaid* row that is not the
   seeded inventory is residue pretending to be a customer, which is what the
   launch claim is actually about: `warn`, and `ready` goes false. */

import { MIN_STAKE, takeLeadPrice } from "./pricing";
import { LAUNCH_INVENTORY_DOMAINS } from "./launchInventory";

/** One `Stake` row, flattened. `paid` = a `Payment` with status `PAID` exists. */
export type BoardStakeRow = {
  domain: string;
  symbol: string;
  amountUsd: number;
  paid: boolean;
};

export type LaunchBoardIssueKind =
  /** An unpaid row that is not at the floor — the "rebid" a visitor complains about. */
  | "not-floor"
  /** More than one row on a tile: the takeover price is no longer $6. */
  | "ladder"
  /** An unpaid holder the seeders never wrote. */
  | "unpaid-residue"
  /** An inventory domain acquired a payment: it is a customer now. */
  | "paid-inventory";

export type LaunchBoardIssue = {
  kind: LaunchBoardIssueKind;
  severity: "warn" | "info";
  message: string;
};

/** A claimed element as the board renders it: one number to beat. */
export type LaunchBoardTile = {
  symbol: string;
  poolUsd: number;
  stakeCount: number;
  takeoverUsd: number;
  leader: string;
  /** Every row on this tile is paid for. */
  paid: boolean;
};

export type LaunchBoardDomain = {
  domain: string;
  tiles: number;
  usd: number;
  paid: boolean;
  inventory: boolean;
};

export type LaunchBoardReading = {
  tiles: LaunchBoardTile[];
  domains: LaunchBoardDomain[];
  issues: LaunchBoardIssue[];
  /** No `warn` issues: every unpaid seat is inventory, at the floor, alone. */
  ready: boolean;
  /** `takeoverUsd` is the seeded-floor price ($6), not the sum of each tile's. */
  totals: { elements: number; seats: number; poolUsd: number; takeoverUsd: number };
};

/** Highest stake wins; equal totals settle by domain so two runs read alike. */
function leaderOf(rows: BoardStakeRow[]): BoardStakeRow {
  return [...rows].sort((a, b) => b.amountUsd - a.amountUsd || a.domain.localeCompare(b.domain))[0];
}

export function readLaunchBoard(
  stakes: BoardStakeRow[],
  inventoryDomains: readonly string[] = LAUNCH_INVENTORY_DOMAINS
): LaunchBoardReading {
  const inventory = new Set<string>(inventoryDomains);
  const bySymbol = new Map<string, BoardStakeRow[]>();
  for (const row of stakes) {
    const rows = bySymbol.get(row.symbol);
    if (rows) rows.push(row);
    else bySymbol.set(row.symbol, [row]);
  }

  const tiles: LaunchBoardTile[] = [];
  const issues: LaunchBoardIssue[] = [];

  for (const [symbol, rows] of bySymbol) {
    const poolUsd = rows.reduce((sum, r) => sum + r.amountUsd, 0);
    const leader = leaderOf(rows);
    tiles.push({
      symbol,
      poolUsd,
      stakeCount: rows.length,
      takeoverUsd: takeLeadPrice(leader.amountUsd),
      leader: leader.domain,
      paid: rows.every((r) => r.paid),
    });

    const unpaid = rows.filter((r) => !r.paid);
    if (rows.length > 1) {
      const detail = rows
        .map((r) => `${r.domain} $${r.amountUsd}${r.paid ? " (paid)" : ""}`)
        .join(", ");
      issues.push({
        kind: "ladder",
        severity: rows.some((r) => r.paid) ? "info" : "warn",
        message: `${symbol}: ${rows.length} rows (${detail}) — beating it costs $${takeLeadPrice(leader.amountUsd)}, not $${takeLeadPrice(MIN_STAKE)}`,
      });
    }
    for (const row of unpaid) {
      if (row.amountUsd !== MIN_STAKE) {
        issues.push({
          kind: "not-floor",
          severity: "warn",
          message: `${symbol}: ${row.domain} holds $${row.amountUsd} with no payment on file`,
        });
      }
      if (!inventory.has(row.domain)) {
        issues.push({
          kind: "unpaid-residue",
          severity: "warn",
          message: `${symbol}: ${row.domain} holds $${row.amountUsd} and is not a launch inventory domain`,
        });
      }
    }
  }

  const byDomain = new Map<string, LaunchBoardDomain>();
  for (const row of stakes) {
    const current = byDomain.get(row.domain) ?? {
      domain: row.domain,
      tiles: 0,
      usd: 0,
      paid: false,
      inventory: inventory.has(row.domain),
    };
    current.tiles += 1;
    current.usd += row.amountUsd;
    current.paid ||= row.paid;
    byDomain.set(row.domain, current);
  }

  for (const domain of byDomain.values()) {
    // One line per customer, not per tile: the payment proves the *company*
    // turned up, which is the fact the placeholder copy has to answer for.
    if (domain.paid && domain.inventory) {
      issues.push({
        kind: "paid-inventory",
        severity: "info",
        message: `${domain.domain} is a paying customer now (${domain.tiles} tile(s)) — the FAQ sentence about seats we did not sell needs a re-read`,
      });
    }
  }

  tiles.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const domains = [...byDomain.values()].sort((a, b) => b.usd - a.usd || a.domain.localeCompare(b.domain));

  return {
    tiles,
    domains,
    issues,
    ready: !issues.some((i) => i.severity === "warn"),
    totals: {
      elements: tiles.length,
      seats: stakes.length,
      poolUsd: stakes.reduce((sum, r) => sum + r.amountUsd, 0),
      takeoverUsd: takeLeadPrice(MIN_STAKE),
    },
  };
}
