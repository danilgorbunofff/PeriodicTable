# Operator runbooks

The procedures for running periodictable.lol. Everything here assumes no UI:
the operator surface is the authenticated `/api/admin/*` and `/api/jobs/*`
endpoints and a shell. Started as
the Phase 17 fix pass (`doc/review/17-operator-tooling-and-runbooks.md`), which
measured how much of the plan's runbook list had no procedure written at all —
this file is the index for what now exists, and each runbook names the finding
it answers.

## The fourteen procedures

| # | Situation | Runbook | Finding |
| --- | --- | --- | --- |
| 1 | A buyer paid and nothing changed | `payments-stuck.md` | R17-1 |
| 2 | Webhook deliveries fail or stop arriving | `webhooks.md` | R17-2 |
| 3 | The signing secret leaked or must rotate | `secrets.md` | R17-4 |
| 4 | Refund a charge | `refunds-and-disputes.md` | R17-3 |
| 5 | A chargeback or dispute arrives | `refunds-and-disputes.md` | R17-3 |
| 6 | Hide, unlist or restore a listing | `takedown.md` | R17-10 |
| 7 | Triage the report queue | `takedown.md` | R17-9 |
| 8 | Rotate any secret | `secrets.md` | R17-4 |
| 9 | Deploy, or roll a bad deploy back | `rollback.md` | R17-11 |
| 10 | The database is unreachable or wrong | `database.md` | R17-12 |
| 11 | Email stops going out | `email.md` | R17-13 |
| 12 | An abuse wave arrives | `abuse-wave.md` | R17-14 |
| 13 | The site is down and users need telling | `comms.md` | R17-15 |
| 14 | Nothing has failed yet — thresholds, the monitor, retention | `alerts.md` | R18-9, R18-12, R18-15 |

Two findings have no procedure of their own because their software half is what
closes them: R17-7's operator half is the last section of `takedown.md` (a buyer's
profile edit, with no client to make it — that form is phase `09`), and R17-8 was
already closed in the product by R14-9's `OUTBOX_RETRY` audit row, which this pass
gave the `actorRef` rule below.

## Auth, once

Two bearer credentials, and the header is the only accepted form (the `?secret=`
query form was removed in Phase 14, R14-8):

```sh
export APP_URL=https://www.periodictable.lol
export ADMIN_TOKEN=…   # /api/admin/*   — moderation, triage, mail retry
export CRON_SECRET=…   # /api/jobs/*    — workers and reports
```

- `/api/admin/*` takes `-H "Authorization: Bearer $ADMIN_TOKEN"`. **403
  `{"error":"forbidden"}`** means the variable is unset or wrong — fail-closed in
  every environment, including development.
- `/api/jobs/*` takes the same header with `$CRON_SECRET`, or `secret` in a JSON
  body on the POST-only routes (`outbox`, `screenshot`, `abandoned-checkouts`).
  **401 `{"error":"unauthorized"}`** means the secret did not match.
- `ADMIN_TOKENS="alice:<token>,bob:<token>"` adds named operator credentials
  (R17-6). A named token authenticates exactly like the shared one, and the route
  records the *name* in `AuditLog.actorRef` and in `reviewedBy`/`operator` — the
  name the token proves, ahead of any string a request body claims. Remove one
  entry to revoke one person; unset nothing else.
- No secret is ever printed by the app, and none belongs in this directory.

## The clock and the alarm

- `.github/workflows/outbox-tick.yml` is the scheduler: outbox drain, preview
  generation, abandoned-checkout sweep, then `/api/jobs/reconcile` and
  `/api/jobs/config`. Its `*/10` is nominal — measured runs are far sparser (34
  runs in 110 h at one reading, worst gap 6 h 40 m), so treat a "silent" worker
  as unproven until the run list says otherwise:
  `gh run list -w outbox-tick.yml -L 20` and `gh run view <id> --log`.
- The tick is also the money alarm: a non-200 reconcile, or `divergent`/
  `unapplied` above zero, exits 1 and the run goes red.
- A free external pinger reads `/api/jobs/config` status codes: **200** means the
  secret is right and no required variable is missing, **503** means
  authenticated but misconfigured, **401** means the pinger's secret is wrong.
- `GET /api/health` is the unauthenticated one: **200** only when the database
  answered inside 2 s, **503** when it did not. It exists so liveness does not
  depend on a bearer token (the monitor's URL list is in `alerts.md`).
- `GET /api/admin/ops` is the launch-day dashboard (money, funnel, queue, mail,
  audit, recorded errors, alarms) and answers **503 only under `?ok=1`** when
  something is wrong.
  `alerts.md` lists each alarm code, its threshold, and — with `D18-2` —
  where it should reach you.
- Runtime logs last about an hour on the current platform tier. Anything that has
  to outlive an incident is a Postgres row; the substitute for every "check the
  logs" step is tabled in `alerts.md` §"Log retention".
- `GET /api/jobs/config` also carries `mail`, `heartbeats`, `cost` and `stripeKey`
  blocks — the liveness and mail readings the runbooks below start from.
- Run it by hand after a deploy or a change:
  `gh workflow run outbox-tick.yml -f backfill=true` (the backfill input asserts
  the preview worker does real work, not merely that auth passed).

## Rules that keep this file honest

- Nothing here re-settles a payment, refunds a charge, or restores a database by
  itself — the runbooks say which action exists in the product and which one is
  provider-side or console-side.
- `prisma/launch-seed.ts --fresh` deletes payments, provider events and the audit
  log. It refuses a non-loopback `DATABASE_URL` without `--allow-remote
  --confirm=<host>`; the two-flag form is the only way to run it deliberately, and
  there is no reason to run it against production. See `database.md`.
- The operator-only answers (on-call hours, credential custody, refund authority,
  the PITR window, the status page, Upstash) are recorded as decisions
  `D10–D18` in `doc/review/FINDINGS.md`. Where a runbook needs one, it names the
  decision instead of inventing the answer — `alerts.md` does this for the alert
  channel (`D18-2`), the monitor (`D18-5`) and the pager (`D18-6`).
