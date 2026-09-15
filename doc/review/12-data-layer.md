# 12 — Data layer

| Field | Value |
| --- | --- |
| Phase · batch | 12 — Data layer · 3 |
| Status | draft — all 7 migrations replayed twice onto an empty PostgreSQL 16, seeded, and read back through 9 query plans; no fixes (read-only batch) |
| Date reviewed | 2026-09-15 |
| Commit reviewed | `9681bdc` |
| Reviewer | review agent |

| Probe not run | Why | Residue |
| --- | --- | --- |
| Live-Neon migration status and row counts | Needs production credentials; `doc/PROD-READINESS-CHECKLIST.md:316` (± §7) already holds a read-only production inventory — cited, not repeated | U12-2 |
| Replay onto a **copy of production** | The plan asks for it; it needs a dump of live data and a database to restore into, and this checkout has neither credentials nor the ability to create one. The replay therefore ran onto an **empty** database (§5.4), which proves the migrations apply and are self-consistent but *not* that they apply cleanly over the production rows | U12-4 |
| Neon PITR **restore drill** | Destructive by construction (it provisions a branch or overwrites the primary) and operator-run. The plan asks for a dated drill result, not a plan; this doc can only state the exact commands and the fact that they are unrun — see §5.14 and U12-1 | U12-1 |
| A migration applied while the app serves traffic | Would need two deployments against a shared database; the lock and timeout behaviour in §6 is read from the generated SQL, not observed | U12-5 |
| Long-run drift and PII growth | The scratch database is hours old and holds probe residue, so its counts are not production's shape and its `pg_stat_user_indexes` counters are not production's traffic (§5.6) | U12-3 |

## 1. Scope

Owns L4 for S1 and the storage half of S6–S7: what `prisma/schema.prisma` promises, what actually enforces each promise, how the seven migrations get a database there, what the seeds write, what happens to a customer's personal data over time, and whether a backup can be restored.

