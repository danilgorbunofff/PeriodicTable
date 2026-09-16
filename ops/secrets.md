# Rotating a credential

Finding: R17-4. The set of secrets the app reads is `lib/env.ts`; the ones an
operator rotates are below. **A rotation is measured in the day it lands, not in
the change itself** — every step ends with a check, because a half-rotated secret
is indistinguishable from a working one until the old value is deleted.

Related: `webhooks.md` (what a bad webhook secret looks like), `email.md` (what a
bad Resend key looks like), `database.md` (`DATABASE_URL`).

## Ground rules

- Two stores, both live: **Vercel** (what the app process reads) and **GitHub
  Actions secrets** (what the tick workflow reads). A rotation that updates one
  and not the other produces the "config is fine but the clock stopped" failure —
  `README.md` §"The clock and the alarm" is the cross-check.
- Never paste a secret into a file in this repository. There is no secret in
  `ops/` by design, and `doc/review/16-legal-privacy-tax.md` records the custody
  expectation: who holds the console logins, and who can rotate without the
  original holder, is **operator decision D12** (`doc/review/FINDINGS.md`).
- Rotate one secret at a time and confirm each before starting the next.

## `STRIPE_WEBHOOK_SECRET` (with overlap)

Signing secrets can be rotated without dropping deliveries, because the verifier
accepts the previous value too: `webhookSecrets()` in `lib/stripe.ts` builds
`[current]` or `[current, old]` from `STRIPE_WEBHOOK_SECRET` and
`STRIPE_WEBHOOK_SECRET_OLD`, and `verifyStripeSignature` accepts a signature made
with *either*, inside the same 300 s tolerance.

Procedure:

1. In the Stripe dashboard, add a new endpoint signing secret (or roll the
   existing one) and copy the **new** value.
2. Set Vercel `STRIPE_WEBHOOK_SECRET` to the new value and
   `STRIPE_WEBHOOK_SECRET_OLD` to the value that is currently in use. Redeploy.
3. Send a test event from the dashboard. Confirm both of these:

   ```sh
   curl -sS -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/jobs/config" \
     | jq '{ok, stripeKey, findings}'
   psql "$DATABASE_URL" -c "
   SELECT \"providerEventId\", \"eventType\", outcome, detail, \"createdAt\"
   FROM \"ProviderEvent\" ORDER BY \"createdAt\" DESC LIMIT 3;"
   ```

   `stripeKey` shows which variables are present; a bad signature is a **401 with
   no row**, so the test event must appear as a new row with a non-ERROR outcome.
4. Watch one full day of real deliveries (the dashboard's endpoint log shows every
   response code). Any 401 means the new secret is not the one signing.
5. Delete `STRIPE_WEBHOOK_SECRET_OLD` in Vercel. **The advisory closes on its
   own**: `lib/env.ts` lists `STRIPE_WEBHOOK_SECRET_OLD` in
   `PROD_ENV_ADVISORIES` and `/api/jobs/config` reports it as an
   `operator`-severity finding while it is set, precisely so a forgotten overlap
   is visible rather than permanent (R15: an old secret left set is a second
   accepted key forever).
6. Confirm `findings` no longer names it. Done.

If a 401 storm starts instead (no successful deliveries), the endpoint is signing
with something neither value matches: re-copy the secret from the endpoint page —
`webhooks.md` §2 has the diagnosis path.

## `ADMIN_TOKEN` and `ADMIN_TOKENS` (per-operator, no overlap needed)

`adminAuth` accepts `ADMIN_TOKEN` **or** any entry of `ADMIN_TOKENS`, a
comma-separated list of `name:token`. `operatorTokens()` parses it, splitting on
the **first** colon so a token may itself contain `:`, and names are trimmed to
120 chars. The name is what lands in the database:

- `POST /api/admin/reports/[id]` writes the matched name as the `REPORT_TRIAGED`
  actor, outranking the body's `reviewedBy` (a client cannot forge attribution);
- `POST /api/admin/startups/[domain]/moderate` and
  `POST /api/admin/startups/moderate-batch` write the name as the moderator, and
  one `PROFILE_MODERATED` audit row per domain (batch);
- an unmatched or missing token is a **403 with no negotiation** — never a 401
  challenge, never a partial action. The check is constant-time and runs before
  any write.

Procedure to move from the shared token to named operators:

1. Keep `ADMIN_TOKEN` as it is; that is the fallback identity `"operator"`.
2. Add `ADMIN_TOKENS=danil:<token1>,ops:<token2>` in Vercel. Redeploy.
3. Each named token can now act; both are accepted. Verify with a harmless read
   and confirm the name appears:

   ```sh
   curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
     "$APP_URL/api/admin/startups/<domain>/moderate" | jq .
   ```

   The GET reports the resolved `operatorIdentity` (null when the shared token was
   used).
4. Watch `/api/jobs/reconcile` and the `AuditLog` for `actorRef` values: attribution
   is your check that the list is wired.

**Revoking one operator is one edit**: remove that `name:token` pair from
`ADMIN_TOKENS` and redeploy. The other operators are unaffected — that is the
whole point of the list, and it is why the list is preferred over sharing
`ADMIN_TOKEN` between people. When the last named operator exists, delete
`ADMIN_TOKEN` entirely (an empty `ADMIN_TOKENS` returns the app to single-token
posture, in which case `ADMIN_TOKEN` is again required).

