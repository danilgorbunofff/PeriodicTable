-- Phase 1 remediation (ownership, reservations, durable work).
-- Hand-reviewed: the Payment string→enum conversions below preserve values
-- (USING casts, NOT drop/add). Data backfills live in the marked section
-- before the foreign keys. Safe to re-run? No — migrations run once; the
-- statements are idempotent except the FirstClaim INSERT (guarded by
-- ON CONFLICT DO NOTHING).
--
-- Deploy risk note: ClickEvent.stakeId FK assumes every click references a
-- real stake (true for /go-written rows). If deploy fails on dangling refs,
-- repair the data per ops/rollback.md and re-run; never hand-delete audit rows.

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'paid', 'failed', 'refunded', 'canceled');

-- CreateEnum
CREATE TYPE "PaymentPath" AS ENUM ('take', 'join', 'stake', 'reclaim');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('whop', 'dev');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('active', 'consumed', 'expired', 'canceled');

-- CreateEnum
CREATE TYPE "ModerationState" AS ENUM ('visible', 'hidden', 'unlisted');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('open', 'triaged', 'actioned', 'dismissed');

-- Phase 1 repair: duplicate unsubscribe tokens (cuid() should already be
-- unique; keep the earliest-claimed row, reassign the rest so the UNIQUE
-- constraint below applies cleanly).
UPDATE "Startup" SET "unsubToken" = 'reassigned-' || "id" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "unsubToken" ORDER BY "claimedAt", "id") AS rn
    FROM "Startup"
  ) t WHERE rn > 1
);

-- AlterTable: Payment preserves values via USING casts (a drop/add here
-- would destroy status/path/provider history).
ALTER TABLE "Payment" ADD COLUMN     "appliedAt" TIMESTAMP(3),
ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "providerAmount" INTEGER,
ADD COLUMN     "providerCheckoutUrl" TEXT,
ADD COLUMN     "providerCurrency" TEXT,
ADD COLUMN     "providerEventId" TEXT,
ADD COLUMN     "requestFingerprint" TEXT,
ALTER COLUMN "stakeId" DROP NOT NULL,
ALTER COLUMN "path" DROP DEFAULT,
ALTER COLUMN "path" TYPE "PaymentPath" USING "path"::"PaymentPath",
ALTER COLUMN "path" SET DEFAULT 'take',
ALTER COLUMN "provider" TYPE "PaymentProvider" USING "provider"::"PaymentProvider",
ALTER COLUMN "status" DROP DEFAULT,
ALTER COLUMN "status" TYPE "PaymentStatus" USING "status"::"PaymentStatus",
ALTER COLUMN "status" SET DEFAULT 'pending';

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT,
ADD COLUMN     "startupId" TEXT,
ADD COLUMN     "status" "ReportStatus" NOT NULL DEFAULT 'open';

