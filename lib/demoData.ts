/* Demo/seed provenance (doc/phase-5-launch/01-seed-instrument.md).
   `prisma/launch-seed.ts` upserts these real-company domains as placeholder
   listings so the launch grid is not empty. They are NOT customers: the seed
   writes no email, no Payment, and no management token. Launch cleanup
   (scripts/clear-demo-data.ts) removes them and refuses any row that has since
   acquired one of those real-customer signals. */

export const DEMO_STARTUP_DOMAINS = [
  "stripe.com",
  "coinbase.com",
  "adyen.com",
  "squareup.com",
  "nvidia.com",
  "anthropic.com",
  "cloudflare.com",
  "supabase.com",
  "huggingface.co",
] as const;

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
