/**
 * Demo provenance, browser-safe half (R16-9).
 *
 * These live apart from `lib/demoData.ts` on purpose: the label is rendered by
 * client components (`components/Tile.tsx`, `components/Modals.tsx`,
 * `components/ActivityCard.tsx`, `components/WorldOrder.tsx`), and `demoData.ts`
 * opens a Prisma client, which must never reach a browser bundle. Same split as
 * `lib/legal.ts` / `lib/legalDocs.ts`: the facts a browser needs here, the
 * database queries there.
 */

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

/**
 * The provenance mark (R16-9).
 *
 * The seeder's rows carried a real company's domain, a paid-looking amount and
 * an invented city, and nothing on the board, the table or the feed said
 * otherwise — so the product was asserting that stripe.com had paid for a
 * listing it never bought. A reader cannot tell those rows from customers, and
 * the About page claimed every link was paid for.
 *
 * A domain is illustrative while it is a known demo domain **and** has no paid
 * payment. Both halves matter: the domain alone would keep the label on a
 * listing a real startup later bought (calling a customer's ad a placeholder is
 * the same false statement, pointed the other way), and "no payment" alone
 * would mark every ordinary unpaid reservation.
 */
export const DEMO_LABEL = "demo";

/** One sentence, used by every surface that has room for one. */
export const DEMO_NOTE = "placeholder listing seeded before launch — no payment was made";

/**
 * `unclaimed` is the set `demoListingDomains()` builds: the inventory members
 * that still have no PAID payment. Membership is the whole answer, so the two
 * halves of the rule cannot disagree — an earlier version read the set as
 * "domains that paid", which is its complement, and the label therefore never
 * appeared on anything.
 *
 * The inventory arm stays even though the set is already derived from it, and
 * it is not redundant: it is the guarantee that holds no matter what a caller
 * passes in, so a customer's listing can never be described as a placeholder.
 * (Guards both ways: `/api/*` routes pass the eligible set, and no row outside
 * the nine seeded domains can be labelled even if the set says otherwise.)
 */
export function isDemoListing(domain: string, unclaimed: ReadonlySet<string>): boolean {
  const d = domain.toLowerCase();
  if (!(DEMO_STARTUP_DOMAINS as readonly string[]).includes(d)) return false;
  return unclaimed.has(d);
}

