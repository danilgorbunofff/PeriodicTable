-- R18-1, R18-10: the error sink. Nothing durable recorded a 500, a crashed
-- render, or a client-boundary throw — only a platform log line, whose retention
-- on this plan is about an hour, so an incident that began at 03:00 was
-- unreadable by 04:30 and "check the logs" was advice with an unstated expiry.
--
-- One row per distinct failure, not per occurrence: `fingerprint` is a hash of
-- source|kind|message|route and the writer collapses repeats inside a minute
-- into `occurrences` on the existing row, so a crash loop cannot fill the table
-- (lib/errorReport.ts). `createdAt DESC` answers "what broke just now", the only
-- question this table is asked at 03:00; the composite index answers "is this
-- still happening" for one known failure.
--
-- Nullable except the four fields a report cannot be made of nothing without
-- (`source`, `message`, `fingerprint`, `occurrences`): a client boundary has no
-- stack, a process-level report has no route, and a row missing what the reporter
-- could not know is honest about it. No trimming job here — R18-15 is explicit
-- that this table is the durable substitute for the ~1 h log window, so deleting
-- from it is an operator decision, not a scheduled one.
CREATE TABLE "ErrorReport" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "route" TEXT,
    "digest" TEXT,
    "fingerprint" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "deploy" TEXT,
    "env" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErrorReport_createdAt_idx" ON "ErrorReport"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "ErrorReport_fingerprint_createdAt_idx" ON "ErrorReport"("fingerprint", "createdAt");
