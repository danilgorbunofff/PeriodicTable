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

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
