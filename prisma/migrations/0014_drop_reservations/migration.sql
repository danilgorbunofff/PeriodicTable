-- Take-quote reservations are gone. The checkout quotes the takeover price
-- directly and settlement applies the amount that was paid, so nothing holds an
-- element between checkout and settlement any more. A same-moment race is
-- resolved by the ledger's deterministic tie order (earlier settled stake keeps
-- #1), not by a hold.
--
-- The table held only ephemeral holds — no money rows — so it is dropped
-- together with its enum. Dropping the table also removes the hand-written
-- partial unique index "ClaimReservation_elementId_active_key" that used to
-- refuse a second concurrent take.
DROP TABLE "ClaimReservation";

DROP TYPE "ReservationStatus";
