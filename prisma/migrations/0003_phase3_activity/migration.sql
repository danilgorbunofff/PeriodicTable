-- Phase 3 remediation (P2-06: activity must carry the payment delta and the
-- resulting total, not just a cumulative number).
-- Backfill: pre-Phase-3 rows logged the cumulative total in amountUsd, so
-- resultTotalUsd = amountUsd is exact for history. deltaUsd stays NULL where
-- the delta is unknowable (honest unknown, never fabricated).
ALTER TABLE "ActivityLog" ADD COLUMN     "deltaUsd" INTEGER,
ADD COLUMN     "paymentId" TEXT,
ADD COLUMN     "resultTotalUsd" INTEGER;

UPDATE "ActivityLog" SET "resultTotalUsd" = "amountUsd" WHERE "resultTotalUsd" IS NULL;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

