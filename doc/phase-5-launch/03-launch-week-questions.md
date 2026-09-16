# 03 — Launch week: the questions, and the query that answers each

**Parent:** Phase 5 README · **Written for:** `doc/review/20-post-launch-and-debt.md`
R20-12 (and R20-13's trigger-metric pointer), 2026-09-16.

Launch week is the only cohort that will ever see the board before anyone knew
what it was. That window closes whether or not anyone is watching, so what
survives it is written down here as questions with their reads — not as a
dashboard to build, because the queries work today and a dashboard does not.

**The instrument rule, first, because launch week is where it gets misread.**

- **Server-side is authoritative for money.** `/api/admin/ops` returns
  `funnel` (`clicks`, `checkoutsStarted`, `paid`, `clickToCheckout`,
  `checkoutToPaid`) over a `?days=` window, computed from `ClickEvent` (a verified
  `/go` redirect to a tile), `Payment` rows created, and payments applied. `clicks`
  is an *outbound* click, not a `tile_click`: the two are different events on
  purpose, and the client-side seven (`tile_click`, `drawer_open`, `search_submit`,
  `checkout_start`, `checkout_paid`, `reclaim_click`, `go_click`) are informative
  only (R18-14).
- **Plausible is the only reader of the seven, and it is switched off** until
  `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is set (R19-1, U19-3). Until then every
  client-side question below is answered by its server-side proxy, and the proxy is
  named for each one instead of being left as "ask Plausible".

Run each query with `psql "$DATABASE_URL"`; the enums are lowercase in the
database and uppercase in the API (`doc/PAYMENT-LEDGER-SHAPES.md`).

## Q1 — Which channel produced the first stakes?

**The app records no channel.** There is no `utm_` capture, no referrer column and
no signup source anywhere (R19-9 found zero `utm_` strings repo-wide), so this is
the one question here the database cannot answer by itself. What it *can* do is
tell you **who** arrived; the channel is matched by hand, once, while the list is
still short enough to match by hand.

```sh
psql "$DATABASE_URL" -c "
SELECT p.\"paidAt\", st.domain, e.symbol,
       p.\"amountUsd\", p.path, p.email
FROM \"Payment\" p
JOIN \"Startup\" st ON st.id = p.\"startupId\"
JOIN \"Element\" e  ON e.id = p.\"elementId\"
WHERE p.status = 'paid'
ORDER BY p.\"paidAt\";"
```

- Rows whose `domain` is in `LAUNCH_INVENTORY_DOMAINS` (`lib/launchInventory.ts`)
  are the seed, not a customer. The `ARRAY[...]` literal in Q4 below is that same
  list typed out — if the seed list ever changes, the literal is what goes stale, and the
  copy in this file is the one to update with it.
- For every other row: find the domain in whatever outbound log was kept for the
  launch (a file, a thread, a spreadsheet — write it on day one, because day three
  is too late), and in Plausible's referrer report once the script serves.
- **Decision it feeds:** the channel that produced the first stranger gets repeated
  next week; the ones that produced nothing get dropped rather than "given a
  chance". With a handful of stakes the signal is weak by construction — that is an
  argument for keeping the log, not for skipping the read.

## Q2 — Where does a click stop on its way to a checkout, and does the seeded board convert differently?

Two reads, in this order.

**The window funnel** (the same numbers `/api/admin/ops` serves, without the gate):

```sh
psql "$DATABASE_URL" -c "
SELECT
  (SELECT count(*) FROM \"ClickEvent\" WHERE \"createdAt\" >= now() - interval '7 days') AS clicks,
  (SELECT count(*) FROM \"Payment\" WHERE \"createdAt\" >= now() - interval '7 days') AS checkouts_started,
  (SELECT count(*) FROM \"Payment\" WHERE status = 'paid'    AND \"paidAt\"   >= now() - interval '7 days') AS paid;"
```

**Per element, seeded against unseeded** — right after `launch-seed` the seeded
elements are exactly the ones with a pool, so the split needs no flag:

```sh
psql "$DATABASE_URL" -c "
SELECT e.symbol, e.\"totalPoolUsd\" AS pool, e.\"stakeCount\" AS stakes,
  (SELECT count(*) FROM \"ClickEvent\" c JOIN \"Stake\" s ON s.id = c.\"stakeId\"
     WHERE s.\"elementId\" = e.id AND c.\"createdAt\" >= now() - interval '7 days') AS clicks,
  (SELECT count(*) FROM \"Payment\" p
     WHERE p.\"elementId\" = e.id AND p.\"createdAt\" >= now() - interval '7 days') AS started,
  (SELECT count(*) FROM \"Payment\" p
     WHERE p.\"elementId\" = e.id AND p.status = 'paid') AS paid
FROM \"Element\" e
WHERE e.\"totalPoolUsd\" > 0 OR e.id IN (SELECT \"elementId\" FROM \"Payment\" WHERE \"createdAt\" >= now() - interval '7 days')
ORDER BY pool DESC;"
```

- **What it decides:** whether the drawer's price ladder needs work before more
  traffic is sent at it. A high `started` against a low `paid` is a checkout
  problem; a low `started` against a high `clicks` is a drawer problem; both low is
  a traffic problem, and the answer to that is not in this file.
- **Read the seeded column honestly.** Seeded rows were placed with real company
  domains, so a visitor clicking one is clicking an unfamiliar brand, not a
  conversion signal about the product.

## Q3 — Did the seed do its job?

The seed exists so a stranger does not meet an empty board. Whether a company
ever bought its seat is a one-line read:

```sh
psql "$DATABASE_URL" -c "
SELECT st.domain, count(DISTINCT s.\"elementId\") AS elements_held,
       sum(s.\"amountUsd\") AS usd,
       EXISTS (SELECT 1 FROM \"Payment\" p WHERE p.\"startupId\" = st.id AND p.status = 'paid') AS paid_for
FROM \"Startup\" st LEFT JOIN \"Stake\" s ON s.\"startupId\" = st.id
GROUP BY st.id, st.domain ORDER BY usd DESC NULLS LAST;"
```

- `paid_for = true` on an inventory domain means a real company later bought the
  listing that was opened for it: the FAQ's sentence about seats it did not sell
  needs re-reading (`lib/faqDocs.ts`).
- An inventory row with no `paid_for` and no stake is one the cleanup script can
  take (`scripts/clear-launch-inventory.ts`, dry-run first); an inventory row
  with a stake is an open seat somebody is competing for and is **not** residue.
- **Decision it feeds:** when the seed has served its purpose (a real stake exists
  on a marquee element), say so and stop defending the placeholder board.

## Q4 — Does a crown move, and is the top of the board contested?

```sh
psql "$DATABASE_URL" -c "
SELECT e.symbol, e.\"totalPoolUsd\" AS pool, st.domain AS leader,
       s.\"amountUsd\" AS leader_usd, s.\"isLeader\",
       st.domain = ANY(ARRAY['resend.com','lemonsqueezy.com','cal.com','railway.app','neon.tech','replicate.com']) AS seeded
FROM \"Element\" e
JOIN \"Startup\" st ON st.id = e.\"currentLeaderId\"
JOIN \"Stake\"   s  ON s.\"elementId\" = e.id AND s.\"startupId\" = st.id
ORDER BY pool DESC;"
```

```sh
psql "$DATABASE_URL" -c "
SELECT a.\"createdAt\" AS at_utc, a.kind, a.domain,
       a.\"deltaUsd\", a.\"resultTotalUsd\", a.\"elementSymbol\"
FROM \"ActivityLog\" a WHERE a.\"elementSymbol\" = 'C'
ORDER BY a.\"createdAt\" DESC LIMIT 10;"
```

- **What "displacement" looks like:** a non-seeded `leader` on an element that had
  a seeded one, with a `stake` activity row whose `deltaUsd` took its
  `resultTotalUsd` past the previous leader's total. That is the product working —
  and it is also the moment an outbid founder is told they lost (the outbid mail's
  `OUTBID_UNNOTIFIED` audit row is the record when the mail had nowhere to go).
- **Decision it feeds:** whether the ladder is doing what the front page claims.
  One displacement in week one is the story to tell; zero displacements on the
  seeded elements means the seeded amounts were placed too high to be challenged,
  which is a launch-seed parameter (`prisma/launch-seed.ts`), not a product flaw.

## The north star, read the same week

```sh
psql "$DATABASE_URL" -c "
SELECT count(*) FILTER (WHERE \"totalPoolUsd\" > 0) AS colonized_elements,
       count(*) FILTER (WHERE \"stakeCount\" > 0) AS claimed_elements,
       sum(\"totalPoolUsd\") AS total_pool_usd,
       (SELECT count(*) FROM \"Stake\") AS stakes
FROM \"Element\";"
```

`colonization %` is `colonized_elements / 122`, and `total_pool_usd` is the growth
number the roadmap tracks (`doc/ROADMAP.md:433-434`). Read it on day 1 and day 7 of
launch week, not continuously.

## The v2 triggers, and where each one is read (R20-13)

The v2 rule is "start an item only when its trigger metric hits **and** the MVP
funnel is stable for two weeks" (`doc/phase-6-v2/README.md:6`). The second half
needs a stable funnel reading, which is the read in Q2 above; the triggers:

| Trigger | Where it is read today | Where it should be read |
| --- | --- | --- |
| Reclaim email CTR > 15 % (`01-badges-alerts-api.md:7`) | **Nowhere.** The client-side `reclaim_click` needs Plausible live (R19-1). A server-side substitute that works today: reclaim payments — `Payment.path = 'reclaim'` and `status = 'paid'` — over `OUTBID_EMAIL` deliveries recorded in `EmailLog`/`OutboxEvent`. It measures conversions, not clicks, so it reads **low** and a passing number is a stronger signal than the trigger asks for. | Plausible's saved view for `reclaim_click` over the `outbid` mail's campaign/source, once R19-1 closes |
| On-chain settlement revisit at `$50k` pool (`:12`) | `total_pool_usd` in the north-star query above | Same, plus a dated note in `doc/phase-6-v2/README.md` when the number is non-zero — a `$0` pool six months out is a question about the product's path, not a v2 note |
| Funnel stable for two weeks | `/api/admin/ops` `funnel` + Q2 | Plausible's funnel view over `tile_click → drawer_open → checkout_start → checkout_paid`, once R19-1 closes |

**Owed, not done, when R19-1 closes** (R20-13's two maintenance items, review date
`2026-12-31`): name the saved Plausible views next to each trigger in
`doc/phase-6-v2/README.md`, so the rule is checkable by someone other than the
person who wrote it, and re-read the `$50k` threshold against the pool that
actually accrued.

## Open decision — what a claimed tile's number means

Unmade as of 2026-09-16, and cheap to make either way. A tile's face states one
number (`lib/tileFace.ts`): on an unclaimed tile it is the `$5` floor, which is
also the price of taking it, and on a claimed tile it is what the holder paid
(`title` and aria name: `"C Carbon · #1 $5"`, `"claimed, leader pays $5"`). The
buyer's actual price — the holder's total plus `TAKEOVER_MARGIN` — appears on
`/elements/[sym]` (`take #1 for $6`) and in the claim modal, one click later.

With every seat seeded at the floor the two readings collapse (`$5` held, `$6` to
beat), so nothing is wrong on screen; the ambiguity only returns the day a tile
is bought twice. The options: leave it (the face reports standing, the page
reports price), or make the face the price of taking the tile (`$6`), which also
changes the aria name and `lib/a11y.test.ts`'s vocabulary. Recommendation:
**leave it until a second stake exists** — at that point the tile number and the
page price diverge on a live tile, and the first outbid email is the natural
moment to decide with a real example in hand.
