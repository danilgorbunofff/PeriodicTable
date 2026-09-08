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
