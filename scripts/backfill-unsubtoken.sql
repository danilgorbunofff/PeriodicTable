-- Pre-push backfill: add unsubToken nullable, populate, so the required-with-default push can run
ALTER TABLE "Startup" ADD COLUMN IF NOT EXISTS "unsubToken" TEXT;
UPDATE "Startup" SET "unsubToken" = 'unsub-' || substr(md5(random()::text), 1, 24) WHERE "unsubToken" IS NULL;
