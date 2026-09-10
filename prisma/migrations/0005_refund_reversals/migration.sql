-- AlterEnum
-- A refund/chargeback is terminal and money-reversing: it must be visible as
-- its own outcome rather than hiding inside "ignored".
ALTER TYPE "ProviderEventOutcome" ADD VALUE 'refunded';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "refundedAt" TIMESTAMP(3);
