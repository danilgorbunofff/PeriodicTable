/* Demo provenance, database half (doc/phase-5-launch/01-seed-instrument.md).

   `prisma/launch-seed.ts` upserts real-company domains as placeholder listings
   so the launch grid is not empty. They are NOT customers: the seed writes no
   email, no Payment, and no management token. Launch cleanup
   (scripts/clear-demo-data.ts) removes them and refuses any row that has since
   acquired one of those real-customer signals.

   The inventory and the R16-9 label live in lib/demoLabels.ts, which pulls no
   Prisma — client components render that label, and this module must never
   reach a browser bundle. */

import { prisma } from "./prisma";
import { DEMO_STARTUP_DOMAINS } from "./demoLabels";

/** Re-exported so the sweep script and the tests keep one import site for the
 *  demo inventory while client code imports the Prisma-free module. */
export { DEMO_LABEL, DEMO_NOTE, DEMO_STARTUP_DOMAINS, isDemoListing } from "./demoLabels";

/** A demo candidate plus the signals that would prove it became real. */
export type DemoStartupRow = {
  id: string;
  domain: string;
  email: string | null;
  moderatedBy: string | null;
  moderatedReason: string | null;
  paymentCount: number;
  manageTokenCount: number;
  manageSessionCount: number;
};

export type DemoAssessment = {
  removable: DemoStartupRow[];
  blocked: { row: DemoStartupRow; reasons: string[] }[];
};

/** Signals the seed never writes — any one of them means real intent moved in. */
export function blockReasons(row: DemoStartupRow): string[] {
  const reasons: string[] = [];
  if (row.email) reasons.push(`notification email on file (${row.email})`);
  if (row.paymentCount > 0) reasons.push(`${row.paymentCount} payment row(s)`);
  if (row.manageTokenCount > 0) reasons.push(`${row.manageTokenCount} manage token(s)`);
  if (row.manageSessionCount > 0) reasons.push(`${row.manageSessionCount} manage session(s)`);
  if (row.moderatedBy || row.moderatedReason) reasons.push("operator moderation on record");
  return reasons;
}

/**
 * The demo domains that still have no payment, as a set ready to test per row.
 *
 * Bounded by construction: the query is one `Startup` lookup over the nine
 * seeded domains with an existence check on their payments, so it costs the
 * same on a busy day as on an empty one, and it never scans `Payment`.
 */
export async function demoListingDomains(): Promise<Set<string>> {
  const paid = await prisma.startup.findMany({
    where: {
      domain: { in: [...DEMO_STARTUP_DOMAINS] },
      payments: { some: { status: "PAID" } },
    },
    select: { domain: true },
  });
  const paidDomains = new Set(paid.map((r) => r.domain));
  return new Set(
    DEMO_STARTUP_DOMAINS.filter((d) => !paidDomains.has(d)),
  );
}

export function assessDemoStartups(rows: DemoStartupRow[]): DemoAssessment {
  const removable: DemoStartupRow[] = [];
  const blocked: { row: DemoStartupRow; reasons: string[] }[] = [];
  for (const row of rows) {
    const reasons = blockReasons(row);
    if (reasons.length > 0) blocked.push({ row, reasons });
    else removable.push(row);
  }
  return { removable, blocked };
}
