/**
 * Atomic payment settlement (Phase 2, P0-02).
 *
 * ONE transaction commits: provider-event claim, reservation validation /
 * consumption, stake application, rank/leader/aggregate persistence, the
 * payment paid-transition (stakeId + appliedAt), and outbox enqueues for
 * receipt / outbid / preview / analytics. A payment can no longer be marked
 * paid without its stake being durably applied — any failure between the old
 * two transactions now rolls everything back and stays retryable.
 *
 * Per-element serialization: the transaction takes a transaction-scoped
 * advisory lock on the element id, so concurrent settles (and Phase 2
 * take-checkouts, which take the same lock) cannot interleave. Full invariant
 * asserts + retry policy land in Phase 3.
 */
import { PaymentPath, PaymentStatus, ProviderEventOutcome, ReservationStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { applyStakeTx, reverseStakeTx } from "./recompute";
import { consumeReservation } from "./reservations";
import { enqueueOutbox, drainDueWithin } from "./outbox";
import { audit } from "./audit";
import { withTxnRetry, MONEY_TX } from "./txn";

export type SettleEvent = {
  provider: "stripe" | "dev";
  eventId: string; // globally unique per delivery ("stripe:..." / "dev-...")
  eventType: string;
  paid: boolean;
  /** The PROVIDER's claimed amount, not ours — settled against
   * `payment.amountUsd` and stored as audit metadata (`providerAmount`).
   * Null/absent means the provider stated no figure; that is recorded as
   * amount-unverified rather than silently treated as agreement. */
  amountUsd?: number | null;
  currency?: string | null;
  providerRef?: string | null;
  /** The provider stated no amount, so nothing could be cross-checked. */
  amountUnverified?: boolean;
};

export type SettleOutcome =
  | { outcome: "applied"; paymentId: string; stakeId: string; elementSymbol: string }
  | { outcome: "duplicate" | "already-settled"; paymentId: string }
  | { outcome: "failed"; paymentId: string; reason: string }
  | { outcome: "rejected"; paymentId: string; reason: string }
  | { outcome: "not-found"; paymentId: string };

/**
 * A money-reversing provider delivery (refund / chargeback / dispute).
 *
 * Deliberately narrower than SettleEvent: no amount and no currency. A partial
 * refund and a full chargeback both arrive as a reversal, and a provider figure
 * we cannot reconcile must never block the unwind — the stake comes off for the
 * amount we charged (`payment.amountUsd`), which is the only figure the ledger
 * ever used.
 */
export type ReversalEvent = {
  provider: "stripe" | "dev";
  eventId: string;
  eventType: string;
  /** Which status/type matched (stripePayloadReversal) — recorded for operators. */
  reversal: string;
  payload?: unknown;
};

export type ReversalOutcome =
  | { outcome: "reversed"; paymentId: string; remainingUsd: number; elementSymbol: string }
  | { outcome: "already-reversed" | "duplicate" | "not-found" | "not-paid"; paymentId: string }
  | { outcome: "rejected"; paymentId: string; reason: string };

function logSettle(msg: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ scope: "settle", msg, ...fields }));
}

/** Inline mail delivery must finish before the webhook response is flushed, but
 *  must not hold it open for a stalled provider call (deliver() times out at 10s). */
const SETTLE_MAIL_DRAIN_BUDGET_MS = 15_000;

/** How a further delivery for an event id already on file is written down.
 *
 * The register is evidence (R08-1). A row that recorded a DECISION is final:
 * a replayed `checkout.session.completed` used to overwrite the APPLIED row
 * with `duplicate` and erase the detail that explained it, so the only record
 * of the delivery that moved the money read as though nothing had happened.
 * A terminal outcome is therefore never rewritten at all — a replay of a
 * settled event writes nothing, and `detail` is never nulled by a delivery that
 * carries none.
 *
 * A retryable ERROR row is the one exception: it exists to say "this attempt
 * failed", and a later attempt for the same id must be able to replace it —
 * both duplicate guards in this file skip it for the same reason.
 *
 * Returns null when nothing may be written at all. */