Not owned here: who may read or write these tables (`11` maps the routes, `14` the attacker's access), the money *rules* that drive the writes (`06`, `08`), the aggregate code's semantics (`08` owns `lib/recompute.ts` and `lib/pricing.ts`; this doc checks only the stored result), mail behaviour (`10`), query latency under load and the cost of the database (`15`), and the runbook for restoring from a backup (`17`).

Inspected: `prisma/schema.prisma` in full; `prisma/migrations/0000_baseline` … `0006_stripe_provider` including `migration_lock.toml`; `prisma/seed.ts`, `prisma/launch-seed.ts`, `prisma/fill-table.ts`, `lib/demoData.ts`, `scripts/clear-demo-data.ts`, `scripts/migrate-if-production.mjs`, `scripts/backfill-previews.ts`; `lib/prisma.ts`, `lib/testDb.ts`; `lib/recompute.ts` (the trio's writer); `package.json` `scripts`; `HANDOFF.md:636-672`.

The data layer is the one layer this review can hold still. The HTTP surface moves with the deployment's environment and the UI moves with the browser, but a schema is a text file and a migration is deterministic SQL — so almost every claim below is a re-run, not an observation of a live system (§5).

## 2. Actors

| Actor | How it touches the data |
| --- | --- |
| Public reader | `/api/board`, `/api/elements`, `/api/elements/[sym]`, `/api/stats`, `/api/table-order`, `/api/activity` — all `SELECT`-only, all served from the same pooled `DATABASE_URL` (`lib/prisma.ts:5-9`) |
| Bidder | `POST /api/checkout` creates one `Payment` per idempotency key and one `ClaimReservation` per element — the two tables whose uniques are the concurrency control |
| Holder | `PATCH /api/startups/[domain]` updates `Startup.title/pitch/url/logoUrl`; the only writer of `Startup` outside the ledger |
| Settle path | `lib/settle.ts` in a `MONEY_TX` serializable transaction: `Payment` → `Stake` → the `Element` trio → `ActivityLog` → `FirstClaim` → `OutboxEvent`, or none of them |
| Outbox worker | `/api/jobs/outbox` claims rows by lease, writes `EmailLog`, and is the only place `OutboxEvent.attempts` moves |
| Operator | `/api/admin/*`: reads `Report`, writes `Report.status/note/reviewedBy` and `Startup.moderationState`; `admin/outbox/retry` re-arms `OutboxEvent` |
| Seeder | `prisma/seed.ts` (demo, 8 startups, 26 mock stakes, **no environment guard**) and `prisma/launch-seed.ts` (9 real-company domains, no money, no email, no token) — `lib/demoData.ts:6-17` |
| Migration · build | `prisma migrate deploy` via `scripts/migrate-if-production.mjs`, which runs it only when `VERCEL_ENV === "production"` |
| Restorer | whoever holds the Neon console at 03:00 — the actor §5.14 exists to prepare for and who nobody has rehearsed |

## 3. Intended behaviour — the promise list

Written as statements a reader can falsify, each with the constraint that enforces it. "Enforced" below means *the database refuses the write*, which is the only kind of enforcement that survives a second writer, a manual `psql` session, or a bug in `lib/`.

| # | Promise | Enforced by | Where |
| --- | --- | --- | --- |
| P1 | One row per element, ids fixed (`1..118`, `-1` Hbar, `0` Ps, `119` Uue, `999` DM) | `Element_pkey`; no autoincrement, so the id is a decision not a sequence | `prisma/schema.prisma:100`; `prisma/migrations/0000_baseline/migration.sql:11-26` |
| P2 | One element per symbol | `Element_symbol_key` | `0000_baseline:128` |
| P3 | One listing per domain — and therefore one owner per domain | `Startup_domain_key` | `0000_baseline:137` |
| P4 | One cumulative stake per (element, listing); a re-bid is an `increment`, never a second row | `Stake_elementId_startupId_key` | `0000_baseline:143`; written at `lib/recompute.ts:204-207` |
| P5 | At most one **active** take-lead quote per element | `ClaimReservation_elementId_active_key` — a **partial** unique index, `WHERE status = 'active'` | `0001_phase1_ownership/migration.sql:280`; not expressible in Prisma (`schema.prisma:205-206` says so) |
| P6 | One quote per payment | `ClaimReservation_paymentId_key` | `0001_phase1_ownership:172` |
| P7 | One payment per client idempotency key — a retried checkout returns the first row, never a second charge | `Payment_idempotencyKey_key` | `0000_baseline:149` |
| P8 | One payment per provider session | `Payment_providerRef_key` (nullable; Postgres uniques ignore NULLs) | `0000_baseline:146`; `schema.prisma:182` |
| P9 | One apply per provider event, across providers | `Payment_providerEventId_key` **and** `ProviderEvent_providerEventId_key` (the column is `"{provider}:{event-id}"`, `schema.prisma:320-322,326`) | `0000_baseline:214`, `0002_phase2_webhook:20` |
| P10 | One outbox row per event, however many times it is enqueued | `OutboxEvent_dedupeKey_key` | `0001_phase1_ownership:196` |
| P11 | One waitlist row per address | `WaitlistEntry_email_key` | `0001_phase1_ownership:193` |
| P12 | One first-claimer per element, and the claim cannot be re-pointed at a second stake | `FirstClaim_pkey` (on `elementId`) **and** `FirstClaim_stakeId_key` | `0001_phase1_ownership:205`; `schema.prisma:286-291` |
| P13 | One management secret per hashed token | `ManageToken_tokenHash_key`, `ManageSession_tokenHash_key` | `0001_phase1_ownership:181,187` |
| P14 | One link per unsubscribe token | `Startup_unsubToken_key` | `0001_phase1_ownership:223` |
| P15 | `Startup.title` and `Startup.pitch` cannot exceed the UI's box | `@db.VarChar(32)` / `(140)` **and** the validator's identical bounds | `schema.prisma:125-126`; `lib/validate.ts:96-101` |
| P16 | `Report.note` fits the triage form; `Report.reason` fits the report form | `@db.VarChar(500)` / `(280)` | `schema.prisma:389,385`; `0004_phase6_ops/migration.sql:2` |
| P17 | Free-text `Report`/`Startup` text cannot be nulled into a broken page | `Report.reason` and `Startup.{domain,title,pitch,url,logoUrl}` are `NOT NULL` | `schema.prisma:124-129,385` |
| P18 | Money is a whole number of dollars, never a float | column type `integer` on all six money columns | §5.9 (catalog read) |
| P19 | `Element.totalPoolUsd`, `.stakeCount`, `.currentLeaderId` equal what `Stake` says | **nothing, at the database level** — maintained by `rerankElementTx` in the same transaction as the stake write (`lib/recompute.ts:85-108`), checked by `assertLedgerInvariants` before that write (`lib/recompute.ts:97`) | §5.8, R12-1, R12-2 |
| P20 | `Stake.rank`/`isLeader` agree with `amountUsd` order | **nothing, at the database level** — same writer, same assertion | §5.8, R12-1 |
| P21 | A stake total is never negative | **nothing** — `Stake.amountUsd` is an unconstrained `integer`; the guard is a thrown JS error one layer up (`lib/recompute.ts:146-148`) | §5.9, R12-1 |
| P22 | `EmailLog.status` is one of `sent`, `suppressed`, `error` | **nothing** — plain `String` with default `"sent"`, and the code writes a fourth value | `schema.prisma:371`; §5.11, R12-3 |
| P23 | A payment cannot be deleted out from under its quote, its audit trail, or its provider events | `ON DELETE RESTRICT` on those three FKs | `0001_phase1_ownership:301,325`, `0002_phase2_webhook:24` |
| P24 | An element or a listing cannot be deleted out from under money | `ON DELETE RESTRICT` from `Stake`, `Payment`, `ClaimReservation`, `FirstClaim` to `Element`/`Startup` | `0000_baseline:167,170`; `0001_phase1_ownership:289,292,295,298,310,313` |
| P25 | Deleting a listing does not delete the ledger | `ON DELETE SET NULL` on `Element.currentLeaderId`, `Payment.stakeId`, `FirstClaim.stakeId`, `AuditLog.*`, `Report.{stakeId,startupId}`, `ProviderEvent.paymentId`, `ActivityLog.paymentId` | §5.7 |
| P26 | Every read pattern the API uses has an index it could use | 15 indexes, listed in §5.6 against the 9 measured plans | §5.6 |
| P27 | A customer's personal data can be found, exported, and deleted | **only found.** No export and no deletion path exists for any real row | §5.12, R12-4 |
| P28 | A backup can be restored | Neon PITR is available on the plan and nothing about it has ever been exercised | §5.14, U12-1 |

Three of those (P19–P21) are the ones that matter commercially, and they are the three that live only in application code. That asymmetry is the shape of this doc: the invariants the product sells are the invariants the database does not know about.

## 4. The path walked

1. `npm ci` → 463 packages (Node v24.13.0, Prisma 6.19.3).
2. Throwaway PostgreSQL: `docker run -d --name ptl-review-pg-55440 -e POSTGRES_PASSWORD=… -p 55440:5432 postgres:16-alpine`, databases `ptl_review` and `ptl_review_test`.
3. `DATABASE_URL=…/ptl_review npx prisma migrate deploy` — **twice**, the second time from a dropped-and-recreated database, to prove the replay is repeatable and ordered. Then `npx prisma generate`.
4. `prisma/seed.ts` → `seed ok: 122 elements, 8 startups, 26 stakes, 26 activity rows`; `prisma/launch-seed.ts` → `launch-seed ok: 122 elements, 9 startups, 27 stakes`.
5. Catalog reads and integrity SQL through `psql` in the container (`Get-Content x.sql -Raw | docker exec -i … psql -U postgres -d ptl_review`; `-c` breaks on the PascalCase identifiers this schema uses, `04` §5.4 hit the same thing).
6. `EXPLAIN ANALYZE` over the nine read paths the API actually issues (§5.6).
7. `npx prisma migrate diff --from-url <scratch> --to-schema-datamodel prisma/schema.prisma --script` → **"This is an empty migration."** (§5.4) — the schema file and the migrated database agree, which is the proof that the migration set is the baseline rather than a story about one.
8. Concurrent probes on the same database wrote probe residue (`conc*.dev`, `acme-probe.dev`, an 8-stake element). Counts in §5.1 are therefore labelled as *the scratch database*, not as production's shape.

Read-only throughout: no production connection, no destructive statement, no provider call.

## 5. Live evidence

### 5.1 Inventory

16 models, 9 enums (`prisma/schema.prisma`). Model counts, one line each:

| Model | Rows here | Its one interesting column |
| --- | --- | --- |
| `Element` | 122 | the trio — `totalPoolUsd`, `stakeCount`, `currentLeaderId` (`:108-110`) |
| `Startup` | 15 | `unsubToken` — a bearer secret that is also a `@unique` default `cuid()` (`:132`) |
| `Stake` | 34 | `amountUsd` is **cumulative**, so re-bids are increments (`:156`) |
| `Payment` | 7 | `idempotencyKey`, `providerRef`, `providerEventId` — three uniques (`:182-187`) |
| `ClaimReservation` | 0 | the partial-index column `status` |
| `ManageToken` | 12 | `tokenHash` only — the raw token is never stored (`:236`) |
| `ManageSession` | 0 | same discipline for the session (`:251`) |
| `WaitlistEntry` | 11 | `email` is the primary key in practice (`:260`) |
| `OutboxEvent` | 115 | `attempts`, `nextAttemptAt`, `lastError`, `dedupeKey` |
| `FirstClaim` | 26 | `source`/`confidence` are open strings, not enums (`:295-296`) |
| `AuditLog` | 35 | `action` is an open vocabulary by design (`:304`) and `detail` is free text |
| `ProviderEvent` | 7 | `payload` keeps the whole provider body (`:332`) |
| `ActivityLog` | 34 | `deltaUsd`/`resultTotalUsd` are nullable **on purpose** (`:343-344`) |
| `ClickEvent` | 0 | not written by any shipped code path (§6) |
| `EmailLog` | 32 | `status` — see R12-3 |
| `Report` | 14 | `ipHash`, `note` |

The two headline tables are `Element` (fixed size, 122 rows, never grows) and `Stake` (grows with money). `Payment`, `ProviderEvent`, `AuditLog`, `ActivityLog`, `EmailLog` all grow monotonically and none of them is ever pruned — that is the retention question of §5.12.

### 5.2 The enum case split — 7 lowercase, and the 2 that are not are the public ones

Read from `pg_enum`, not from the file (2026-09-15, scratch DB):

```
 ChemicalFamily       | ALKALI_METAL,ALKALINE_EARTH,…,EXOTIC_THEORETICAL
 PrestigeTier         | STANDARD,CULTURAL_ELITE,EXOTIC
 ModerationState      | visible,hidden,unlisted
 PaymentPath          | take,join,stake,reclaim
 PaymentProvider      | whop,dev,stripe
 PaymentStatus        | pending,paid,failed,refunded,canceled
 ProviderEventOutcome | received,applied,duplicate,ignored,failed,error,refunded
 ReportStatus         | open,triaged,actioned,dismissed
 ReservationStatus    | active,consumed,expired,canceled
```

Seven of nine carry `@map("…")` to a lowercase label; `ChemicalFamily` and `PrestigeTier` (`schema.prisma:17-35`) have no `@map`, so they store uppercase. Those two are exactly the pair the public board reads, and the consequence is visible on the wire in one command against the running app:

```
$ curl.exe -sS "http://127.0.0.1:3215/api/elements" | head -c 200
[{"symbol":"Hbar","name":"Antihydrogen","gridRow":2,"gridCol":8,
  "family":"EXOTIC_THEORETICAL","tier":"EXOTIC","pool":0,"count":0,"leader":null}, …

$ curl.exe -sS "http://127.0.0.1:3215/api/activity?limit=2"
[{"id":"…","domain":"conc1.dev","elementSymbol":"C",
  "elementName":"Carbon","delta":5,"total":5,"kind":"join", …
```

Same API, same database, same day: `family`/`tier` uppercase, `kind` lowercase. `kind` comes from a plain `String` column (`ActivityLog.kind`, `schema.prisma:345` — default `"stake"`), so its case is a convention in code; `family` is an enum, so its case is a Postgres type. Lowercase-on-disk is confirmed directly for the `@map`'d set:

```
 ActivityLog.kind      | join             |    12
 ActivityLog.kind      | stake            |    22
 Payment.path          | join             |     6
 Payment.path          | take             |     1
 Payment.status        | paid             |     7
 ProviderEvent.outcome | applied          |     7
 Report.status         | open             |    14
 ModerationState       | visible          |    15
 FirstClaim.source     | ledger           |     2
 FirstClaim.source     | seed             |    24
```

The trap has a second edge that only an operator meets: `/api/admin/reports?status=` casts its input to the **uppercase TypeScript member** (`app/api/admin/reports/route.ts:14`, `status as "OPEN" | "TRIAGED" | "ACTIONED" | "DISMISSED"`), because that is what Prisma wants — while the same value in `psql` is `open`. An operator who copies the value out of the database into the query string gets a Prisma error, and one who copies the query string into `psql` gets an invalid enum. `11` R11-6 records the missing validation; R12-7 below records the inconsistency itself.

The wire vocabulary is also a *rename*, not a projection: `totalPoolUsd` → `pool`, `stakeCount` → `count`, `amountUsd` → `amount`/`total`/`delta`, `domain` → `leader.domain`. No route sends a raw column name, and no shared type maps the two, so `lib/contracts.test.ts:63` is the only place a wire name is pinned (`kind: "reclaim"`, lowercase — the convention survives as a test fixture, not as a document).

### 5.3 Integrity reads

All on 2026-09-15 against the scratch database, after replay + seed + probe residue.

**Aggregate trio (P19). Zero drift.**

```sql
SELECT e.id, e.symbol, e."totalPoolUsd", s.tot, e."stakeCount", s.cnt, e."currentLeaderId", s.leader
FROM "Element" e LEFT JOIN LATERAL (…) s ON TRUE
WHERE e."totalPoolUsd" <> s.tot OR e."stakeCount" <> s.cnt
   OR COALESCE(e."currentLeaderId",'~') <> COALESCE(s.leader,'~');
 id | symbol | totalPoolUsd | tot | stakeCount | cnt | currentLeaderId | leader
----+--------+--------------+-----+------------+-----+-----------------+--------
(0 rows)
```

**Leader cache (P20). Zero drift** — every element has at most one `isLeader` stake, and no stake is flagged leader unless its startup is the element's `currentLeaderId`:

```
 stake-isLeader but not element leader |       0
```

**Partial index is real (P5):**

```
 ClaimReservation_elementId_active_key | CREATE UNIQUE INDEX … ON public."ClaimReservation"
    USING btree ("elementId") WHERE (status = 'active'::"ReservationStatus")
```

**Stakes per element:** 24 elements carry one stake, 1 carries two, 1 carries eight (the concurrency probe's element). That distribution is the reason every plan in §5.6 is a `Seq Scan` — see the caveat there.

### 5.4 Migrations 0000–0006, replayed

```
 == migrations applied ==
 0000_baseline         | 2026-09-15 07:17
 0001_phase1_ownership | 2026-09-15 07:17
 0002_phase2_webhook   | 2026-09-15 07:17
 0003_phase3_activity  | 2026-09-15 07:17
 0004_phase6_ops       | 2026-09-15 07:17
 0005_refund_reversals | 2026-09-15 07:17
 0006_stripe_provider  | 2026-09-15 07:17
```

`prisma migrate deploy` against an empty `ptl_review` applied all seven in order, and the same command against a dropped-and-recreated database applied them again identically — no ordering dependency, no data-dependent branch. The set in order: `0000` builds the eleven original tables and their indexes (5 168 B); `0001` adds the ownership half — `ClaimReservation`, `ManageToken`, `ManageSession`, `WaitlistEntry`, `OutboxEvent`, `FirstClaim`, `AuditLog`, the partial index, and 22 foreign keys (14 112 B — by far the largest, and the only one that is hand-shaped); `0002` adds `ProviderEvent`; `0003` adds the activity delta pair **and backfills** (`UPDATE "ActivityLog" SET "resultTotalUsd" = "amountUsd" WHERE "resultTotalUsd" IS NULL` — exact for history, `deltaUsd` left NULL where the delta is unknowable, which is the honest choice); `0004` adds one column (`Report.note`, 75 B); `0005` adds the `refunded` outcome and `Payment.refundedAt`; `0006` adds the `stripe` value and **keeps `whop`**.

`0006` is worth quoting because it is the doc's one example of a migration that was *thought about*:

```sql
-- Payments move from Whop to Stripe. The 'whop' value is deliberately retained:
-- existing Payment and ProviderEvent rows still carry it, and dropping a Postgres
-- enum value requires recreating the type — with those rows in scope.
ALTER TYPE "PaymentProvider" ADD VALUE 'stripe';
```

`schema.prisma:54-64` repeats the reasoning and adds the consequence that is not obvious from the SQL: Prisma throws when it reads an enum value it cannot deserialize, so dropping `whop` would not merely strand four production rows, it would make every `findMany` that touches them fail. This schema states its own traps in comments; the cost is that a comment is not a constraint (R12-6).

**The schema file and the database agree.** `npx prisma migrate diff --from-url $DATABASE_URL --to-schema-datamodel prisma/schema.prisma --script` → `-- This is an empty migration.` That is a stronger statement than "the migrations ran": it says the seven migrations, applied in order, land on exactly the state `schema.prisma` describes — no drift accumulated across six feature migrations. It also settles R12-6's premise, in the direction that is *good* for the project: Prisma's differ does not propose dropping the hand-written partial index, so `migrate dev` will not silently remove it. The index is invisible to the schema in **both** directions, which is why §6 keeps a row for the `db push` case.

Build-time behaviour: `package.json` `build` is `prisma generate && node scripts/migrate-if-production.mjs && next build`, and the script runs `prisma migrate deploy` **only** when `VERCEL_ENV === "production"` — with two refusals that matter more than the happy path: `VERCEL=1` with no `VERCEL_ENV` exits 1 ("we cannot tell prod from preview, and the safe reading of *cannot tell* is to refuse"), and `VERCEL_ENV=production` with no `DATABASE_URL` exits 1. A failed migration fails the build. `doc/PROD-READINESS-CHECKLIST.md:16` owns the history of why this is a build script rather than a Vercel `buildCommand`; nothing here changes it, and `DATABASE_URL` is still scoped **Production and Preview** against one Neon database — citable at `HANDOFF.md:671` and `scripts/migrate-if-production.mjs:3-8`, which now explains why that shared scope no longer matters for migrations.
### 5.5 Uniques

32 unique indexes exist in `public` — 16 primary keys and 16 business uniques:

`Element_symbol_key`, `Startup_domain_key`, `Startup_unsubToken_key`, `Stake_elementId_startupId_key`, `Payment_providerRef_key`, `Payment_providerEventId_key`, `Payment_idempotencyKey_key`, `ClaimReservation_paymentId_key`, **`ClaimReservation_elementId_active_key`** (partial), `ManageToken_tokenHash_key`, `ManageSession_tokenHash_key`, `WaitlistEntry_email_key`, `OutboxEvent_dedupeKey_key`, `FirstClaim_stakeId_key`, `ProviderEvent_providerEventId_key`.

Two of them are nullable and therefore weaker than they look, which is fine but should be said out loud: `Payment_providerRef_key` and `Payment_providerEventId_key` do not constrain the `PENDING` rows that have no provider session yet (`schema.prisma:182-183` — "nullable until paid"), and `ClaimReservation_elementId_active_key` constrains only rows whose status **is** `active`. That is the point of it, and it is the single most load-bearing constraint in the schema, because it is what makes "one guaranteed quote per element" true under concurrency rather than merely likely (P5).

### 5.6 Indexes against the query patterns

The plan asks for indexes "against the actual query patterns". Both halves are below: the pattern the API issues, and what Postgres chose to do with it on 2026-09-15.

| # | Pattern (route) | Index that should serve it | What the planner did (rows, exec) |
| --- | --- | --- | --- |
| Q1 | board crowns: leaders joined to visible listings (`/api/board?tab=by-element`) | `Startup_domain_key`, then `Stake_elementId_startupId_key` | Hash Join, **26 rows**, 0.532 ms — Seq Scan both sides |
| Q2 | element page stakes by element, amount desc (`/elements/[sym]`, `/api/elements/[sym]`) | `Stake_elementId_amountUsd_idx` (the only composite in the schema, `0000_baseline:140`) | Sort then Seq Scan, **8 rows**, 0.539 ms |
| Q3 | element page hidden-stake count | none — a join filtered by `moderationState` | Nested Loop, 0 rows, 0.113 ms |
| Q4 | `/api/stats` claimed-element count via `EXISTS` | `Stake_elementId_startupId_key` | Nested Loop + HashAggregate, 26 rows, 0.581 ms |
| Q5 | `/api/stats` aggregate over every stake | none (`Stake` full scan by design — it is the whole board) | Aggregate, **34 rows**, 0.076 ms |
| Q6 | `/api/table-order` every stake of a visible listing | **does not exist** — no index on `Stake.startupId` alone | Hash Join, 34 rows, 0.340 ms |
| Q7 | reconcile: paid payments newest first | `Payment_startupId_status_idx` (leading column unusable for this order) | Sort then Seq Scan, 7 rows, 0.188 ms |
| Q8 | activities: stake lookup by `(elementId, startupId)` pairs | `Stake_elementId_startupId_key` ✓ | Seq Scan, 0 rows, 0.046 ms |
| Q9 | admin report list, newest first, limit 50 | `Report_createdAt_idx` (desc) | Limit → Sort → Seq Scan, 14 rows, 0.119 ms |

**Read this table as a design review, not a benchmark.** Every plan is a `Seq Scan` because every table is between 0 and 34 rows: at that size a sequential scan is faster than an index descent and the planner is right to choose it. What the table can honestly say is (a) each hot path has *some* index that could serve it, and (b) two do not — Q6 has no index on `Stake.startupId` at all, and Q7's `Payment_startupId_status_idx` cannot serve an `ORDER BY paidAt DESC` scan. Neither is a problem at 34 rows; both become one at the first thousand, and `15` owns the point at which that happens.

The scan counters from `pg_stat_user_indexes` (same day, same database) say the same thing from the other side — this is *which indexes the workload actually chose*, with the caveat that a database hours old with probe traffic is not production:

| Index | Scans | Reads |
| --- | --- | --- |
| `Element_pkey` | 582 | 656 |
| `Startup_pkey` | 344 | 344 |
| `Stake_elementId_startupId_key` | 276 | 259 |
| `OutboxEvent_pkey` | 150 | 178 |
| `FirstClaim_pkey` | 139 | 113 |
| `OutboxEvent_dedupeKey_key` | 118 | 20 |
| `Startup_domain_key` | 84 | 60 |
| `Stake_pkey` | 77 | 77 |
| `Element_symbol_key` | 38 | 42 |
| `OutboxEvent_type_completedAt_idx` | 31 | 92 |
| `ActivityLog_createdAt_idx` | 10 | 47 |
| `ProviderEvent_providerEventId_key` | 9 | 0 |
| `Payment_startupId_status_idx` | 6 | 0 |

Zero scans: `Stake_elementId_amountUsd_idx`, `Element_family_idx`, `Element_tier_idx`, every `Report_*`, every `AuditLog_*`, every `ClickEvent_*`, every `EmailLog_*`, `Payment_providerRef_key`, `Payment_providerEventId_key`, `Startup_unsubToken_key`, and the `ClaimReservation_*` triple beyond what the probes touched. That list is **not** a list of unused indexes: it is the list of indexes whose tables are too small to use them yet (`ClaimReservation` 0 rows, `ClickEvent` 0, `EmailLog` 32). The index a reader should actually worry about is the inverse case — Q6's missing `Stake.startupId` index — because that one grows with the product's own success.

### 5.7 Relation delete behaviour

The delete graph, read from the generated SQL rather than from Prisma's defaults (`RESTRICT` is not Prisma's default — these were chosen):

| Parent → child (column) | On delete | Where |
| --- | --- | --- |
| `Element.currentLeaderId` → `Startup` | **SET NULL** | `0001:283` |
| `Payment.stakeId` → `Stake` | **SET NULL** | `0001:286` |
| `FirstClaim.stakeId` → `Stake` | **SET NULL** | `0001:316` |
| `AuditLog.startupId / elementId / paymentId` | **SET NULL** ×3 | `0001:319,322,325` |
| `Report.stakeId / startupId` | **SET NULL** ×2 | `0001:331,334` |
| `ProviderEvent.paymentId` | **SET NULL** | `0002:24` |
| `ActivityLog.paymentId` | **SET NULL** | `0003:12` |
| `Stake.elementId / startupId` | RESTRICT | `0000:167,170` |
| `Payment.elementId / startupId` | RESTRICT | `0001:289,292` |
| `ClaimReservation.elementId / startupId / paymentId` | RESTRICT | `0001:295,298,301` |
| `ManageToken.startupId`, `ManageSession.startupId` | RESTRICT | `0001:304,307` |
| `FirstClaim.elementId / startupId` | RESTRICT | `0001:310,313` |
| `ClickEvent.stakeId` | RESTRICT | `0001:328` |

The split is coherent and it is the right one: **money and identity RESTRICT; history and provenance SET NULL.** You cannot delete a listing that has ever taken money, and you cannot delete one that only leaves audit trails either — `Payment.startupId` is RESTRICT, so in practice nothing in this schema can be deleted once a payment exists. That makes "delete a customer's data on request" (§5.12, R12-4) a *schema-shaped* problem, not merely a missing script.

`scripts/clear-demo-data.ts:172-200` is the one deleter, and it exists precisely because deletion is blocked: it walks children first, runs `recomputeElement` for every affected element **between** the stake deletes and the listing delete (`Element.currentLeaderId` references `Startup`, which is why that order is forced), and refuses any listing that has acquired a real signal (`lib/demoData.ts:33-47`: an email on file, a payment, a manage token, a manage session). Its default mode is a dry run that rolls the whole transaction back. That is the highest-quality data-handling code in the repository and it is the reason R12-4 is a gap about *customers*, not about competence.

### 5.8 The denormalized aggregate trio

`Element.totalPoolUsd`, `Element.stakeCount`, `Element.currentLeaderId` are a cache of `Stake`, and the design is defensible: the board reads 122 elements and would otherwise aggregate 122 times per request. The doc's job is to say what keeps it honest.

- **One writer.** `rerankElementTx` (`lib/recompute.ts:65-113`) re-ranks every stake on the element, writes `rank`/`isLeader` per row (`:85-89`), computes `totalPoolUsd` (`:93`), asserts the invariants against `assertLedgerInvariants` (`:97-101`), and then updates the element with all three (`:104-108`). It runs inside the caller's transaction, so the trio and the stakes commit together or not at all.
- **One cost.** It rewrites every stake row of the element on every mutation — O(stakes on that element) write amplification per bid, which is fine at 8 and is `09`/`15`'s question at 800.
- **Zero drift today.** §5.3, both directions (`totalPoolUsd`/`stakeCount` from `SUM`/`COUNT`, `currentLeaderId` from the top-`amountUsd` row, plus the `isLeader` flags).
- **No detector.** The assertion runs *in the writer*. Nothing in the product ever recomputes the trio from `Stake` and compares, so a drift introduced by a manual `psql` UPDATE, a partially-failed deploy, or a future second writer would be invisible until it rendered wrong. `lib/reconcile.ts` looks at payments and stakes' existence, not at the trio (R12-2; `08` owns the reconcile contract).
- **The tie-break is deterministic**, which is why the drift check is meaningful at all: `rankStakes` orders by `amountUsd` then `createdAt` then `id` (`lib/recompute.ts:79-84`), so "the leader" is a function of the rows, not of read order.

### 5.9 Money representation

Every money column is `integer`, and there is not a `numeric`, `decimal`, `float` or `money` anywhere:

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `Element.totalPoolUsd` | integer | NO | 0 |
| `Element.stakeCount` | integer | NO | 0 |
| `Stake.amountUsd` | integer | NO | — |
| `Payment.amountUsd` | integer | NO | — |
| `Payment.providerAmount` | integer | YES | — |
| `Payment.providerCurrency` | text | YES | — |
| `ActivityLog.amountUsd` | integer | NO | — |
| `ActivityLog.deltaUsd` | integer | YES | — |
| `ActivityLog.resultTotalUsd` | integer | YES | — |
| `EmailLog.amountUsd` | integer | YES | — |

Whole dollars in an `integer` is the right call for a ladder whose prices are `$5`, `$6`, … and it removes the entire class of float-rounding bugs a payments ledger usually dies of. The comment on `Stake.amountUsd` (`schema.prisma:156`) and on the activity pair (`:342-344`) carry the two subtleties: `Stake.amountUsd` is **cumulative**, so `SUM` over stakes is the pool while `SUM` over payments is not; and the activity pair is nullable so pre-Phase-3 history is an honest NULL rather than a fabricated delta.

Where the design has no backstop is the *sign and range* (P21): nothing stops `amountUsd = -1`, or a `Stake.amountUsd` that disagrees with the `Payment.amountUsd` that funded it. The guard is `lib/recompute.ts:146-148`, which throws `ledger-invariant:reverse-below-zero` — a JS exception inside the transaction, in one code path. Zero CHECK constraints exist in this schema (§5.13), so every money promise is a promise about the code.

`Payment.providerAmount` (cents, provider-reported) next to `Payment.amountUsd` (dollars, ours) is the currency-discipline pair: the settle path compares them rather than trusting either, which is `08`'s subject. Worth noting here only that the schema keeps both, in different units, and the column names do not say so — a reader who assumes `providerAmount` is dollars is wrong by 100×.

### 5.10 Seeds

| Seeder | Writes | Guard |
| --- | --- | --- |
| `prisma/seed.ts` | 122 elements, 8 startups, 26 mock stakes + 26 activity rows (`seed ok: …`, 2026-09-15) | **none** — `doc/PROD-READINESS-CHECKLIST.md:15` flags this explicitly ("no environment guard… exactly what `npm run db:clear-demo` exists to undo") |
| `prisma/launch-seed.ts` | 122 elements, 9 real-company domains as placeholder listings, 27 stakes (`launch-seed ok: …`); `--fresh` truncates first (`launch-seed.ts:80`) | manual file, not a package script — the operator runs it deliberately |
| `prisma/fill-table.ts` | the remaining elements for a full grid | manual, documented as such |
| `lib/demoData.ts` | no writes — it is the *definition* of which domains are demo and which signals prove one became real | the cleanup's guard list |

The seeds are idempotent in the sense that matters: `launch-seed` upserts by domain, so a second run reports the same 9 listings. The demo seeder is not environment-guarded and `.env` in the author's checkout points at production (`HANDOFF.md:85, 655`), which is why the checklist's instruction is to pass `DATABASE_URL=` explicitly. That hazard is *already* registered — `doc/PROD-READINESS-CHECKLIST.md:15` — so this doc cites it rather than re-reporting it.

### 5.11 PII inventory

The columns that hold personal data, and how many rows held them in the scratch database (2026-09-15):

| Column | Rows | Why it exists |
| --- | --- | --- |
| `EmailLog.to` | 32 | the address a mail was sent to |
| `ManageToken.email` | 12 | the address a magic link was sent to |
| `WaitlistEntry.email` | 11 | the waitlist |
| `Payment.email` | 7 | payer email captured at checkout |
| `Startup.email` | 6 | notification target for outbid/receipt |
| `Report.ipHash` | 14 | abuse triage, hashed |
| `ClickEvent.ipHash` | 0 | not written by shipped code (§6) |
| `Startup.unsubToken` | 15 | a bearer secret per listing, default `cuid()` |

Hashed rather than raw where the purpose allows (`Report.ipHash`, `ClickEvent.ipHash`), which is the right call, and the salt is `CLICK_SALT` — a named secret, never printed here.

**The finding is where the addresses *aren't* on that list.** Two write paths put the plain address inside a free-text column:

- `app/api/waitlist/route.ts:45` writes `WAITLIST_JOINED` with the address in `AuditLog.detail`.
- `lib/manage.ts` does the same for `MANAGE_LINK_REQUESTED`.

Confirmed by reading the table rather than the code — 23 of 35 audit rows contain an `@`:

```
 action                | count
-----------------------+-------
 MANAGE_LINK_REQUESTED |    12
 WAITLIST_JOINED       |    11
```

So a data-subject request has to sweep `AuditLog.detail` too, and `AuditLog`'s own docstring calls it "append-only audit trail" (`schema.prisma:300-301`). That is R12-4's sharpest edge.

`EmailLog` deserves its own line because its *status* vocabulary is wrong on disk:

```
 template | status | count
----------+--------+-------
 receipt  | logged |     7
 report   | logged |    14
 waitlist | logged |    11
```

`schema.prisma:371` documents `status` as `sent | suppressed | error` and defaults it to `"sent"` — and every row here says `logged`, because `lib/email.ts`'s `deliver()` reports `"logged"` when `RESEND_API_KEY` is unset. Routing all three templates through that state is the correct behaviour — but a reader who queries `WHERE status = 'sent'` to count delivered mail counts zero, and one who counts rows to prove delivery counts 32. R12-3.

### 5.12 Retention and deletion

Search across the repository for anything that removes a real customer row: `deleteMany`/`delete` appear in `scripts/clear-demo-data.ts` (demo rows only, with a guard that refuses real ones) and in the test fixtures (`lib/{ledger,manage,moderation,outbox,recompute,reconcile,routes,settle,webhook,unsubscribe}.test.ts`, `lib/testDb.ts`). No route, no script, no cron and no admin endpoint deletes or exports a customer's data.

Is a retention window stated anywhere? `doc/` promises nothing. The waitlist page promises mail "within 72 hours" (`05` §5), which is a *delivery* promise, not a retention one. `EmailLog`, `AuditLog`, `ActivityLog`, `ProviderEvent` and `Payment` all grow forever and none is pruned: there is no window, no aggregator, no archival step.

The honest statement of the current state is therefore: **PII in this product is collected, hashed where possible, found easily — and never removed.** R12-4. The *policy* (the window, what the privacy page must say, what a deletion request must cover) belongs to `16` and the *runbook* to `17`; what this doc contributes is the schema-level fact that deleting a payment is blocked by RESTRICT (§5.7), so any deletion feature must be a scrub-in-place — null the PII columns, keep the row — rather than a delete.

### 5.13 Constraints the database does not have

```
 == CHECK constraints in public ==
 tbl | conname | def
-----+---------+-----
(0 rows)
```

Zero. Not one CHECK constraint in the entire schema. Every promise in §3 that is not a key (P19–P22, and the sign/range half of P18) is therefore enforced by application code only, and the application code is one bootstrapping path away from not running: `npx prisma db seed`, a `psql` session, `scripts/backfill-previews.ts`, or a future admin tool all write this database without passing through `lib/recompute.ts`.

The counter-argument is real and should be stated: a CHECK cannot express P19 anyway (the trio is an aggregate over another table, so it needs a trigger, a materialized view, or a detector), and a `CHECK (amountUsd >= 0)` would only catch a class of bug the code's own throw already catches. The recommendation in R12-1 is therefore narrow — the constraints that *are* expressible — alongside the honest admission that the trio needs a detector instead (R12-2).

### 5.14 Backups, PITR, pooling

**PITR.** Neon offers point-in-time restore on this plan, and nothing in this repository configures, tests or documents it: no runbook in `doc/`, no `scripts/` entry, no `README.md` line. `doc/PROD-READINESS-CHECKLIST.md` §7 is the closest thing and it is about *reading* production, not restoring it. The exact operator commands, none of which was run here (U12-1):

```bash
# 1. Pick the target instant (UTC) — the last moment the data was known good.
#    Neon console → Project → Branches → primary → "Restore" offers a timestamp picker.
# 2. Restore into a NEW branch, so the primary is untouched while it is inspected:
neonctl branches create --project-id <id> --name pitr-drill-2026-09-15 \
    --parent <primary-branch-id> --at "2026-09-15T06:00:00Z"
neonctl connection-string pitr-drill-2026-09-15 --project-id <id>   # → the drill's DATABASE_URL
# 3. Verify the drill branch, read-only, before anything can be promoted:
psql "$DRILL_URL" -c 'SELECT count(*) FROM "Element";'                                   # expect 122
psql "$DRILL_URL" -c 'SELECT count(*) FROM "Stake";'
psql "$DRILL_URL" -c 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;'  # expect 7
# 4. Only then, with the decision recorded, promote or copy rows across.
```

**This is destructive in the operator's sense** — it provisions billable infrastructure, can be pointed at the primary, and a promoted branch replaces production data — and it needs credentials that do not exist in this checkout. It is therefore an UNKNOWN row with the commands spelled out rather than a result, which is exactly the gap U12-1 names: the plan asked for a *result*.

**Pooling.** `lib/prisma.ts:5-9` constructs `new PrismaClient({ log: … })` and nothing else. There is no `connection_limit`, no `pool_timeout`, no `statement_timeout`, no `pgbouncer=true`, and no `directUrl` in the datasource (`schema.prisma:12-15`). Three consequences, stated as facts about configuration rather than measurements: pool size is Prisma's default for the runtime, so the ceiling scales with the number of concurrent lambda instances instead of being chosen; the connection string is the only place a limit could be set, and `DATABASE_URL` is a Vercel-sensitive variable whose value cannot be read back (`doc/PROD-READINESS-CHECKLIST.md:196,436`), so even an operator cannot confirm from the repository whether the URL already carries `connection_limit`; and a runaway query has no server-side time ceiling, bounded only by the function's `maxDuration`. `HANDOFF.md:660-663` records that `migrate deploy` *did* work over Neon's pooled URL, so `directUrl` is not currently required — and that if a future migration fails on advisory locks, adding `DIRECT_URL` + `directUrl = env("DIRECT_URL")` is the first thing to try. R12-5.

**Timeouts that do exist** live in the money transaction, not in the pool: `MONEY_TX = { isolationLevel: "Serializable", maxWait: 15_000, timeout: 25_000 }` (`lib/txn.ts`) with up to 10 attempts on `P2034`/`40001`/`40P01` and jittered backoff — `15` measures the real worst case; this doc only notes that the storage layer contributes no timeout of its own.

## 6. Failure and edge matrix

| Failure | What happens | Evidence |
| --- | --- | --- |
| Postgres unreachable | 7 read routes → `500` with an empty body and no `x-request-id`; `/` still renders 200 (static); `POST /api/checkout {}` → 403 "paused", because a missing database surfaces as a paused store | `11` §5.11 (observed); data-layer reading: no route wraps the Prisma error, so the client sees the framework's page |
| Migration not applied but code deployed | `prisma generate` succeeds against a stale database; the first query naming a new column throws `P2022` inside whatever path touches it | `scripts/migrate-if-production.mjs:8-20` exists to prevent exactly this; the script's comment calls the alternative "deploying code whose schema was never applied" |
| A second `active` `ClaimReservation` for one element | Unique violation on the partial index → the checkout path's `P2002` branch → 409-shaped rejection | `0001:280`; `11` §5.6 records the 409 on key reuse |
| Two identical checkouts | The second sees `Payment_idempotencyKey_key` and returns the first payment | observed: idempotent replay returned the same payment id (`11` §5.5) |
| A replayed webhook | `ProviderEvent_providerEventId_key` collision → recorded as `DUPLICATE`, no second apply | `0002:20`; outcome vocabulary from `0005` |
| Deleting a listing that has taken money | `RESTRICT` from `Stake`/`Payment`/`ClaimReservation`/`FirstClaim` → the delete fails, no cascade, ledger intact | §5.7 |
| Deleting a listing with only history | `SET NULL` on `Element.currentLeaderId`, `AuditLog`, `Report` — the element survives with no crown | §5.7 |
| `ClickEvent` | **Never written.** No shipped code inserts one; the table is 0 rows after every probe, so the click half of the product is not implemented | reads only, plus tests |
| An outbox row that fails 5 times | `attempts` reaches `OUTBOX_MAX_ATTEMPTS`, `nextAttemptAt` stops moving, `lastError` holds the reason, `completedAt` stays NULL — and nothing notifies anyone | `13` R13-3; the state is visible only to a `psql` session or the admin retry route |
| A stake reversed below zero | `lib/recompute.ts:146-148` throws `ledger-invariant:reverse-below-zero` inside the transaction, aborting the whole reversal | code, not a constraint (P21, R12-1) |
| `Element` deleted while stakes exist | `RESTRICT` | `0000:167` |
| A value the client cannot deserialize | Prisma throws on an enum label it does not know (`schema.prisma:54-64` on `whop`) — an argument for *adding* enum values, and against removing them | §5.4 |
| A database built by `db push` instead of `migrate deploy` | The partial unique index is **not** in `schema.prisma`, so that database lacks P5, and Prisma's differ will not say so in either direction | §5.4 last paragraph, R12-6 |
| A malformed `OutboxEvent.payload` | `payload Json` is required (`schema.prisma:272`) and readers cast it to a per-type shape at the call site, so a bad payload fails inside the worker rather than at the boundary | `lib/outbox.ts` |
| Clock and timezone | every timestamp is `TIMESTAMP(3)` written by `now()` or Prisma's `now()` and stored without a zone; the app reads and writes UTC and the DB session's timezone is never set explicitly. Correct in practice on a default Postgres session, undocumented as a decision | `0000` onwards; no `SET TIME ZONE` anywhere in `lib/` |

## 7. Findings

### R12-1 — No constraint backs any numeric promise in the schema

- **Severity.** P2
- **Category.** data · correctness
- **Evidence.** `SELECT … FROM pg_constraint WHERE contype='c' AND connamespace='public'::regnamespace` → **0 rows** (2026-09-15, scratch DB). `Stake.amountUsd`, `Payment.amountUsd`, `Element.totalPoolUsd` and `Element.stakeCount` are all bare `integer NOT NULL`. The only negative-money guard is a JS throw at `lib/recompute.ts:146-148` (`ledger-invariant:reverse-below-zero`), and the only trio guard is `assertLedgerInvariants` called from inside the writer's transaction (`lib/recompute.ts:97-101`). Both are bypassed by anything that writes this database without going through `lib/`: `npx prisma db seed`, `scripts/backfill-previews.ts`, a `psql` session, a future admin tool.
- **Reproduction.** Run the check-constraint query above, then (on a scratch database) `UPDATE "Stake" SET "amountUsd" = -5 WHERE …` and observe that it succeeds while `Element.totalPoolUsd` keeps its old value — the trio is now inconsistent with `Stake` and nothing raised an error.
- **Proposed fix.** Add the CHECKs that are expressible, in one migration: `Stake.amountUsd >= 0`, `Payment.amountUsd >= 0`, `Payment.providerAmount IS NULL OR "providerAmount" >= 0`, `Element.stakeCount >= 0`, `Element.totalPoolUsd >= 0`, and a `refundedAt IS NOT NULL ⇒ status = 'refunded'` pair on `Payment`. Leave the trio to R12-2, because a CHECK cannot aggregate another table.
- **Status.** open (draft)

### R12-2 — The denormalized trio has no independent detector

- **Severity.** P3
- **Category.** data · observability
- **Evidence.** The trio is written by exactly one function (`lib/recompute.ts:85-108`) and asserted by `lib/recompute.ts:97-101` *inside that same transaction*. Nothing recomputes `Element.totalPoolUsd`/`stakeCount`/`currentLeaderId` from `Stake` and compares it afterwards: `lib/reconcile.ts` is payment-shaped ($5, read-only, `PAID`-only — `08` owns it), `/api/jobs/reconcile` calls that, and no admin route or view checks the aggregates. The zero-drift result in §5.3 came from ad-hoc SQL written for this doc, which will not run again after today.
- **Reproduction.** Run the §5.3 drift query, hand-edit one `Stake.amountUsd` on a scratch database, and run it again: it reports the drift, and nothing in the product would have.
- **Proposed fix.** Add the drift query as a second, always-run check inside `/api/jobs/reconcile` — it is read-only and that job already has the "divergent → 503" convention — reporting the offending element ids. It is one query over 122 rows.
- **Status.** open (draft)

### R12-3 — `EmailLog.status` documents three values and the code writes a fourth

- **Severity.** P3
- **Category.** data · observability
- **Evidence.** `prisma/schema.prisma:371` — `status String @default("sent") // sent | suppressed | error`. `lib/email.ts`'s `deliver()` returns `"logged"` when `RESEND_API_KEY` is unset. All 32 local rows are `logged` (`receipt` 7, `report` 14, `waitlist` 11) because no key is set here: `SELECT template, status, count(*) FROM "EmailLog" GROUP BY 1,2`. The column is a plain string, so nothing rejects the fourth value.
- **Reproduction.** `SELECT status, count(*) FROM "EmailLog" GROUP BY 1;` on any database used without a mail key, then read the schema comment above the column.
- **Proposed fix.** Two lines: correct the comment to the real vocabulary (`sent | suppressed | error | logged`), and make `logged` explicit in the `lib/email.ts` return type so only `sent` reads as "the vendor accepted it". `10` owns the deliverability consequence; the schema-level ask is that the comment stop lying.
- **Status.** open (draft)

### R12-4 — Every PII column can be found and none can be deleted

- **Severity.** P2
- **Category.** data · privacy
- **Evidence.** No route, script, cron or admin endpoint deletes or exports a customer row: the only `deleteMany` calls outside tests are in `scripts/clear-demo-data.ts:172-200`, whose entire purpose is to remove *demo* rows, refusing any row that has acquired a customer signal (`lib/demoData.ts:33-47`). PII lives in `Payment.email`, `Startup.email`, `WaitlistEntry.email`, `EmailLog.to`, `ManageToken.email`, `Startup.unsubToken`, `Report.ipHash` — and, per §5.11, in plain text inside `AuditLog.detail` for two actions (23 of 35 rows here) in a table documented as append-only (`schema.prisma:300-301`). Deletion is also *blocked* rather than merely unwritten: `Payment.startupId` and `Payment.elementId` are `ON DELETE RESTRICT` (§5.7), so a "delete this customer" implementation must scrub in place, not delete rows. No retention window is stated anywhere in `doc/`.
- **Reproduction.** Read the `deleteMany` list above; then `SELECT action, count(*) FROM "AuditLog" WHERE detail LIKE '%@%' GROUP BY action;` and compare with the PII inventory in §5.11.
- **Proposed fix.** Decide and write down a retention window, then implement it as a scrub-in-place routine (null the address columns, replace `AuditLog.detail` addresses with a marker, keep the row and its ids) behind an operator-only path, with a `scripts/` entry so it can be run without a deploy. `16` owns the policy text and `17` the runbook; the schema-level requirement is that the routine must not delete rows.
- **Status.** open (draft)

### R12-5 — Connection handling is unconfigured and unverifiable from the repository

- **Severity.** P3
- **Category.** data · resilience
- **Evidence.** `lib/prisma.ts:5-9` is `new PrismaClient({ log: … })` and nothing more. A repository-wide search for `connection_limit`, `pool_timeout`, `statement_timeout`, `pgbouncer` or `directUrl` finds documentation only: `HANDOFF.md:645` (a *test* pool knob, offered if flakiness recurs), `HANDOFF.md:660-663` (`directUrl` is "the first thing to add" if a future migration fails on advisory locks), and nothing in `lib/`, `app/` or `prisma/schema.prisma:12-15`. `DATABASE_URL` is a Vercel **sensitive** variable whose value pulls back empty (`doc/PROD-READINESS-CHECKLIST.md:196,436`), so whether the connection string already carries a `connection_limit` cannot be determined from the repository at all.
- **Reproduction.** The search above; then `vercel env pull` and observe an empty `DATABASE_URL` (`doc/PROD-READINESS-CHECKLIST.md:436`). The only positive proof of the runtime connection ceiling would be `SHOW max_connections` plus `SELECT count(*) FROM pg_stat_activity` against production, i.e. U12-2.
- **Proposed fix.** Record the intended pool size as a decision — either an explicit `?connection_limit=N&pool_timeout=10` on `DATABASE_URL`, documented where its value lives, or a comment in `lib/prisma.ts` stating that Neon's pooled endpoint is the ceiling. `17` should own the resulting `pg_stat_activity` runbook step.
- **Status.** open (draft)

### R12-6 — The strongest constraint in the schema exists only in a hand-written migration

- **Severity.** P3
- **Category.** data · process
- **Evidence.** "At most one active quote per element" is enforced by `ClaimReservation_elementId_active_key` (`0001_phase1_ownership/migration.sql:280`, a partial unique index). `prisma/schema.prisma:205-206` documents it in a comment and cannot express it. Measured consequence: `npx prisma migrate diff --from-url $DATABASE_URL --to-schema-datamodel prisma/schema.prisma --script` → `-- This is an empty migration.` (2026-09-15) — Prisma's differ does not propose dropping it, which is reassuring for `migrate dev`, and equally does not know it exists, so a database created from `schema.prisma` (`prisma db push`, or any future CI that builds from the schema rather than the migration set) would silently lack the guarantee the checkout path treats as a hard invariant, and the take-lead race would come back.
- **Reproduction.** `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script` against a migrated database (read-only), then search the generated SQL for `ClaimReservation` — it is absent.
- **Proposed fix.** No code change is needed while `migrate deploy` is the only way a database is created; the durable fix is a written rule ("databases come from `prisma/migrations`, never from `schema.prisma`") plus a cheap CI assertion that `pg_indexes` contains `ClaimReservation_elementId_active_key` after a fresh migrate — §5.4 already does that replay in this review.
- **Status.** open (draft)

### R12-7 — Case is inconsistent across the read API, and only one of the two conventions is pinned

- **Severity.** P3
- **Category.** data · contract
- **Evidence.** Two payloads from the same running app (2026-09-15, dev server on port 3215): `/api/elements` → `"family":"EXOTIC_THEORETICAL","tier":"EXOTIC"` (uppercase, because `ChemicalFamily`/`PrestigeTier` are the two of nine enums with no `@map` — `schema.prisma:17-35`) and `/api/activity?limit=2` → `"kind":"join"` (lowercase, from a plain `String` column, `schema.prisma:345`). `lib/contracts.test.ts:63` pins the lowercase form as a wire contract; nothing pins the uppercase form. The third case belongs to the operator: `/api/admin/reports?status=` casts its input to the **uppercase** TypeScript member (`app/api/admin/reports/route.ts:14`) while the database stores `open` (confirmed on disk, §5.2), so the same value is spelled differently in the URL, in `psql`, and in the payload.
- **Reproduction.** `curl.exe -sS "http://127.0.0.1:3215/api/elements" | head -c 200` and `curl.exe -sS "http://127.0.0.1:3215/api/activity?limit=2"`; then `SELECT DISTINCT status FROM "Report";` → `open`.
- **Proposed fix.** Choose one wire convention for enum-valued fields and enforce it at the serialization boundary (a small map per route), then pin it in `lib/contracts.test.ts` the way `kind` already is. At minimum, document the split in `doc/ARCHITECTURE.md` so a client author is not left inferring it from two responses. `11` R11-6 owns the missing `?status=` validation.
- **Status.** open (draft)

## 8. Acceptance criteria

- [x] Every model in `prisma/schema.prisma` is accounted for, with the column that matters named (§5.1)
- [x] The enum case split is measured against `pg_enum` and against the wire, and the trap is written down (§5.2, R12-7)
- [x] Every unique constraint is listed, including the one Prisma cannot express (§5.5)
- [x] Indexes are checked against the read paths the API actually issues, and the "too small to index yet" caveat is stated rather than hidden (§5.6)
- [x] Relation delete behaviour is a table read from the generated SQL, not from Prisma's defaults (§5.7)
- [x] The denormalized trio is measured from both directions and its missing detector is a finding (§5.8, R12-1, R12-2)
- [x] Money representation is verified from the catalog: `integer`, whole dollars, zero floats, and the units trap between `amountUsd` and `providerAmount` named (§5.9)
- [x] Migrations `0000`–`0006` replayed twice onto an empty database, in order, with `migrate diff` confirming the landing state matches the schema (§5.4)
- [x] Both seeders re-run and their output quoted; the demo seeder's missing environment guard cited to the checklist rather than re-reported (§5.10)
- [x] PII inventory includes the two free-text columns that hold addresses, proven by a query rather than a code read (§5.11)
- [x] Retention and deletion are answered directly — there is no deletion path — and the RESTRICT constraint that makes deletion a scrub-in-place problem is named (§5.12, R12-4)
- [x] Connection pooling and timeouts are reported as *unconfigured*, with the reason a value cannot be read back (§5.14, R12-5)
- [ ] **Neon PITR restore drill performed and dated** — not done, and not doable here; the commands are in §5.14 and the row is U12-1. This is the one acceptance box batch 3 leaves open on purpose
- [ ] A replay onto a **copy of production** (the plan's second replay target) — not done; U12-4

Budget: nothing in this doc was measured against production, and no statement in it depends on production state. The scratch database is reproducible from the commands in §4 in under ten minutes, which is the property that makes the rest of this doc re-checkable rather than merely believed.

## 9. Open questions

- **Q1 — Should the trio be a cache at all?** At 122 elements and (today) 34 stakes, computing the board from `Stake` directly costs 0.076 ms (§5.6 Q5). The cache exists for a future shape, and it costs a writer that rewrites every stake row per mutation (`lib/recompute.ts:85-89`). `09`/`15` should decide when the cache stops paying; this doc only establishes that nothing else can verify it.
- **Q2 — What is the retention window?** Nobody has decided. Until someone does, the schema's default is "forever" and R12-4 stands.
- **Q3 — Is `ClickEvent` a dead table or an unbuilt feature?** No shipped path writes it. If it is unbuilt, the pricing and ownership docs should say the click half of the product does not exist; if it is dead, it is a table that costs one migration to drop and one paragraph of README to explain.
- **Q4 — Should a preview deployment be able to write production rows?** `DATABASE_URL` is scoped Production *and* Preview against one Neon database (`HANDOFF.md:671`, `scripts/migrate-if-production.mjs:3-8`). The build-time migration risk is closed by the `VERCEL_ENV` guard; the *runtime* risk is not, since a preview of an unmerged branch reads and writes the same rows. `14` and `17` own that decision.

## 10. Cross-references

- `03` — the board that reads the trio; §5.8 here is the storage half of what it renders.
- `04` §5.4 — the same PascalCase/`psql -c` quoting workaround this doc used, and the same missing-`DATABASE_URL` conclusion.
- `05` §5 — the report/waitlist mail chain whose `EmailLog` rows are the 32 in §5.11.
- `06`, `08` — own the money rules behind `Payment`, `Stake`, `lib/txn.ts` and the aggregate writer. **Where a claim here is really money-path behaviour it is named as theirs**, specifically R12-1's assertion path and R12-2's detector, which is `08`'s reconcile contract to extend.
- `07` — owns `0006_stripe_provider` and the retained `whop` rows; §5.4 only records that the migration is deliberate.
- `10` — owns `EmailLog` semantics; R12-3 is the schema-side half of it.
- `11` §5 — the observed route behaviour these tables produce; R11-6 is the `?status=` validation gap whose *reason* is §5.2 here.
- `13` — owns `OutboxEvent`'s lease, attempts and failure visibility; §5.1 and §6 here list the columns and the end state.
- `14` — owns `ipHash`/`CLICK_SALT` handling, `unsubToken` as a bearer secret, and the preview-shares-production-database question (Q4).
- `15` — owns the latency and cost readings for these plans, the O(n) re-rank, and the scale at which §5.6's index table stops being a design note.
- `16` — owns the privacy policy and the retention window R12-4 needs.
- `17` — owns the restore runbook (§5.14), the deletion routine R12-4 calls for, and the pool-size runbook step R12-5 asks for.
- `doc/PROD-READINESS-CHECKLIST.md` §, `:15`, `:16`, `:196`, `:316`, `:436` — cited for the production inventory, the seeder hazard, the migration decision, and the reason environment values cannot be read back.
- `HANDOFF.md:636-672` — the pooling, `directUrl` and shared-`DATABASE_URL` history.

## 11. Change log

- 2026-09-15: authored 2026-09-15 against `9681bdc`, from the reads and probes in §5 — schema and migrations read in full, seven migrations replayed twice onto a throwaway PostgreSQL 16 reached over Docker on port 55440, both seeders re-run, ~20 catalog and integrity queries run, nine `EXPLAIN ANALYZE` plans collected, one read-only `prisma migrate diff`. Nothing fixed, no production connection, no production write, no destructive statement, no secret printed.

## 12. UNKNOWN log

| Id | Unknown | What settles it |
| --- | --- | --- |
| U12-1 | Whether a Neon PITR restore actually works, how long it takes, and what a restored database looks like — the plan asked for a dated drill *result* and this is not one. Destructive and credentials-bearing, so it is operator-run by policy as well as by access | The commands in §5.14, run by the operator against the Neon console: create a branch at a chosen timestamp, `psql` its three counts (`Element` 122, `Stake` as expected, `_prisma_migrations` 7), record the wall-clock restore time and the branch name, then discard the branch. Nothing in the repository has ever done this |
| U12-2 | Live-Neon schema state, connection ceiling, and per-table production row counts *today* | `npx prisma migrate status` plus `SHOW max_connections` and `SELECT count(*) FROM pg_stat_activity` against production — read-only, but needs `DATABASE_URL`, which is a Vercel sensitive variable. `doc/PROD-READINESS-CHECKLIST.md:316` holds the last such read (2026-09-14) and is the substitute this doc cites |
| U12-3 | Whether any index above is genuinely unused, rather than merely unused at 34 rows — the scan counters cannot distinguish "no query needs it" from "no query is big enough yet" | The same `pg_stat_user_indexes` read after production has a few thousand stakes and a week of real traffic — read-only, but it needs production access (U12-2) |
| U12-4 | Whether `migrate deploy` applies cleanly over the *production* rows rather than over an empty database — the plan's second replay target. An empty-database replay cannot catch a migration whose backfill collides with existing data | A production dump restored into a throwaway database, then `npx prisma migrate deploy` against it. Needs a dump, which needs credentials; the destructive risk is zero (the scratch database is the only thing written) but the data does not exist here |
| U12-5 | How a migration behaves while the app serves traffic — lock duration, whether a deploy can hang on `ALTER TABLE`, and what a second concurrent deployment sees | Apply a pending migration against a database under write load and time it; the `0003`-style whole-table `UPDATE` is the class of migration that would show it. Not attempted: it needs a database with production-shaped volume |
| U12-6 | What PII actually accumulates in production over time — which addresses, how many, and whether anything has already been requested for deletion | The PII inventory query from §5.11 run against production (read-only), plus the operator's own record of data-subject requests, which is not a query at all |
