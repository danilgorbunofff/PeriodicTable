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
import { enqueueOutbox, drainDue } from "./outbox";
import { audit } from "./audit";
import { withTxnRetry } from "./txn";

export type SettleEvent = {
  provider: "whop" | "dev";
  eventId: string; // globally unique per delivery ("whop:..." / "dev-...")
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
  provider: "whop" | "dev";
  eventId: string;
  eventType: string;
  /** Which status/type matched (whopPayloadReversal) — recorded for operators. */
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

/** Record a provider delivery outcome (best-effort, never throws). */
async function recordEvent(params: {
  provider: "whop" | "dev";
  eventId: string;
  eventType: string;
  paymentId: string | null;
  outcome: ProviderEventOutcome;
  detail?: string;
  payload?: unknown;
}): Promise<void> {
  try {
    await prisma.providerEvent.upsert({
      where: { providerEventId: params.eventId },
      create: {
        provider: params.provider === "whop" ? "WHOP" : "DEV",
        providerEventId: params.eventId,
        eventType: params.eventType,
        paymentId: params.paymentId,
        outcome: params.outcome,
        detail: params.detail ?? null,
        payload: (params.payload ?? {}) as object,
      },
      update: { outcome: params.outcome, detail: params.detail ?? null },
    });
  } catch (e) {
    console.error("provider event record failed (non-blocking):", e);
  }
}

export async function settlePayment(paymentId: string, event: SettleEvent): Promise<SettleOutcome> {
  // Duplicate delivery guard: same event id twice = one application.
  const seen = await prisma.providerEvent.findUnique({ where: { providerEventId: event.eventId } });
  if (seen) {
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
      if (reservation && reservation.status === "ACTIVE") {
        if (reservation.expiresAt.getTime() <= Date.now()) {
          await tx.claimReservation.update({
            where: { id: reservation.id },
            data: { status: ReservationStatus.EXPIRED },
          });
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
          },
        });
      }
      if (result.info.dethroned && result.info.oldLeader) {
        const victim = await tx.startup.findUnique({ where: { domain: result.info.oldLeader.domain } });
        if (victim?.email) {
          await enqueueOutbox(tx, {
            type: "OUTBID_EMAIL",
            dedupeKey: `outbid-${paymentId}`,
            payload: {
              to: victim.email,
              unsubToken: victim.unsubToken,
              elementSymbol: element.symbol,
              victimTotal: result.info.oldLeader.amountUsd,
              winnerDomain: result.info.newLeader.domain,
              winnerAmount: result.info.newLeader.amountUsd,
            },
          });
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
        { isolationLevel: "Serializable" }
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
    // Best-effort inline delivery; rows persist for the Phase 6 worker on failure.
    void drainDue().catch((e) => console.error("post-settle drain failed:", e));
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
  // Duplicate delivery guard: the same event id twice is one reversal.
  const seen = await prisma.providerEvent.findUnique({ where: { providerEventId: event.eventId } });
  if (seen) return { outcome: "duplicate", paymentId };

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

          // Deliberately no buyer email. The provider's own reversal notice is
          // authoritative, and RECEIPT_EMAIL would render a "receipt" for money
          // going back — the wrong document entirely. Operators get the audit
          // row; the public feed gets the ActivityLog row from the unwind.
          return reversed;
        },
        { isolationLevel: "Serializable" }
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
