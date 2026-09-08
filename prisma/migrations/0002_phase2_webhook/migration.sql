-- CreateEnum
CREATE TYPE "ProviderEventOutcome" AS ENUM ('received', 'applied', 'duplicate', 'ignored', 'failed', 'error');

-- CreateTable
CREATE TABLE "ProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "paymentId" TEXT,
    "outcome" "ProviderEventOutcome" NOT NULL DEFAULT 'received',
    "detail" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderEvent_providerEventId_key" ON "ProviderEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "ProviderEvent_paymentId_createdAt_idx" ON "ProviderEvent"("paymentId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProviderEvent" ADD CONSTRAINT "ProviderEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

