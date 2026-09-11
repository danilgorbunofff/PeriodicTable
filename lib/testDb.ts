/**
 * Integration-test database guard (Phase 1).
 *
 * DB tests create and delete fixture rows. They must NEVER run against a
 * shared/production database: they execute only when the target is a local
 * Postgres (localhost/127.0.0.1) or when VITEST_ALLOW_REMOTE_DB=1 is set
 * explicitly (e.g. an ephemeral preview branch). Anything else → skip.
 *
 * TEST_DATABASE_URL (optional) points the whole suite at a separate database.
 * It is applied to process.env.DATABASE_URL on import so the `@/lib/prisma`
 * singleton used by lib code under test binds the same target. Test files
 * MUST import this module first for the switch to take effect.
 */
import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const url = process.env.DATABASE_URL ?? "";

export const hasTestDb: boolean =
  url.length > 0 &&
  (/(localhost|127\.0\.0\.1)/.test(url) || process.env.VITEST_ALLOW_REMOTE_DB === "1");

/** Prisma client pinned to the test database. */
export function testPrisma(): PrismaClient {
  return new PrismaClient(url ? { datasourceUrl: url } : undefined);
}

/**
 * The dedupe keys `settlePayment` fans out for one settled payment.
 *
 * `preview-` is keyed on the PAYER startup, the other three on the payment —
 * see lib/settle.ts. Both ids are needed to cover a settlement completely.
 */
export function settledOutboxKeys(paymentId: string, payerStartupId: string): string[] {
  return [`receipt-${paymentId}`, `outbid-${paymentId}`, `analytics-${paymentId}`, `preview-${payerStartupId}`];
}

/**
 * Delete the outbox rows left behind by settled payments.
 *
 * Cleanup MUST key on the entity ids settlePayment used. Filtering on a
 * test-name substring (e.g. `contains: "settle-t"`) matches none of these
 * keys, silently leaking every row into the test database. Call this BEFORE
 * deleting the payments themselves — it reads their ids to build the keys.
 */
export async function purgeSettledOutbox(
  prisma: PrismaClient,
  where: Prisma.PaymentWhereInput,
): Promise<number> {
  const payments = await prisma.payment.findMany({ where, select: { id: true, startupId: true } });
  if (payments.length === 0) return 0;
  const keys = payments.flatMap((p) => settledOutboxKeys(p.id, p.startupId));
  const { count } = await prisma.outboxEvent.deleteMany({ where: { dedupeKey: { in: keys } } });
  return count;
}