export function providerEventUpdate(
  prior: { outcome: ProviderEventOutcome; detail: string | null } | null,
  next: { outcome: ProviderEventOutcome; detail?: string | null }
): { outcome: ProviderEventOutcome; detail: string | null } | null {
  if (prior && prior.outcome !== ProviderEventOutcome.ERROR) return null;
  // The new delivery's own reason wins: a retry that fails again replaces the
  // message, and a retry that succeeds (an operator corrected the amount, say)
  // must not leave the old rejection text next to `applied`. The one thing that
  // must never happen — an absent detail erasing the only explanation of an
  // ERROR row — can only arise for another ERROR write, which keeps what it has.
  return {
    outcome: next.outcome,
    detail: next.detail ?? (next.outcome === ProviderEventOutcome.ERROR ? prior?.detail ?? null : null),
  };
}

/** Write a delivery to the register (throws — callers decide what a failed
 *  write may cost; `recordEvent` below swallows it, the webhook route does not).
 *
 * The single writer for every route and both settle functions, so the
 * precedence rule above cannot be applied inconsistently. */
export async function recordProviderEvent(params: {
  provider: "stripe" | "dev";
  eventId: string;
  eventType: string;
  paymentId: string | null;
  outcome: ProviderEventOutcome;
  detail?: string | null;
  payload?: unknown;
}): Promise<void> {
  // Attribution is copied, not joined (R08-7): paymentId is ON DELETE SET NULL,
  // so once a payment is deleted its register rows are the only surviving record
  // of which element and startup the delivery concerned. Resolved here so that
  // no call site can forget it.
  const attribution = params.paymentId
    ? await prisma.payment.findUnique({
        where: { id: params.paymentId },
        select: { elementId: true, startupId: true },
      })
    : null;
  const prior = await prisma.providerEvent.findUnique({
    where: { providerEventId: params.eventId },
    select: { outcome: true, detail: true },
  });
  const patch = providerEventUpdate(prior, { outcome: params.outcome, detail: params.detail ?? null });
  // A terminal row is never rewritten, so a replay is not a write at all — the
  // register is append-only per delivery (R08-1). Returning here also keeps the
  // upsert's `update` provably non-empty.
  if (!patch) return;
  await prisma.providerEvent.upsert({
    where: { providerEventId: params.eventId },
    create: {
      provider: params.provider === "stripe" ? "STRIPE" : "DEV",
      providerEventId: params.eventId,
      eventType: params.eventType,
      paymentId: params.paymentId,
      elementId: attribution?.elementId ?? null,
      startupId: attribution?.startupId ?? null,
      outcome: params.outcome,
      detail: params.detail ?? null,
      payload: (params.payload ?? {}) as object,
    },
    update: {
      ...patch,
      // A row that may be rewritten is only ever a failed attempt, and the
      // delivery that replaces it is brought up to date on the fields the
      // failure could not fill in: an ERROR row for a payment that did not exist
      // yet carries no paymentId, so promoting it to APPLIED would otherwise
      // leave the money-moving line unable to say which payment moved (R08-7).
      // Spreading conditionally means nothing is written back to null.
      ...(params.paymentId
        ? {
            paymentId: params.paymentId,
            elementId: attribution?.elementId ?? null,
            startupId: attribution?.startupId ?? null,
          }
        : {}),
      ...(params.payload !== undefined ? { payload: params.payload as object } : {}),
    },
  });
}

/** Record a provider delivery outcome (best-effort, never throws). */
async function recordEvent(params: Parameters<typeof recordProviderEvent>[0]): Promise<void> {
  try {
    await recordProviderEvent(params);
  } catch (e) {
    console.error("provider event record failed (non-blocking):", e);
  }
}

