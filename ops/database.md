# The database: migrating, seeding, restoring

Finding: R17-12. Related: `rollback.md` (what to do when a deploy is the
problem), `secrets.md` (`DATABASE_URL` custody), `alerts.md` (the `/api/health`
contract the monitor reads, and the E1 signal).

## Which database am I looking at?

Never assume. Every command below takes an explicit `DATABASE_URL`, and the first
one prints the host so the log says which database it touched:

```sh
psql "$DATABASE_URL" -c "select current_database(), inet_server_addr(), version();"
```

- Local development is the compose Postgres in `docker-compose.yml`
  (`127.0.0.1`, loopback).
- Production is Neon, reached over the network. `lib/seedGuard.ts` treats
  loopback as `local` and everything else as `remote`; nothing in the product
  writes to a remote host without being told to, on purpose.

## Symptom: is it the database, or the app?

The failure mode here is upstream of every route, so it looks like "the site is
broken" while the code is fine. Three readings separate the two, cheapest first:

| Reading | Database down | App broken |
| --- | --- | --- |
| `curl -s -o /dev/null -w '%{http_code}' $APP_URL/api/stats` | `500` (or a hang, then 500) | any other code, or a 200 with wrong contents |
| `curl -sS -H "Authorization: Bearer $CRON_SECRET" $APP_URL/api/jobs/config \| jq '{ok, findings}'` | `ok:false`; the honesty block reports it (`getAppEnv`/`findings`) rather than pretending | `ok:false` with a finding that is not about `DATABASE_URL` |
| `psql "$DATABASE_URL" -c 'select 1'` | connection refused / timeout / "the database system is starting up" | returns `1` — the database is fine, and the incident is the app or the network between them |
| Provider status | Neon's status page says so | it does not |

Two things the product keeps saying while the database is unreachable, so nobody
misreads them as evidence:

- the pinger's **503** means "authenticated but misconfigured"; an unauthenticated
  or unreachable app also fails its check, so a red pinger is not proof of a
  database fault;
- the tick's red run means the *steps* failed — a workflow that cannot reach the
  app and one whose app cannot reach Postgres look identical in `gh run view`.

