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
import { applyStakeTx } from "./recompute";
import { consumeReservation } from "./reservations";
import { enqueueOutbox, drainDue } from "./outbox";
import { withTxnRetry } from "./txn";

export type SettleEvent = {
  provider: "whop" | "dev";
  eventId: string; // globally unique per delivery ("whop:..." / "dev-...")
  eventType: string;
  paid: boolean;
  amountUsd?: number | null;
  currency?: string | null;
  providerRef?: string | null;
};

export type SettleOutcome =
  | { outcome: "applied"; paymentId: string; stakeId: string; elementSymbol: string }
  | { outcome: "duplicate" | "already-settled"; paymentId: string }
  | { outcome: "failed"; paymentId: string; reason: string }
  | { outcome: "rejected"; paymentId: string; reason: string }
  | { outcome: "not-found"; paymentId: string };

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

    await recordEvent({ ...event, paymentId, outcome: "APPLIED" });
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