export async function settlePayment(paymentId: string, event: SettleEvent): Promise<SettleOutcome> {
  // Duplicate delivery guard: same event id twice = one application — but only
  // for deliveries that reached a DECISION. The catch block below records an
  // ERROR row *before* rethrowing a retryable failure, so a redelivered event
  // finds its own failed attempt on file; treating that as "seen" would answer
  // 200 duplicate while the payment is still PENDING — money captured, nothing
  // applied, unrecoverable except by hand. Nothing was written by that attempt
  // (the transaction rolled back), and the real double-apply guard is the
  // status re-check under the per-element advisory lock below.
  const seen = await prisma.providerEvent.findUnique({ where: { providerEventId: event.eventId } });
  if (seen && seen.outcome !== ProviderEventOutcome.ERROR) {
    return { outcome: "duplicate", paymentId };
  }

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) {
    await recordEvent({ ...event, paymentId: null, outcome: "ERROR", detail: "unknown-payment" });
    return { outcome: "not-found", paymentId };
  }
  if (payment.status !== PaymentStatus.PENDING) {
    await recordEvent({ ...event, paymentId, outcome: "DUPLICATE", detail: `already-${payment.status.toLowerCase()}` });
    return { outcome: "already-settled", paymentId };
  }

  if (!event.paid) {
    await prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.FAILED, failedAt: new Date() },
    });
    await recordEvent({ ...event, paymentId, outcome: "FAILED", detail: event.eventType });
    logSettle("payment-failed", { paymentId, eventId: event.eventId, eventType: event.eventType });
    return { outcome: "failed", paymentId, reason: event.eventType };
  }

  try {
    const applied = await withTxnRetry(() =>
      prisma.$transaction(
        async (tx) => {
      // Serialize per element (matches checkout-take lock in Phase 2 route).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${payment.elementId})`;
      // Re-check pending under the lock (a concurrent settle may have won).
      const locked = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      if (locked.status !== PaymentStatus.PENDING) return null;

      // Reservation: consume when valid; expire-and-continue when stale.
      const reservation = await tx.claimReservation.findUnique({ where: { paymentId } });
      let takeGuaranteed = false;
      // R09-2: the figure the quote held when it lapsed. A lapsed take is still
      // applied — the money is real and the ledger has no refund path for a
      // PENDING row — but the downgrade is recorded and receipted at the rank
      // the board granted, not the #1 the quote promised.
      let lapsedTakeTotal: number | null = null;
      if (reservation && reservation.status === "ACTIVE") {
        if (reservation.expiresAt.getTime() <= Date.now()) {
          await tx.claimReservation.update({
            where: { id: reservation.id },
            data: { status: ReservationStatus.EXPIRED },
          });
          lapsedTakeTotal = reservation.reservedTotal;
        } else {
          if (payment.amountUsd < reservation.reservedTotal) {
            throw new Error(`take-below-reserve:${payment.amountUsd}<${reservation.reservedTotal}`);
          }
          takeGuaranteed = true;
        }
      }

      const result = await applyStakeTx(
        {
          elementId: payment.elementId,
          startupId: payment.startupId,
          addUsd: payment.amountUsd,
          kind: payment.path === PaymentPath.JOIN ? "join" : payment.path === PaymentPath.RECLAIM ? "reclaim" : "stake",
          paymentId,
        },
        tx
      );

      if (lapsedTakeTotal != null) {
        await audit(
          {
            action: "TAKE_LAPSED",
            elementId: payment.elementId,
            startupId: payment.startupId,
            paymentId,
            detail: `take-lapsed:${result.stake.rank}`,
          },
          tx
        );
      }

      if (reservation && takeGuaranteed) {
        await consumeReservation(tx, reservation.id);
      } else if (reservation) {
        await tx.claimReservation.update({
          where: { id: reservation.id },
          data: { status: ReservationStatus.EXPIRED },
        });
      }

      const element = await tx.element.findUniqueOrThrow({ where: { id: payment.elementId } });
      const payer = await tx.startup.findUniqueOrThrow({ where: { id: payment.startupId } });

      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          stakeId: result.stake.id,
          appliedAt: new Date(),
          ...(event.providerRef ? { providerRef: event.providerRef } : {}),
          ...(event.amountUsd != null ? { providerAmount: Math.round(event.amountUsd) } : {}),
          ...(event.currency ? { providerCurrency: event.currency } : {}),
          providerEventId: event.eventId,
        },
      });

      // Durable notifications (Phase 6 delivers at scale; drainDue runs inline now).
      const receiptTo = payment.email ?? payer.email ?? null;
      if (receiptTo) {
        await enqueueOutbox(tx, {
          type: "RECEIPT_EMAIL",
          dedupeKey: `receipt-${paymentId}`,
          payload: {
            to: receiptTo,
            unsubToken: payer.unsubToken,
            elementSymbol: element.symbol,
            elementName: element.name,
            amountUsd: payment.amountUsd,
            rank: result.stake.rank,
            domain: payer.domain,
            ...(lapsedTakeTotal != null ? { lapsedTakeTotal } : {}),
          },
        });
      }
      if (result.info.dethroned && result.info.oldLeader) {
        const victim = await tx.startup.findUnique({ where: { domain: result.info.oldLeader.domain } });
        // R09-7: an address may be on file even when the startup has none — the
        // payment that funded the crowned stake captured one at checkout. A
        // holder is only unreachable when both are missing, and that is
        // recorded instead of silently dropped.
        const fundingEmail = victim
          ? await tx.payment.findFirst({
              where: {
                elementId: payment.elementId,
                startupId: victim.id,
                status: PaymentStatus.PAID,
                email: { not: null },
              },
              orderBy: { paidAt: "desc" },
              select: { email: true },
            })
          : null;
        const victimEmail = victim?.email ?? fundingEmail?.email ?? null;
        if (victim && victimEmail) {
          await enqueueOutbox(tx, {
            type: "OUTBID_EMAIL",
            dedupeKey: `outbid-${paymentId}`,
            payload: {
              to: victimEmail,
              unsubToken: victim.unsubToken,
              elementSymbol: element.symbol,
              victimDomain: victim.domain,
              victimTotal: result.info.oldLeader.amountUsd,
              winnerDomain: result.info.newLeader.domain,
              winnerAmount: result.info.newLeader.amountUsd,
            },
          });
        } else {
          await audit(
            {
              action: "OUTBID_UNNOTIFIED",
              elementId: payment.elementId,
              startupId: victim?.id ?? null,
              paymentId,
              detail: `no-address:${result.info.oldLeader.domain}`,
            },
            tx
          );
        }
      }
      await enqueueOutbox(tx, {
        type: "PREVIEW_GENERATE",
        dedupeKey: `preview-${payer.id}`,
        payload: { startupId: payer.id, url: payer.url },
      });
      await enqueueOutbox(tx, {
        type: "STAKE_ANALYTICS",
        dedupeKey: `analytics-${paymentId}`,
        payload: {
          paymentId,
          elementSymbol: element.symbol,
          amountUsd: payment.amountUsd,
          kind: payment.path.toLowerCase(),
        },
      });

      return { stakeId: result.stake.id, elementSymbol: element.symbol };
        },
        MONEY_TX
      )
    );

    if (!applied) {
      await recordEvent({ ...event, paymentId, outcome: "DUPLICATE", detail: "lost-settle-race" });
      return { outcome: "already-settled", paymentId };
    }

    await recordEvent({
      ...event,
      paymentId,
      outcome: "APPLIED",
      detail: event.amountUnverified ? "amount-unverified:provider-stated-none" : undefined,
    });
    logSettle("payment-applied", {
      paymentId,
      eventId: event.eventId,
      element: applied.elementSymbol,
      stakeId: applied.stakeId,
    });
    // Awaited, bounded: see drainDueWithin. Mail is drained inline (it is the
    // part the buyer sees); preview/analytics stay on the worker's tick.
    try {
      const drained = await drainDueWithin(SETTLE_MAIL_DRAIN_BUDGET_MS, 10, ["RECEIPT_EMAIL", "OUTBID_EMAIL"]);
      logSettle("post-settle-drain", { paymentId, eventId: event.eventId, ...drained });
    } catch (e) {
      // Delivery must never turn an already-durable settle into a retryable 5xx.
      console.error("post-settle mail drain failed (non-blocking):", e);
    }
    return { outcome: "applied", paymentId, stakeId: applied.stakeId, elementSymbol: applied.elementSymbol };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await recordEvent({ ...event, paymentId, outcome: "ERROR", detail: reason.slice(0, 300) });
    // Deterministic validation failures (immutable amount vs reserved total,
    // ledger-invariant asserts) can never succeed on redelivery — terminal.
    if (reason.startsWith("take-below-reserve:") || reason.startsWith("ledger-invariant:")) {
      logSettle("settle-error-terminal", { paymentId, eventId: event.eventId, reason: reason.slice(0, 200) });
      return { outcome: "rejected", paymentId, reason: reason.slice(0, 300) };
    }
    logSettle("settle-error-retryable", { paymentId, eventId: event.eventId, reason: reason.slice(0, 200) });
    throw e; // retryable: webhooks return non-2xx so the provider redelivers
  }
}

