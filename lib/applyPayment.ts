import { prisma } from "./prisma";
import { applyStakeTx } from "./recompute";
import { sendOutbidEmail, sendReceiptEmail } from "./email";

/**
 * Idempotent paid-apply for a Payment. The pending→paid transition is guarded by
 * a single conditional updateMany, so double webhook delivery applies exactly once.
 * Returns null when the payment was already processed (or doesn't exist/pending mismatch).
 */
export async function markPaidAndApply(paymentId: string, providerRef?: string): Promise<boolean> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.status !== "pending") return false;

  const claimed = await prisma.payment.updateMany({
    where: { id: paymentId, status: "pending" },
    data: { status: "paid", paidAt: new Date(), ...(providerRef ? { providerRef } : {}) },
  });
  if (claimed.count === 0) return false; // lost race — another delivery already applied

  const result = await applyStakeTx({
    elementId: payment.elementId,
    startupId: payment.startupId,
    addUsd: payment.amountUsd,
    kind: payment.path === "join" ? "join" : "stake",
  });

  // If this payment dethroned someone, email the victim an exact reclaim quote.
  if (result.info.dethroned && result.info.oldLeader) {
    const victim = await prisma.startup.findUnique({
      where: { domain: result.info.oldLeader.domain },
      select: { id: true, email: true, unsubToken: true },
    });
    if (victim?.email) {
      await sendOutbidEmail({
        to: victim.email,
        unsubToken: victim.unsubToken,
        elementSymbol: result.element.symbol,
        victimTotal: result.info.oldLeader.amountUsd,
        winnerDomain: result.info.newLeader.domain,
        winnerAmount: result.info.newLeader.amountUsd,
      });
    } else if (victim) {
      // Unsubscribed / no email → log suppression for debugging (spec 02 acceptance).
      const { prisma: prismaClient } = await import("./prisma");
      await prismaClient.emailLog.create({
        data: {
          to: result.info.oldLeader.domain,
          template: "outbid",
          elementSymbol: result.element.symbol,
          amountUsd: Math.max(1, result.info.newLeader.amountUsd + 1 - result.info.oldLeader.amountUsd),
          status: "suppressed",
          detail: "no email on file (unsubscribed or never provided)",
        },
      });
    }
  }

  // Receipt to the winner/payer.
  const payer = await prisma.startup.findUnique({
    where: { id: payment.startupId },
    select: { email: true, unsubToken: true, domain: true },
  });
  const receiptTo = payment.email ?? payer?.email ?? null;
  if (receiptTo && payer) {
    await sendReceiptEmail({
      to: receiptTo,
      unsubToken: payer.unsubToken,
      elementSymbol: result.element.symbol,
      elementName: await prisma.element
        .findUnique({ where: { id: payment.elementId }, select: { name: true } })
        .then((e) => e?.name ?? result.element.symbol),
      amountUsd: payment.amountUsd,
      rank: result.stake.rank,
      domain: payer.domain,
    });
  }

  return true;
}

/** Mark a payment failed (dev sim "fail" button / failed webhook). Idempotent. */
export async function markFailed(paymentId: string): Promise<void> {
  await prisma.payment.updateMany({
    where: { id: paymentId, status: "pending" },
    data: { status: "failed" },
  });
}
