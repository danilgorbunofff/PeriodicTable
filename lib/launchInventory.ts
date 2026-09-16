/* Launch inventory (doc/phase-5-launch/01-seed-instrument.md).

   `prisma/launch-seed.ts` opens a small set of seats before anybody has bought
   one, so the launch grid is not empty: real-company domains, one seat per
   element, every seat at the $5 floor. They are NOT customers — the seed writes
   no email, no Payment and no management token. Launch cleanup
   (scripts/clear-launch-inventory.ts) removes them and refuses any row that has
   since acquired one of those real-customer signals.

   This module opens no database connection, so the seeder, the cleanup script
   and the readiness tests can all read the same answer without pulling Prisma —
   and so nothing here can reach a browser bundle by accident. */

/** Every domain the launch inventory may seat. One row per element, one seat
 *  per element, all at the floor (`MIN_STAKE`, lib/pricing.ts) — so a captured
 *  tile quotes exactly one dollar over its holder and carries no ladder. */
export const LAUNCH_INVENTORY_DOMAINS = [
  "stripe.com",
  "coinbase.com",
  "nvidia.com",
  "cloudflare.com",
  "supabase.com",
  "anthropic.com",
] as const;

/** An inventory candidate plus the signals that would prove it became real. */
export type InventoryStartupRow = {
  id: string;
  domain: string;
  email: string | null;
  moderatedBy: string | null;
  moderatedReason: string | null;
  paymentCount: number;
  manageTokenCount: number;
  manageSessionCount: number;
};

export type InventoryAssessment = {
  removable: InventoryStartupRow[];
  blocked: { row: InventoryStartupRow; reasons: string[] }[];
};

/** Signals the seed never writes — any one of them means real intent moved in. */
export function blockReasons(row: InventoryStartupRow): string[] {
  const reasons: string[] = [];
  if (row.email) reasons.push(`notification email on file (${row.email})`);
  if (row.paymentCount > 0) reasons.push(`${row.paymentCount} payment row(s)`);
  if (row.manageTokenCount > 0) reasons.push(`${row.manageTokenCount} manage token(s)`);
  if (row.manageSessionCount > 0) reasons.push(`${row.manageSessionCount} manage session(s)`);
  if (row.moderatedBy || row.moderatedReason) reasons.push("operator moderation on record");
  return reasons;
}

export function assessInventoryStartups(rows: InventoryStartupRow[]): InventoryAssessment {
  const removable: InventoryStartupRow[] = [];
  const blocked: { row: InventoryStartupRow; reasons: string[] }[] = [];
  for (const row of rows) {
    const reasons = blockReasons(row);
    if (reasons.length > 0) blocked.push({ row, reasons });
    else removable.push(row);
  }
  return { removable, blocked };
}