/**
 * Reverse a settled payment (refund / chargeback / dispute).
 *
 * Mirrors settlePayment's shape: dedupe on the provider event id, serialize on
 * the same per-element advisory lock, re-check the payment status under that
 * lock, and unwind the stake with the ledger invariants asserted before commit.
 * A payment can never read REFUNDED without its stake being durably reduced,
 * and a redelivered reversal can never subtract twice.
 *
 * Why this exists: reversals used to satisfy neither `paid` nor `failed`, so
 * they fell through to IGNORED/unrelated-event — the network returned the
 * buyer's money while the stake stayed on the board and in the pool. Declining
 * refunds is published policy, but a chargeback is not a policy you can decline.
 */
export async function reversePayment(paymentId: string, event: ReversalEvent): Promise<ReversalOutcome> {
  // Duplicate delivery guard: the same event id twice is one reversal — except
  // for a delivery that recorded a retryable ERROR (see settlePayment): that
  // attempt rolled back, so it must be allowed to run again.
  const seen = await prisma.providerEvent.findUnique({ where: { providerEventId: event.eventId } });
  if (seen && seen.outcome !== ProviderEventOutcome.ERROR) return { outcome: "duplicate", paymentId };

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) {
    await recordEvent({ ...event, paymentId: null, outcome: "ERROR", detail: "unknown-payment" });
    return { outcome: "not-found", paymentId };
  }

  if (payment.status === PaymentStatus.REFUNDED) {
    await recordEvent({ ...event, paymentId, outcome: "REFUNDED", detail: `already-reversed:${event.reversal}` });
    return { outcome: "already-reversed", paymentId };
  }

  if (payment.status !== PaymentStatus.PAID) {
    // Nothing was ever applied, so there is no stake to unwind. A PENDING
    // payment is closed as REFUNDED so a late paid delivery cannot apply a
    // stake for money the provider already gave back; FAILED stays FAILED,
    // which is the accurate description of a checkout that never settled.
    if (payment.status === PaymentStatus.PENDING) {
      await prisma.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.REFUNDED, refundedAt: new Date() },
      });
    }
    await recordEvent({
      ...event,
      paymentId,
      outcome: "REFUNDED",
      detail: `reversed-before-paid:${payment.status.toLowerCase()}:${event.reversal}`,
    });
    // No buyer mail: nothing was ever applied, so there is no position of
    // theirs to explain, and the provider's own refund notice is the complete
    // record for a payment we never acted on (R08-2 covers the reversal of a
    // stake that did exist).
    logSettle("reverse-before-paid", { paymentId, eventId: event.eventId, priorStatus: payment.status });
    return { outcome: "not-paid", paymentId };
  }

  try {
    const result = await withTxnRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // Same lock as settle / apply / take-checkout: no interleaving.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${payment.elementId})`;
          // Re-check under the lock — a concurrent reversal may have won.
          const locked = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
          if (locked.status !== PaymentStatus.PAID) return null;

          const reversed = await reverseStakeTx(
            { elementId: locked.elementId, startupId: locked.startupId, removeUsd: locked.amountUsd, paymentId },
            tx
          );

          await tx.payment.update({
            where: { id: paymentId },
            data: { status: PaymentStatus.REFUNDED, refundedAt: new Date() },
          });

          await audit(
            {
              action: "PAYMENT_REVERSED",
              startupId: locked.startupId,
              elementId: locked.elementId,
              paymentId,
              detail: `${event.reversal} removedUsd=${locked.amountUsd} remainingUsd=${reversed.remainingUsd}`,
            },
            tx
          );

          // The buyer is told (R08-2). A reversal used to be silent on the
          // argument that the provider's own notice is authoritative — true,
          // and not enough: that notice says nothing about the listing, and the
          // local record is the one the buyer can point at. REFUND_EMAIL, never
          // RECEIPT_EMAIL: a receipt for money going back would document a
          // purchase that no longer stands.
          const element = await tx.element.findUniqueOrThrow({ where: { id: locked.elementId } });
          const payer = await tx.startup.findUniqueOrThrow({ where: { id: locked.startupId } });
          const refundTo = locked.email ?? payer.email ?? null;
          if (refundTo) {
            await enqueueOutbox(tx, {
              type: "REFUND_EMAIL",
              dedupeKey: `refund-${paymentId}`,
              payload: {
                to: refundTo,
                unsubToken: payer.unsubToken,
                elementSymbol: element.symbol,
                elementName: element.name,
                amountUsd: locked.amountUsd,
                domain: payer.domain,
                // Captured at reversal time: providerRef is what the buyer
                // quotes to their bank, and it is the session reference for
                // this charge.
                providerRef: locked.providerRef,
              },
            });
          }

          // Deliberately no RECEIPT_EMAIL and no OUTBID_EMAIL here: nobody won
          // anything, and the stake coming off the board is the ActivityLog row
          // from the unwind. Operators get the audit row above.
          return reversed;
        },
        MONEY_TX
      )
    );

    if (!result) {
      await recordEvent({ ...event, paymentId, outcome: "DUPLICATE", detail: "lost-reversal-race" });
      return { outcome: "already-reversed", paymentId };
    }

    await recordEvent({ ...event, paymentId, outcome: "REFUNDED", detail: event.reversal });
    logSettle("payment-reversed", {
      paymentId,
      eventId: event.eventId,
      element: result.elementSymbol,
      remainingUsd: result.remainingUsd,
    });
    // Same bounded inline delivery as a settle: the refund notice is durable
    // either way (the outbox row is committed), this just gets it out now.
    try {
      const drained = await drainDueWithin(SETTLE_MAIL_DRAIN_BUDGET_MS, 10, [
        "REFUND_EMAIL",
        "RECEIPT_EMAIL",
        "OUTBID_EMAIL",
      ]);
      logSettle("post-reversal-drain", { paymentId, eventId: event.eventId, ...drained });
    } catch (e) {
      console.error("post-reversal mail drain failed (non-blocking):", e);
    }
    return { outcome: "reversed", paymentId, remainingUsd: result.remainingUsd, elementSymbol: result.elementSymbol };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await recordEvent({ ...event, paymentId, outcome: "ERROR", detail: reason.slice(0, 300) });
    // A ledger that disagrees with itself can never be fixed by redelivery:
    // terminal, routed to operator review. Everything else retries.
    if (reason.startsWith("ledger-invariant:")) {
      logSettle("reverse-error-terminal", { paymentId, eventId: event.eventId, reason: reason.slice(0, 200) });
      return { outcome: "rejected", paymentId, reason: reason.slice(0, 300) };
    }
    logSettle("reverse-error-retryable", { paymentId, eventId: event.eventId, reason: reason.slice(0, 200) });
    throw e;
  }
}
