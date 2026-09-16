-- CreateTable
-- R13-3: job liveness. The review measured the tick's cadence from GitHub's run
-- list — 34 runs in 110.12 h against a nominal 661, with gaps up to 6 h 40 m —
-- because nothing in the app could distinguish "the queue is empty" from "the
-- scheduler stopped weeks ago". /api/jobs/config reported ok throughout.
--
-- One row per job route, rewritten by the route itself on every run (`runs` is
-- the count of those runs, `lastError` the last failure's reason). The staleness
-- bounds live in lib/jobHeartbeat.ts and are derived from the two real
-- schedules: the ten-minute GitHub tick (measured worst gap 6 h 40 m) and the
-- daily Vercel backstop in vercel.json.
--
-- No index: five rows, read whole on every config call, and the row is a
-- singleton per key. Pruning is unnecessary for the same reason.
CREATE TABLE "JobHeartbeat" (
    "key" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runs" INTEGER NOT NULL DEFAULT 1,
    "lastError" VARCHAR(280),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobHeartbeat_pkey" PRIMARY KEY ("key")
);