-- AlterTable
ALTER TABLE "Stake" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Startup" ADD COLUMN     "moderatedAt" TIMESTAMP(3),
ADD COLUMN     "moderatedBy" TEXT,
ADD COLUMN     "moderatedReason" TEXT,
ADD COLUMN     "moderationState" "ModerationState" NOT NULL DEFAULT 'visible',
ADD COLUMN     "restoredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ClaimReservation" (
    "id" TEXT NOT NULL,
    "elementId" INTEGER NOT NULL,
    "startupId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "quotedLeaderTotal" INTEGER NOT NULL,
    "quotedLeaderStartupId" TEXT,
    "reservedTotal" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "ClaimReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManageToken" (
    "id" TEXT NOT NULL,
    "startupId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'profile-manage',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManageToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManageSession" (
    "id" TEXT NOT NULL,
    "startupId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManageSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "domain" TEXT,
    "source" TEXT NOT NULL DEFAULT 'checkout-paused',
    "consentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FirstClaim" (
    "elementId" INTEGER NOT NULL,
    "startupId" TEXT NOT NULL,
    "stakeId" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FirstClaim_pkey" PRIMARY KEY ("elementId")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "startupId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'system',
    "actorRef" TEXT,
    "elementId" INTEGER,
    "paymentId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClaimReservation_paymentId_key" ON "ClaimReservation"("paymentId");

-- CreateIndex
CREATE INDEX "ClaimReservation_elementId_status_idx" ON "ClaimReservation"("elementId", "status");

-- CreateIndex
CREATE INDEX "ClaimReservation_expiresAt_idx" ON "ClaimReservation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ManageToken_tokenHash_key" ON "ManageToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ManageToken_startupId_idx" ON "ManageToken"("startupId");

-- CreateIndex
CREATE UNIQUE INDEX "ManageSession_tokenHash_key" ON "ManageSession"("tokenHash");

-- CreateIndex
CREATE INDEX "ManageSession_startupId_idx" ON "ManageSession"("startupId");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_email_key" ON "WaitlistEntry"("email");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_dedupeKey_key" ON "OutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_nextAttemptAt_idx" ON "OutboxEvent"("nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_type_completedAt_idx" ON "OutboxEvent"("type", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FirstClaim_stakeId_key" ON "FirstClaim"("stakeId");

-- CreateIndex
CREATE INDEX "AuditLog_startupId_createdAt_idx" ON "AuditLog"("startupId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerEventId_key" ON "Payment"("providerEventId");

-- NOTE: "Payment_startupId_status_idx" already exists from the baseline
-- migration; not recreated here.

-- CreateIndex
CREATE INDEX "Report_status_createdAt_idx" ON "Report"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Startup_unsubToken_key" ON "Startup"("unsubToken");

-- Phase 1 data backfills (all tables/columns above exist; FKs below do not
-- yet, so repairs land before constraint enforcement).
-- 1) Drop the "pending" stake sentinel; backfill paid payments where the
-- (element, startup) pair provably identifies the stake. Unmatched paid rows
-- stay NULL for audit instead of guessing.
UPDATE "Payment" SET "stakeId" = NULL WHERE "stakeId" = 'pending';
UPDATE "Payment" p SET "stakeId" = s."id" FROM "Stake" s
WHERE p."status" = 'paid' AND p."stakeId" IS NULL
  AND s."elementId" = p."elementId" AND s."startupId" = p."startupId";

-- 2) Stake.createdAt trust order: paid payment time > activity time >
-- startup claimedAt (new column defaulted to migration time as fallback).
UPDATE "Stake" s SET "createdAt" = p."paidAt" FROM (
  SELECT "elementId", "startupId", MIN("paidAt") AS "paidAt" FROM "Payment"
  WHERE "status" = 'paid' AND "paidAt" IS NOT NULL GROUP BY 1, 2
) p WHERE p."elementId" = s."elementId" AND p."startupId" = s."startupId";
UPDATE "Stake" s SET "createdAt" = a."firstSeen" FROM (
  SELECT su."id" AS "startupId", e."id" AS "elementId", MIN(a."createdAt") AS "firstSeen"
  FROM "ActivityLog" a
  JOIN "Startup" su ON su."domain" = a."domain"
  JOIN "Element" e ON e."symbol" = a."elementSymbol"
  GROUP BY 1, 2
) a WHERE a."startupId" = s."startupId" AND a."elementId" = s."elementId"
  AND NOT EXISTS (
    SELECT 1 FROM "Payment" p WHERE p."status" = 'paid' AND p."paidAt" IS NOT NULL
      AND p."elementId" = s."elementId" AND p."startupId" = s."startupId"
  );
UPDATE "Stake" s SET "createdAt" = su."claimedAt" FROM "Startup" su
WHERE su."id" = s."startupId"
  AND NOT EXISTS (
    SELECT 1 FROM "Payment" p WHERE p."status" = 'paid' AND p."paidAt" IS NOT NULL
      AND p."elementId" = s."elementId" AND p."startupId" = s."startupId"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "ActivityLog" a
    JOIN "Startup" su2 ON su2."domain" = a."domain"
    JOIN "Element" e ON e."symbol" = a."elementSymbol"
    WHERE su2."id" = s."startupId" AND e."id" = s."elementId"
  );

-- 3) Repair dangling element leaders before the FK lands.
UPDATE "Element" SET "currentLeaderId" = NULL WHERE "currentLeaderId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Startup" s WHERE s."id" = "Element"."currentLeaderId");

-- 4) Attribute reports to startups via their stake.
UPDATE "Report" r SET "startupId" = s."startupId" FROM "Stake" s
WHERE r."stakeId" = s."id" AND r."startupId" IS NULL;

-- 5) Seed FirstClaim (Early Adopter source) from earliest stake per element.
INSERT INTO "FirstClaim" ("elementId", "startupId", "stakeId", "claimedAt", "source", "confidence", "createdAt")
SELECT DISTINCT ON (s."elementId") s."elementId", s."startupId", s."id", s."createdAt", 'backfill', 'MEDIUM', CURRENT_TIMESTAMP
FROM "Stake" s ORDER BY s."elementId", s."createdAt", s."id"
ON CONFLICT DO NOTHING;

-- 6) One ACTIVE take reservation per element (Prisma has no partial indexes).
CREATE UNIQUE INDEX "ClaimReservation_elementId_active_key" ON "ClaimReservation"("elementId") WHERE "status" = 'active';

-- AddForeignKey
ALTER TABLE "Element" ADD CONSTRAINT "Element_currentLeaderId_fkey" FOREIGN KEY ("currentLeaderId") REFERENCES "Startup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_stakeId_fkey" FOREIGN KEY ("stakeId") REFERENCES "Stake"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_elementId_fkey" FOREIGN KEY ("elementId") REFERENCES "Element"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimReservation" ADD CONSTRAINT "ClaimReservation_elementId_fkey" FOREIGN KEY ("elementId") REFERENCES "Element"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimReservation" ADD CONSTRAINT "ClaimReservation_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimReservation" ADD CONSTRAINT "ClaimReservation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManageToken" ADD CONSTRAINT "ManageToken_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManageSession" ADD CONSTRAINT "ManageSession_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstClaim" ADD CONSTRAINT "FirstClaim_elementId_fkey" FOREIGN KEY ("elementId") REFERENCES "Element"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstClaim" ADD CONSTRAINT "FirstClaim_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirstClaim" ADD CONSTRAINT "FirstClaim_stakeId_fkey" FOREIGN KEY ("stakeId") REFERENCES "Stake"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_elementId_fkey" FOREIGN KEY ("elementId") REFERENCES "Element"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClickEvent" ADD CONSTRAINT "ClickEvent_stakeId_fkey" FOREIGN KEY ("stakeId") REFERENCES "Stake"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_stakeId_fkey" FOREIGN KEY ("stakeId") REFERENCES "Stake"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

