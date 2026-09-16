# The `Payment` table, read by someone who is not the operator

`doc/review/20-post-launch-and-debt.md` R20-4 and R20-5. The rule this file
exists for: a reader who is handed a `psql` prompt (`DATABASE_URL`) meets twelve
rows in five shapes, six of them dead, and nothing in the table says which is
which or which of them was ever revenue. Reading them wrong is easy and the
consequences are the kind that are found months later, so they are written down
here in one place.

**Provenance, and how to re-check it.** The counts below are the read-only
inventory taken **2026-09-14 12:30 UTC** against production Neon, recorded in
`doc/PROD-READINESS-CHECKLIST.md` §7 ("Production inventory re-read"). No later
read exists, and nothing in this file is a fresh count. Re-run the query at the
end before quoting a row count from it.

## The shapes

| # | `provider` | `status` | `providerRef` | `stakeId` | Rows | What it actually is |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `whop` | `pending` | `NULL` | `NULL` | 4 | Legacy pre-Stripe checkouts. Inert by construction: no session, no provider row, no stake. The `whop` enum value survives only so these four rows deserialize (`PaymentProvider` in `prisma/schema.prisma` says so, and dropping it would strand them). |
| 2 | `stripe` | `pending` | `NULL` | `NULL` | 2 | Checkouts whose request never reached the provider. No money, no session, nothing to apply. |
| 3 | `stripe` | `pending` | `cs_live_…` | `NULL` | 3 | Sessions genuinely created at Stripe and never completed. |
| 4 | `stripe` | `paid` | `cs_live_…` | `NULL` | 3 | **Settled, and the only rows that ever carried money.** Their stakes were deleted by the pre-announce cleanup (`scripts/clear-launch-inventory.ts` nulls `Payment.stakeId` before deleting `Stake`), and `appliedAt` (`09:57:05.964`, `09:57:12.016`, `11:08:37.147`) was left standing on purpose: it is the settle proof for the webhook path (§"Webhook edge cases" in the ledger). |

Four column shapes over twelve rows. The ledger says *five* shapes because one of
shape 3 is the operator's own free-entry checkout at `$25`
(`2026-09-14 12:27:13`) — its amount is typed, not priced out of
`lib/pricing.ts`, so it is read separately from the `$5` sessions around it. Same
columns, different provenance; the ledger's count is the one to follow.

**None of the twelve is revenue from a customer.** No row was ever paid by anyone
other than the operator for a listing. Shape 4 is the closest thing, and those
three settlements were the operator's own.

## Two readings that go wrong quietly

**1. "Paid" is not the same as "bought a listing".** `lib/opsMetrics.ts` reports
both, and they differ by exactly this table:

| figure | filter | means |
| --- | --- | --- |
| `money.window.paidUsd` / `paidCount` | `status = 'paid'` | money the processor settled, whatever it was for — this is the figure that stops matching "revenue" the moment an operator test settles |
| `money.window.settledUsd` / `settledCount` | `status = 'paid'` **and** `stakeId IS NOT NULL` | money that turned into a live stake, which is what "how much did the product sell" means |

A revenue number that a third party will read — a tax figure, a payout
reconciliation, a diligence view — **must filter `stakeId IS NOT NULL`**, and must
say which of the two it is. `/api/jobs/reconcile` deliberately reads all `paid`
rows instead: there it is ledger evidence that money arrived, and filtering would
hide a settlement whose stake was unwound by hand.

**2. `paid` with `stakeId = NULL` is a shape the app should never produce.**
`lib/webhook.test.ts` treats it as a corrupted ledger when the application does
it, because the settle transaction writes the stake and the link in one commit.
Only manual surgery makes it — which is what happened — so it is not a
reachable-by-bug state and it is not a reason to re-run anything. `reconcile` is
read-only and `paid`-only: it will not sweep these rows into stakes, and neither
will anything else.

## The database is lowercase; the API is uppercase

The Prisma enums are `pending|paid|failed|refunded|canceled` for `Payment.status`
and `visible|hidden|unlisted` for `Startup.moderationState`; the API and every
JSON surface uppercase both. A query written from the API's vocabulary does not
return zero rows — it throws:

```
ERROR:  invalid input value for enum "PaymentStatus": "PAID"
```

So read the table with the database's own spelling:

```sh
psql "$DATABASE_URL" -c "SELECT provider, status, \"providerRef\" IS NULL AS no_ref, \"stakeId\" IS NULL AS no_stake, count(*) AS rows, coalesce(sum(\"amountUsd\"),0) AS usd FROM \"Payment\" GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;"
```

## The open decision (R20-4, `20` §9 Q1)

The six `pending` rows with no `providerRef` (shapes 1 and 2) are inert: no money
moved, no session exists, nothing can apply them. They are **kept deliberately**
today, because they are the only record that those checkouts were attempted. The
decision — clear them or leave them — is the operator's, and it is recorded in
`doc/review/FINDINGS.md`; while it is open, an operator run that quotes the table
says so up front rather than letting a reader count twelve rows as activity. If
they are ever cleared, the deletion is reversible-by-record: keep the ids and the
statement in the run's own notes.
