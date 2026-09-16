# When the site is down or degraded: what we say

Finding: R17-15. Related: `README.md` (the pinger and the clock — the same
signals a customer's complaint will be about), `payments-stuck.md` (the money
branch of an outage), `refunds-and-disputes.md` (the aftermath), and the
wind-down notice below (R20-15, the one message with a date the rules page
promises).

**Where the message goes, who writes it and which channel carries it is operator
decision D16** (`doc/review/FINDINGS.md`). The repo cannot create an account for
you. What it can do is fix the *content* in advance so no one is drafting under
pressure, and make sure the one sentence a customer needs is on hand — the
product records everything the message has to assert.

Until D16 is answered, the minimum viable channel is the account that already
exists: the buyer's own receipt address, the listing owner's `Startup.email`, and
`REPORT_NOTIFY_EMAIL` for the operator's own notice. Any message here can go out
by the ordinary retry path (`email.md` §3) if it must, but a **public** status
surface (a hosted page or a pinned post) has no implementation in this repo, so
saying "the status page is green" is not something the product can back up.

## What we can assert, and from where

Write from these facts and no others. Each has a check behind it, so the message
is reproducible rather than reassuring:

| Claim | Check |
| --- | --- |
| "Payments are/are not being recorded." | `curl .../api/jobs/reconcile \| jq '{ok, unapplied, divergent, stale}'` — `unapplied`/`divergent` non-zero means money is not in the state it should be. |
| "Your listing is/ is not visible." | The table itself, plus `moderationState` for the specific domain (an outage is not a hide — do not confuse the two). |
| "Mail is/ is not going out." | `/api/jobs/config` → `mail.driver` (`logged` = nothing is being sent) and reconcile's `outbox`. |
| "We saw your report." | `Report` row + the intake mail to `REPORT_NOTIFY_EMAIL`; a report is durable even if the confirmation mail is not (`email.md`). |
| "It is back." | `ok: true` on reconcile **and** a successful delivery in the Stripe endpoint log — for us, "back" means the ledger agrees, not that the page loaded. |

## Template: planned maintenance

> **Heads up — brief maintenance [window in the reader's timezone].**
> We're doing [work] on [date, start–end]. During the window:
> - the table may load slowly or show stale numbers;
> - new checkout sessions may fail — **if a payment did go through, it will be
>   applied and you will receive the usual receipt**, and nothing is lost by
>   waiting for the window to end;
> - if you have an open report, triage continues after the window.
> Nothing you have bought is affected: stakes are recorded and no listing is
> removed by maintenance. We'll post again when it's done.

Last line only if it is true: nothing in a deploy changes stakes, and moderation
is a separate action — saying it is safe to say when no migration is involved.

## Template: active incident

> **We're having an incident.**
> Started: [time]. Affected: [checkout / the table / email / all of it].
> What you need to know:
> - **Payments:** if you paid and your element did not change, your payment is
>   recorded and will be applied — do not pay twice. Check your receipt at
>   [receipt/Stripe reference]; if it is missing, reply and we will trace
>   `Payment.id` by hand.
> - **Reports:** intake still records reports; confirmations may be delayed.
> - **No money is being taken by us while checkout is unavailable**, and nothing
>   already bought is being removed.
> We update this [channel] every [interval]. Next update by [time].

The "do not pay twice" line is the one that matters most, because
`payments-stuck.md`'s remedy is a provider-side re-delivery, not a second
purchase, and because a degraded checkout that succeeds at the provider but
fails on our page is a real branch (`reversed-before-paid`, `unapplied`).

## Template: resolution

> **Resolved** — [what broke], fixed at [time], [duration].
> What was affected: [scope]. If you bought during the window: your payment was
> applied and the receipt has been sent (or: is being retried now — we will
> follow up individually by [date]). Reports filed during the window were
> triaged on [date].
> What we changed so it does not repeat: [one sentence, only if true].
> Questions: [channel]. We're sorry for the disruption.

## Template: the wind-down notice (R20-15)

This is the one message with a contractual clock on it. `/legal/rules` commits
the board to run at least until **9 September 2027** and promises **30 days'
notice** before any stop, with the notice published on the rules page and by
email to every current holder; the checkout goes off on the day it is published
(not on the day the board stops), and stakes already taken are **not** refunded.
Both dates and the notice window come from `SERVICE_TERM` in `lib/legal.ts` —
read them from there rather than from memory, because the term is extendable and
the copy moves when it is.

> **The board is closing on [date].**
> We said it would run at least until 9 September 2027, and we are [ending it
> then / stopping earlier than the extended date we published on [date]].
> What this means for you:
> - **Checkout is off from today** — no new stakes are being taken.
> - **Stakes are not refunded.** Every stake was final when it was taken, which
>   the rules said at the time of your purchase, and this is that rule applied
>   to the end. [If any goodwill credit is being given: say exactly what, to
>   whom, and when — do not imply a general refund.]
> - **Listings and rankings go offline** with the board on [date]. Nothing of
>   yours is published elsewhere by us.
> - Questions: [channel]. We will answer them until [date].

Who receives it: every `Startup.email` that holds a live stake, and every buyer
whose `Payment.status = 'paid'` exists for that element — the receipt address is
the only address the product is entitled to use (`REFUND_EMAIL`/`OUTBID_EMAIL`
are the same population in practice, and `Payment.email` is the authority).
Where it is published: the rules page itself, because that is where the promise
lives, with the same sentence added to `/faq` so a reader who never opens the
legal pages still meets it.

There is **no `WIND_DOWN_EMAIL` outbox type** — the queue carries receipts,
outbids, refunds, reports, waitlist and previews, and nothing broadcast-shaped
(`lib/outbox.ts`). A wind-down notice is therefore a manual broadcast through
the same provider the receipts use (`email.md`), written by a human and sent
once; if the list is ever large enough that this is not a single send, that is
the point at which the type should exist, and this section is the spec for it.

## Say this, not that

- **Never** "your payment failed" without checking `Payment.status`. Our page can
  fail while the provider's capture succeeded; the ledger is the authority
  (`payments-stuck.md`).
- **Never** "we refunded you". We do not issue refunds from this app; refunds
  appear when the provider reports one (`refunds-and-disputes.md`).
- **Never** "your listing was hidden because of the outage". Outage and
  moderation are different systems; hiding is always an audited operator action
  with a reason.
- **Never** promise a restore window you have not verified (`database.md`'s
  restore section exists precisely because the window is unconfirmed until D11).
- Sign with a name a customer can hold responsible. `16` R16-11 records that the
  outward operator identity is unpublished — decide it (D16) before the first
  incident, not during it.

## Afterwards

Add the incident to whatever log the previous ones live in (date, scope,
detection — was it the pinger, a customer, or the tick? — and the reconcile body
before and after). Two operational facts are worth keeping for the next one:
whether the alarm actually fired (the pinger's 503, or the tick's
`Reconcile — money that contradicts itself` step), and how long the gap was
between the first failed tick and the first human action. That gap is D10's
subject and the only number that makes the staffing answer concrete.
