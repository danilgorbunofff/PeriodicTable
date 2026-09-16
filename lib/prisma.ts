import { PrismaClient } from "@prisma/client";
import { reportProdEnvAtStartup } from "@/lib/env";

// R07-3: startup configuration check. Every data path in the app reaches the
// database through this module, so this is where an incomplete production
// environment is reported whether or not the operator ever opens
// /api/jobs/config — one line per cold start, and deliberately never a throw:
// taking the deployment down would also take down the endpoint that explains
// why. See lib/env.ts for the full rationale.
reportProdEnvAtStartup();

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// R12-5: the pool is a decision, not a default. Production connects through
// Neon's POOLED endpoint — DATABASE_URL's host must carry the `-pooler` suffix
// and PgBouncer runs in transaction mode — so the ceiling is Neon's
// `default_pool_size` for the compute, not an application-side number this file
// could assert: DATABASE_URL is a Vercel *sensitive* variable whose value reads
// back empty, so the repository can neither see nor verify its query string.
// Two things that follow from that, for whoever edits this next:
//   · interactive transactions ($transaction(fn), the settlement paths) hold one
//     dedicated connection for their duration and are untouched by
//     transaction-mode pooling, so they need no extra knob here;
//   · if a migration ever fails on advisory locks, add `directUrl` (the direct
//     endpoint) for migrations instead of un-pooling the app — HANDOFF.md:660.
// The actual runtime ceiling is only provable against production: U12-2
// (`SHOW max_connections` plus `SELECT count(*) FROM pg_stat_activity`).
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
