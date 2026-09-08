import { PaymentStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { settlePayment } from "./settle";

/**
 * Idempotent paid-apply for a Payment (Phase 2: delegates to settlePayment,
 * which commits event-claim + reservation + stake + paid-transition + outbox
 * in ONE transaction — P0-02. The conditional-claim + duplicate-event guards
 * inside settle make double delivery apply exactly once).
 * Returns true when this call applied the stake.
 */
export async function markPaidAndApply(paymentId: string, providerRef?: string): Promise<boolean> {
  const outcome = await settlePayment(paymentId, {
    provider: "dev",
    eventId: `dev-manual-${paymentId}`,
    eventType: "dev.manual",
    paid: true,
    providerRef: providerRef ?? null,
  });
  return outcome.outcome === "applied";
}

/** Mark a payment failed (dev sim "fail" button / failed webhook). Idempotent. */
export async function markFailed(paymentId: string): Promise<void> {
  await prisma.payment.updateMany({
    where: { id: paymentId, status: PaymentStatus.PENDING },
    data: { status: PaymentStatus.FAILED, failedAt: new Date() },
  });
}
