-- AlterTable
-- R08-7: a provider delivery must survive the deletion of the payment it
-- describes. "paymentId" is ON DELETE SET NULL, so a deleted payment left a
-- register row that could no longer say which element or startup the delivery
-- concerned. These columns are copied at write time and are never cleared.
-- Deliberately no foreign keys: elements and startups are edited and cleared by
-- demo scripts, and the register is a historical record, not a live reference.
ALTER TABLE "ProviderEvent" ADD COLUMN     "elementId" INTEGER;
ALTER TABLE "ProviderEvent" ADD COLUMN     "startupId" TEXT;

-- Backfill (same shape as 0003's): every register row whose payment still
-- exists keeps its subject, so the fix covers the deliveries already recorded —
-- including the orphaned ones §5.7 describes, whose payment is gone and which
-- therefore stay NULL. That is why the columns are also written at write time.
UPDATE "ProviderEvent" pe
   SET "elementId" = p."elementId",
       "startupId" = p."startupId"
  FROM "Payment" p
 WHERE pe."paymentId" = p.id;

-- CreateIndex
-- R08-3: the operator report scans for ERROR rows older than a deadline.
CREATE INDEX "ProviderEvent_outcome_createdAt_idx" ON "ProviderEvent"("outcome", "createdAt");
