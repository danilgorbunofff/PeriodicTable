-- AlterTable
-- R10-11: delivery knows the outbox row's dedupe key and the provider's answer;
-- the log did not. Without the key a failed mail could not be tied back to the
-- queue row an operator retries, and without the provider status the log could
-- say "error" but never what the provider said.
ALTER TABLE "EmailLog" ADD COLUMN     "dedupeKey" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN     "providerMessageId" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN     "providerStatus" INTEGER;
ALTER TABLE "EmailLog" ADD COLUMN     "error" TEXT;
-- Existing rows were written before the column existed: their creation time is
-- the best answer we have, and every new write sets it explicitly.
ALTER TABLE "EmailLog" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
-- R10-1: the operator report scans for unresolved failures by key and status.
CREATE INDEX "EmailLog_dedupeKey_idx" ON "EmailLog"("dedupeKey");
CREATE INDEX "EmailLog_status_idx" ON "EmailLog"("status");

-- CreateTable
-- R10-5: the suppression list, keyed on the address because the address is what
-- a person controls. Unsubscribing used to clear Startup.email, which is a
-- delivery address rather than a permission — the next payment carrying the same
-- address re-mailed it. `token` is the handle every message to that address
-- carries: the footer token used to be the listing's (Startup.unsubToken), which
-- resolved to nothing whenever the message went to payment.email instead.
-- `reason` is null while the address may be mailed.
CREATE TABLE "EmailAddress" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailAddress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailAddress_email_key" ON "EmailAddress"("email");
CREATE UNIQUE INDEX "EmailAddress_token_key" ON "EmailAddress"("token");
CREATE INDEX "EmailAddress_reason_idx" ON "EmailAddress"("reason");

-- AlterTable
-- R10-6: the waitlist had no way to leave it. The row is kept and stamped
-- rather than deleted: a later re-join must be distinguishable from a first.
ALTER TABLE "WaitlistEntry" ADD COLUMN     "unsubscribedAt" TIMESTAMP(3);