What a visitor sees in this state is whatever the app's routes do with a failed
query (Next's error page, not a custom copy): that is observed, not asserted —
recording one screenshot from a drill is U17-3, and until someone has done it this
file will not claim a specific page. The 24-hour promises (triage, takedown) are
measured from row `createdAt`, so an outage does not reset the clock; if reports
are arriving during it, they are ageing.

The operator's own action *during* an outage is almost never a restore: stop
`launch-seed`-style destructive work, pause the tick
(`gh workflow disable outbox-tick.yml`), freeze writes if a rollback decision is
coming (§Restore step 1), and tell people (`comms.md`).

## Migrations are forward-only

Thirteen migrations exist, `0000_baseline` through `0012_payment_consent`. They
are applied in order and **there are no down migrations** — `prisma migrate
resolve --rolled-back` marks a *failed* migration so it can be re-applied; it is
not a way to undo a successful one. `ops/rollback.md` says what to do instead.

Applying:

```sh
npx prisma migrate status          # what is applied, what is pending
npx prisma migrate deploy          # apply pending, no prompts, no drift checks
```

- `deploy` is the production path (`npm run db:deploy`); `migrate dev` is
  development-only and will try to reset on drift. Production deploys run
  `scripts/migrate-if-production.mjs` from `npm run build`, which is why a
  deploy can fail on a migration before it fails on anything else.
- A migration that adds a `CHECK` or an index can fail on existing data. The
  failure is the point: read it, fix the data, re-run. `0009_data_invariants`
  and `0011_leader_index` both did this.
- The migration history must be present in the *deployed* database before the
  matching code runs. If the app answers queries against a column that does not
  exist yet, the deploy order was wrong, not the code.

Reverse route when a migration itself is bad: stop the deploy, apply the forward
fix as a **new** migration, and never edit or delete an applied migration
directory (the checksum in `_prisma_migrations` is what proves what ran).

## Seeding, and the one destructive flag

`npm run seed` (`prisma/seed.ts`) is additive: it upserts the table and the demo
data and says nothing about the database it targets, so **read the host first**
(§1). The launch path (`prisma/launch-seed.ts`) is guarded:

```sh
npx tsx prisma/launch-seed.ts                     # append/upsert only
npx tsx prisma/launch-seed.ts --fresh             # local only
npx tsx prisma/launch-seed.ts --fresh --allow-remote --confirm=<host>
```

`--fresh` deletes and rewrites twelve tables (elements, stakes, payments,
reservations, claims, click events, reports, startup/metrics rows and their
dependents), then resets the element aggregates. Before it deletes anything it
prints the target host, whether the host is loopback, the total row count and a
per-table breakdown, so the log line is the evidence of what was destroyed.

- On a loopback host, `--fresh` needs nothing else.
- On any other host it refuses with `REMOTE_FLAG_REQUIRED` and prints the exact
  form to re-run, including the host it resolved:
  `--fresh --allow-remote --confirm=<host>`.
- `--confirm` must equal the resolved host exactly. A typo is a refusal, not a
  partial wipe.
- The confirmation is a **flag, not an environment variable** (R17-5): it appears
  in shell history and in `ps`, so "who wiped production" has an answer.
- Refusals exit 2 and print to stderr. `UNPARSEABLE_DATABASE_URL` and
  `NO_DATABASE_URL` are the other two codes.

`launch-seed --fresh` against production is the only supported way to lose the
payment ledger, and it also destroys the evidence a dispute response needs
(`refunds-and-disputes.md`). Do not run it to "clean up" a test row.

## Restore, and the window we are allowed to use

Neon keeps history; the product keeps no backup of its own. The recovery
mechanics belong to the provider (branching / point-in-time restore from the
Neon console), and the *retention window we rely on* — the point-in-time we can
still reach, and who may authorise a restore — is **operator decision D11**
(`doc/review/FINDINGS.md`, phase 17). Until that is written down, assume nothing
about how far back you can go; ask before promising a restore to a customer.

Procedure once the window is known (and generally, in this order):

1. **Freeze writes** rather than restoring immediately: rotate
   `STRIPE_WEBHOOK_SECRET` (`secrets.md`) so deliveries cannot apply state, and
   pause the tick workflow (`gh workflow disable outbox-tick.yml`).
2. Take a Neon branch immediately at the chosen point in time — a branch is
   cheap and preserves the decision's options; do not overwrite the primary.
3. Reconstruct in the branch, verify with
   `curl .../api/jobs/reconcile | jq .` against the branch's URL and a read-only
   check of the counts you care about, then decide whether to promote.
4. Re-enable the tick and re-arm the webhook secret only after the ledger is
   consistent: `reconcile.ok = true` and `divergent.count = 0`. Anything else is
   a live incident, and `payments-stuck.md` §4 is the recovery for individual
   payments (provider re-delivery) rather than whole-database surgery.

## Is it reachable at all?

`GET /api/health` is the surface for exactly this question, and it is public and
token-free on purpose: one `SELECT 1` with a 2 s budget, **200**
`{ok:true,db:"up"}` or **503** `{ok:false,db:"down",timedOut}`, `no-store`, and
no error text in the body (the reason is one `logWarn` line, `R18-6`). A 503 from
this route means the database or the network to it — not a bad deploy and not
a bad token. It is the first URL on the monitor's list (`alerts.md`), and it is
the reason a database outage no longer looks like any other 500.

## Housekeeping worth knowing

- Row growth is bounded by the retention jobs (click events, heartbeat samples)
  rather than by manual deletes; `npm run audit:prod` looks for the things that
  bite at deploy time.
- Deleting a subject's data has one supported path: `npm run db:erase-subject`
  (`scripts/erase-subject.ts`, requires `DATABASE_URL`). It erases an identified
  subject; it does not clean the demo table. What may be deleted and what must be
  kept for tax/ledger reasons is phase 16's topic.
- `npm run db:clear-demo-data` clears the demo listings — additive seed's
  counterpart, not a ledger tool.
