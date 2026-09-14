-- AlterEnum
-- Payments move from Whop to Stripe. The 'whop' value is deliberately retained:
-- existing Payment and ProviderEvent rows still carry it, and dropping a
-- Postgres enum value requires recreating the type — with those rows in scope.
ALTER TYPE "PaymentProvider" ADD VALUE 'stripe';
