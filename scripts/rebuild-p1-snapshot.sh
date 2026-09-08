#!/usr/bin/env bash
# Rebuilds the Phase 1 migration validation snapshot on a scratch database.
# - Deploys the committed baseline (old-schema data, like production today)
# - Seeds demo data + crafts edge-case fixtures for every backfill branch
# Usage: scripts/rebuild-p1-snapshot.sh postgresql://user:pass@host:port/db
set -euo pipefail
DB="${1:?usage: rebuild-p1-snapshot.sh DATABASE_URL}"
export DB

psql "$DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null

# Baseline-era client: stash the new schema so seeds run against old tables.
# Also hide post-baseline migrations so `deploy` stops at the baseline.
git stash push -q prisma/schema.prisma -m "p1-snapshot-tmp"
mkdir -p /tmp/p1_migration_hold
mv prisma/migrations/0001_* prisma/migrations/0002_* prisma/migrations/0003_* prisma/migrations/0004_* /tmp/p1_migration_hold/ 2>/dev/null || true
trap 'mv /tmp/p1_migration_hold/0001_* /tmp/p1_migration_hold/0002_* /tmp/p1_migration_hold/0003_* /tmp/p1_migration_hold/0004_* prisma/migrations/ 2>/dev/null; git stash pop -q; npx prisma generate >/dev/null 2>&1' EXIT
npx prisma generate >/dev/null 2>&1
DATABASE_URL="$DB" npx prisma migrate deploy >/dev/null
DATABASE_URL="$DB" npx tsx prisma/seed.ts | tail -n 1
DATABASE_URL="$DB" npx tsx prisma/launch-seed.ts | tail -n 1

psql "$DB" <<'EOF'
-- paid payment matching a real stake (stakeId backfill: provable)
INSERT INTO "Payment" (id, "stakeId", "elementId", "startupId", "amountUsd", path, provider, "providerRef", "idempotencyKey", status, "paidAt")
SELECT 'pay_match_au', 'pending', e.id, s."startupId", 88, 'take', 'whop', 'whop_ev_1', 'idem-au-1', 'paid', NOW() - INTERVAL '2 days'
FROM "Stake" s JOIN "Element" e ON e.id = s."elementId" JOIN "Startup" su ON su.id = s."startupId"
WHERE e.symbol='Au' AND su.domain='aurum.fi' LIMIT 1;
-- paid payment with NO matching stake (stays NULL for audit).
-- NOTE: the pair must genuinely have no stake row (aurum.fi holds Au/Pt only).
INSERT INTO "Payment" (id, "stakeId", "elementId", "startupId", "amountUsd", path, provider, "idempotencyKey", status, "paidAt")
SELECT 'pay_orphan', 'pending', e.id, su.id, 10, 'join', 'dev', 'idem-orphan-1', 'paid', NOW() - INTERVAL '5 days'
FROM "Element" e, "Startup" su WHERE e.symbol='H' AND su.domain='aurum.fi' LIMIT 1;
-- pending payment with sentinel (cleared to NULL)
INSERT INTO "Payment" (id, "stakeId", "elementId", "startupId", "amountUsd", path, provider, "idempotencyKey", status)
SELECT 'pay_pending', 'pending', e.id, su.id, 5, 'join', 'dev', 'idem-pending-1', 'pending'
FROM "Element" e, "Startup" su WHERE e.symbol='He' AND su.domain='hydro.dev' LIMIT 1;
-- duplicate unsubscribe token (dedupe repair)
UPDATE "Startup" SET "unsubToken" = (SELECT "unsubToken" FROM "Startup" WHERE domain='aurum.fi') WHERE domain='beta.acme.com';
-- stake with no payment/activity (claimedAt fallback branch)
DELETE FROM "ActivityLog" WHERE domain='gamma.tools';
-- dangling element leader (repaired to NULL before FK)
UPDATE "Element" SET "currentLeaderId"='ghost-startup' WHERE symbol='Fe';
-- report with stake but no startup (startupId backfill)
INSERT INTO "Report" (id, "stakeId", domain, reason) SELECT 'rep_1', s.id, NULL, 'spam listing' FROM "Stake" s LIMIT 1;
EOF
echo "snapshot ready: $(psql "$DB" -tAc 'SELECT count(*) FROM "Stake"') stakes, $(psql "$DB" -tAc 'SELECT count(*) FROM "Payment"') payments"
