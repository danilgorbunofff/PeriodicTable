# An abuse wave: many listings at once

Finding: R17-14. Related: `takedown.md` (the single-listing procedure and the
promise we made), `email.md` (nothing is mailed unless `RESEND_API_KEY` is set).

A wave is not a bigger takedown — it is a different operation. One report is a
judgement call; thirty in an hour is containment, because the front page is
rendering them while someone reads each one. The rules are the same at both
scales: **contains visibility, never money**, one audit row per listing, and no
silent bulk action.

**Do not start here.** A single report follows `takedown.md`, including the
triage and the recorded reason. Escalate to this file when the queue's own
numbers say the wave is real:

```sh
curl -sS -D - -o /tmp/reports.json \
  -H "Authorization: Bearer $ADMIN_TOKEN" "$APP_URL/api/admin/reports" \
  | grep -i '^X-Report-Queue-'
jq '.[].domain' /tmp/reports.json
```

`X-Report-Queue-Overdue > 0` or `Oldest-Hours` past `Promise-Hours` (72) is the
signal. `Oldest-At`/`Oldest-Hours` exist because the oldest report is exactly the
one a 50-row page hides — page back with `?before=<last id>` and keep reading
until you have the whole queue.

## 1. Contain first, investigate second

The two states that remove a listing from normal circulation, and what each is
for:

| `state` | Effect | Use for |
| --- | --- | --- |
| `HIDDEN` | Listing removed from the table, **and its preview discarded** (`previewImgUrl` nulled by retention policy). | Illegal, deceptive or otherwise unshowable content — anything you would not want cached in someone's browser. |
| `UNLISTED` | Listing out of circulation, preview kept. | Rules violations that may be fixed and restored cheaply. |
| `VISIBLE` | Restored. | See §3 for the preview consequence. |

`reason` is required for `HIDDEN` and `UNLISTED` (`REASON_REQUIRED` otherwise) and
is stored on the listing, not just in the audit row — write the *factual* reason
("look-alike domain, phishing form"), because it is what a restore decision is
argued from later.

Batch, up to **50 domains per call** (the cap is deliberate: a wave is tens, and
a single call re-renders the front page):

```sh
curl -sS -X POST "$APP_URL/api/admin/startups/moderate-batch" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "state": "HIDDEN",
    "reason": "phishing clone of a bank login (wave 2026-09-16)",
    "domains": ["evil.example", "bad-actor.example"]
  }' | jq .
```

Read all four lists in the answer — the operator's next action is different for
each:

| Field | Meaning | Next action |
| --- | --- | --- |
| `changed` | `[{domain, from}]` — actually moved. | None; it is contained. |
| `unchanged` | Already in that state. | A double-click or a stale list. Not an error. |
| `unknown` | No such listing. | A typo, or the domain is not ours. Fix the list. |
| `lost` | Disappeared between the read and its own write. | Re-read and repeat; this is the only race in the endpoint. |

The response also states `publicNumbersUnchanged: true` and the resolved
`operator`. Domains are normalised (lowercase, scheme and path stripped) and
deduplicated before the cap is applied, so a list copied out of a browser bar
usually just works; a list over 50 is refused whole with `BATCH_TOO_LARGE` — no
partial application.

What does **not** happen: no stake, payment, claim or element aggregate moves.
Hiding a listing never refunds, never unwinds and never changes the totals in
`/api/stats` (which are hidden-inclusive by design). If a wave involves money —
paid listings bought for abuse — that is `refunds-and-disputes.md`, per payment,
with `D17-5`'s approval rule.

One audit row per domain (`PROFILE_MODERATED`, `actorType = operator`,
`actorRef = <the token's name>`), so "who hid this and why" has an answer per
listing even though one call did all of them. Verified by:

```sh
psql "$DATABASE_URL" -c "
SELECT \"actorRef\", detail, count(*) FROM \"AuditLog\"
WHERE action = 'PROFILE_MODERATED' AND \"createdAt\" > now() - interval '1 hour'
GROUP BY 1, 2 ORDER BY 3 DESC;"
```

## 2. While the wave is live

- **Pace the calls.** Loop 50 at a time rather than raising the cap; the next
  call's `unchanged` list is also your check that the previous one landed.
- **Watch the queue, not just the table.** `X-Report-Queue-Overdue` should fall
  toward 0; if reports keep arriving faster than you contain, escalate the
  decision (rate-limiting/registration changes) rather than working harder —
  the product's containment levers are what they are.
- **If the wave is automated, the edge is the lever that needs no deploy.**
  Cloudflare sits in front of the domain, so its rules work whatever
  `lib/rateStore.ts` does: **Security → WAF → Rate limiting rules** on
  `POST /api/report` and `POST /api/waitlist`, per IP, for the duration of the
  wave. This is the answer that does not wait for `D15` (Upstash). Two blunter
  options sit in the same console and both have a cost: a **managed challenge**
  on those paths stops a buyer's browser fetch too, and **Under Attack Mode**
  covers checkout as well, which makes it a money-side decision rather than a
  containment one. A Turnstile check *inside* the intake routes does not exist
  today — Turnstile guards checkout only (R17-14) — so that one is a product
  change to schedule, not a lever to improvise mid-wave.
- **Do not delete anything.** There is no delete path for listings or stakes on
  purpose (the ledger is evidence). Hiding is the containment.
- **Previews first if the content is the problem**: a `HIDDEN` action nulls the
  cached preview, but a screenshot job already queued may re-fetch it. After
  containing, confirm with
  `psql "$DATABASE_URL" -c "SELECT domain, \"previewImgUrl\" FROM \"Startup\" WHERE domain IN ('evil.example');"`
  and if it came back, re-apply `HIDDEN` (idempotent: `unchanged`).

## 3. Restoring after the wave

Restoring is a normal `state: "VISIBLE"` call, single or batch, with the same
route and the same audit trail. Two things are deliberately asymmetric:

- `moderatedBy`/`moderatedReason`/`moderatedAt` survive the restore and
  `restoredAt` is stamped: the record of *why it was hidden* is not erased by
  un-hiding it.
- **A `HIDDEN` listing's preview does not come back automatically.** Fill it in
  with the screenshot job, which enqueues rows for preview-less listings
  (bounded to 50 per call):

  ```sh
  curl -sS -X POST "$APP_URL/api/jobs/screenshot" \
    -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
    -d '{"backfill":true,"limit":10}' | jq .
  ```

  The single-listing alternative for a short list is
  `npx tsx scripts/backfill-previews.ts --limit=50` (needs `DATABASE_URL`); it
  only touches `VISIBLE` listings with no preview, so it cannot undo a hide.
  Then let the outbox drain (`email.md` §3).

Restore in waves too, and in the same order you contained: a restored tile
showing a stale preview (or a listing restored before its reason was reviewed) is
worse than an empty one.

## 4. Afterwards

Write the wave up: the reason string used, how many domains, which state, who
authorised it (`D17-1`/`D17-5` if money was involved), and the queue numbers before
and after. A wave is the one event where the audit rows alone will not explain
the decision, because the decision was "hide thirty things in twenty minutes".
Also check the mail side: a `HIDDEN` listing stops being outbid, but any
notification already queued still goes out, and a buyer asking "why is my listing
gone" is answered by the reason string you wrote, not by this file.
