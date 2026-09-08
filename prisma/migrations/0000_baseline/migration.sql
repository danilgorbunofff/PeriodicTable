-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ChemicalFamily" AS ENUM ('ALKALI_METAL', 'ALKALINE_EARTH', 'TRANSITION_METAL', 'POST_TRANSITION_METAL', 'METALLOID', 'REACTIVE_NONMETAL', 'HALOGEN', 'NOBLE_GAS', 'LANTHANIDE', 'ACTINIDE', 'EXOTIC_THEORETICAL');

-- CreateEnum
CREATE TYPE "PrestigeTier" AS ENUM ('STANDARD', 'CULTURAL_ELITE', 'EXOTIC');

-- CreateTable
CREATE TABLE "Element" (
    "id" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "atomicMass" TEXT NOT NULL,
    "gridRow" INTEGER NOT NULL,
    "gridCol" INTEGER NOT NULL,
    "family" "ChemicalFamily" NOT NULL,
    "tier" "PrestigeTier" NOT NULL DEFAULT 'STANDARD',
    "totalPoolUsd" INTEGER NOT NULL DEFAULT 0,
    "stakeCount" INTEGER NOT NULL DEFAULT 0,
    "currentLeaderId" TEXT,

    CONSTRAINT "Element_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Startup" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" VARCHAR(32) NOT NULL,
    "pitch" VARCHAR(140) NOT NULL,
    "url" TEXT NOT NULL,
    "linkType" TEXT NOT NULL DEFAULT 'product',
    "logoUrl" TEXT NOT NULL,
    "previewImgUrl" TEXT,
    "email" TEXT,
    "unsubToken" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Startup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stake" (
    "id" TEXT NOT NULL,
    "elementId" INTEGER NOT NULL,
    "startupId" TEXT NOT NULL,
    "amountUsd" INTEGER NOT NULL,
    "clicksDelivered" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER NOT NULL DEFAULT 99,
    "isLeader" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "stakeId" TEXT NOT NULL,
    "elementId" INTEGER NOT NULL,
    "startupId" TEXT NOT NULL,
    "amountUsd" INTEGER NOT NULL,
    "path" TEXT NOT NULL DEFAULT 'take',
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "elementSymbol" TEXT NOT NULL,
    "amountUsd" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'stake',
    "city" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClickEvent" (
    "id" TEXT NOT NULL,
    "stakeId" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClickEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "elementSymbol" TEXT,
    "amountUsd" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "stakeId" TEXT,
    "domain" TEXT,
    "reason" VARCHAR(280) NOT NULL,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Element_symbol_key" ON "Element"("symbol");

-- CreateIndex
CREATE INDEX "Element_family_idx" ON "Element"("family");

-- CreateIndex
CREATE INDEX "Element_tier_idx" ON "Element"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "Startup_domain_key" ON "Startup"("domain");

-- CreateIndex
CREATE INDEX "Stake_elementId_amountUsd_idx" ON "Stake"("elementId", "amountUsd" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Stake_elementId_startupId_key" ON "Stake"("elementId", "startupId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerRef_key" ON "Payment"("providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payment_startupId_status_idx" ON "Payment"("startupId", "status");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "ClickEvent_stakeId_createdAt_idx" ON "ClickEvent"("stakeId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailLog_createdAt_idx" ON "EmailLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "Report_createdAt_idx" ON "Report"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Stake" ADD CONSTRAINT "Stake_elementId_fkey" FOREIGN KEY ("elementId") REFERENCES "Element"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stake" ADD CONSTRAINT "Stake_startupId_fkey" FOREIGN KEY ("startupId") REFERENCES "Startup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