Rotate by adding the new token under the same name, deploying, confirming an
action lands, then deleting the old entry — one person, one line at a time.

## `CRON_SECRET` (two consoles, or the clock stops)

`CRON_SECRET` is the bearer credential for every job route
(`/api/jobs/config|reconcile|outbox|screenshot|abandoned-checkouts`) — no query
string, no body secret over GET. It is read by:

- the Vercel app (the routes), and
- the GitHub workflow `.github/workflows/outbox-tick.yml` (the caller).

Procedure:

1. Change the value in **both** places (`gh secret set CRON_SECRET`, Vercel env),
   then deploy the app.
2. Run the tick by hand to prove the workflow's copy is right:

   ```sh
   gh workflow run outbox-tick.yml
   gh run list --workflow=outbox-tick.yml --limit 3
   gh run view <run-id> --log | grep -E "Config|Reconcile|Outbox"
   ```

   A 401 in the log means one of the two stores still holds the old value; a 200
   with a JSON body means both agree.
3. Verify the app's copy independently:

   ```sh
   curl -sS -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/jobs/config"
   ```

   **403/401 here is the fail-closed answer, and the pinger uses the same route:
   if this stops returning 200, the external alarm starts reporting 503 and you
   will not notice the second failure because the first one already made the
   alarm noisy.** Fix the app's copy before leaving.

## `CLICK_SALT` (do not rotate casually)

Click ids are HMACs over the visitor's address and a daily bucket, salted with
`CLICK_SALT`. Rotating it does not break anything loudly: it silently makes every
existing click event unresolvable, so dedupe and any future abuse query lose
their history. Treat it as **data continuity**, not as a credential:

- only rotate on suspected compromise, and treat that as an incident;
- if it must rotate, record the rotation date next to the affected analytics
  window (there is no column that stores which salt hashed a row).

## `unsubToken` (never bulk-regenerate)

Unsubscribe links are `Startup.unsubToken`, a stored per-listing value, not a
hash of the address. Regenerating them en masse invalidates links already sitting
in buyers' inboxes — every "unsubscribe" click then fails, one at a time, quietly.
Rotate a **single** token only if that specific link leaked.

## `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET`

`RESEND_API_KEY` unset means `mailDriver() === "logged"`: mail is written to
`EmailLog` and **not sent**. That is the intended development posture and a
production incident if it happens there — `/api/jobs/config`'s `mail` block and
reconcile's `outbox` block report the driver for exactly this reason
(`email.md`). Rotate in Resend, then in Vercel, then send a test and confirm the
`EmailLog` row is `sent` with a `providerMessageId`.

`RESEND_WEBHOOK_SECRET` authenticates bounces/complaints at
`POST /api/webhooks/resend`. Rotate it in Resend's webhook page and Vercel
together; while unset or mismatched, every delivery is refused 401 and bounces
never reach `EmailSuppression` — the buyer-facing consequence is in
`takedown.md` §"Addresses we may not mail".

## The rest of the map

Six rows of `doc/review/17-operator-tooling-and-runbooks.md` §5.8 have no
procedure worth a section of their own, because the rotation *is* the change.
They are listed here so the map is complete and nobody has to guess which console
or which order applies.

| Secret | Lives in | Consequence, and the order |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys, and the Vercel env | Fails checkout **closed** until the new value deploys — which is exactly the emergency brake (`rollback.md`), so rotate it deliberately. Order: create in Stripe, set in Vercel, deploy, confirm one checkout, then revoke the old key. |
| `DATABASE_URL` | A Neon role, and the Vercel env | Rolled with a deploy; revoke the old role in Neon **after** the deploy lands. Branch/PITR access is a separate credential — the restore procedure is `database.md`. |
| `TURNSTILE_SECRET` / `NEXT_PUBLIC_TURNSTILE_SITEKEY` | Cloudflare Turnstile, and the Vercel env (the sitekey is **build-time**) | A mismatched pair fails every checkout. Order: rotate in Cloudflare, then both Vercel names, then deploy; only a preview checkout proves the pair matches, because the sitekey is baked in at build time. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Upstash, and the Vercel env (**absent in production today**) | Nothing breaks on rotation, because nothing reads them yet. Setting the pair is the `D15` decision rather than hygiene: until then rate limits are per-instance memory and fail open (`lib/rateStore.ts`), and `abuse-wave.md` §2 carries the edge lever that compensates. |
| `EMAIL_FROM`, `REPORT_NOTIFY_EMAIL`, `WAITLIST_EMAIL` | The Vercel env, against the verified Resend domain | A sender the domain does not own, or a mailbox that was retired, stops delivery with nothing to see on our side (`email.md` §4 reads the register per address). Change these with the mailbox, and send one test afterwards. |
| `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` | The Vercel env (**build-time**, unset today) | Unset means no script loads and no notice is owed. Turning it on is the consent decision recorded as `D6` in `16`, not a rotation. |

## After any rotation

- Re-run `curl .../api/jobs/config | jq`. `findings` should name only the
  advisories you have deliberately left set.
- Note the date and which secret moved in the incident/ops log — the console
  history is not a changelog, and `D12`'s custody answer only works if rotations
  are recorded somewhere a second person can read.
