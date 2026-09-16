-- R16-6, R16-7: the checkout's checkbox recorded nothing. A payment could be
-- refused for a missing tick, but a payment that went through carried no
-- evidence of which revision of the rules the payer was shown or agreed to —
-- and the revision that applied was whatever the deployment happened to be
-- running when someone later asked.
--
-- Three columns, not one: the version makes the record interpretable across a
-- rules change, the digest proves what the words were without storing them on
-- every payment, and the timestamp is when the gate accepted the tick. All
-- three are nullable because the rows already in the table predate the pass;
-- nothing backfills them, because inventing consent for an old payment is worse
-- than admitting there is none.
ALTER TABLE "Payment" ADD COLUMN "consentVersion" TEXT;
ALTER TABLE "Payment" ADD COLUMN "consentTextHash" TEXT;
ALTER TABLE "Payment" ADD COLUMN "consentAt" TIMESTAMP(3);
