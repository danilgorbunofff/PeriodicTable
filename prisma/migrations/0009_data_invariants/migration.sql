-- AddConstraint (hand-written)
-- R12-1: the database held zero CHECK constraints, so every numeric promise in
-- the schema was kept by application code alone. `Stake.amountUsd`,
-- `Payment.amountUsd`, `Payment.providerAmount`, `Element.totalPoolUsd` and
-- `Element.stakeCount` were bare `integer NOT NULL`: the only negative-money
-- guard was a JS throw in lib/recompute.ts, and the only guard on the
-- denormalized trio was `assertLedgerInvariants` inside the writer's own
-- transaction. Both are bypassed by anything that writes this database without
-- going through lib/ — `npx prisma db seed`, scripts/backfill-previews.ts, a
-- psql session, a future admin tool.
--
-- These six constraints are the ones Postgres can express. The trio *sum* is
-- deliberately not here: a CHECK cannot aggregate another table, which is why
-- the drift detector (R12-2) exists instead.
--
-- Prisma's schema language cannot express CHECK either, so `schema.prisma`
-- carries a comment on each column naming the constraint that backs it (R12-6).
--
-- Deploy risk note: `ADD CONSTRAINT` validates the rows already present, so on
-- a populated database a pre-existing violation fails the deploy rather than
-- being silently accepted. Run these two pre-flight queries against the target
-- first; both must return 0. The first is the R12-1 reproduction itself, the
-- second is the only invariant the refund pair could already have broken.
--   SELECT count(*) FROM "Payment" WHERE "amountUsd" < 0 OR "providerAmount" < 0;
--   SELECT count(*) FROM "Payment" WHERE ("status" = 'refunded') <> ("refundedAt" IS NOT NULL);
-- If either is non-zero, repair the rows (an operator decision, see
-- lib/erasure.ts and ops/rollback.md for the manual paths) before deploying.
ALTER TABLE "Stake" ADD CONSTRAINT "Stake_amountUsd_nonnegative" CHECK ("amountUsd" >= 0);

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amountUsd_nonnegative" CHECK ("amountUsd" >= 0);

-- providerAmount is written from the provider's own answer, so it is the one
-- number our own arithmetic could not have invented (R12-1).
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_providerAmount_nonnegative" CHECK ("providerAmount" IS NULL OR "providerAmount" >= 0);

-- The refund pair — lib/settle.ts writes both halves together (R08-2): a
-- payment is REFUNDED exactly while it carries the moment the reversal was
-- applied. Either half alone is a lie an operator reading the ledger cannot
-- detect: REFUNDED with no timestamp cannot be reconciled against the
-- provider's settlement report, and a timestamp on a non-refunded row says
-- money came back when it did not. Written as a biconditional so neither half
-- can drift.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_refundedAt_matches_status" CHECK (("status" = 'refunded') = ("refundedAt" IS NOT NULL));

ALTER TABLE "Element" ADD CONSTRAINT "Element_totalPoolUsd_nonnegative" CHECK ("totalPoolUsd" >= 0);

ALTER TABLE "Element" ADD CONSTRAINT "Element_stakeCount_nonnegative" CHECK ("stakeCount" >= 0);
