import { NextRequest, NextResponse } from "next/server";
import { PaymentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  verifyWhopSignature,
  paymentIdFromWhopPayload,
  whopPayloadIsPaid,
  whopPayloadIsFailed,
  whopPayloadReversal,
  whopEventId,
  whopEventType,
  whopMoney,
  validateWhopMoney,
} from "@/lib/whop";
import { settlePayment, reversePayment } from "@/lib/settle";

export const dynamic = "force-dynamic";

/**
 * Whop webhook (Phase 2 rewrite).
 *
 * - Verifies the HMAC signature against raw bytes; 401 otherwise.
 * - Classifies paid ONLY on explicit provider signals (P0-03: statusless or
 *   unknown events are IGNORED with 200 — they must never apply a stake).
 * - Classifies refunds/chargebacks/disputes BEFORE paid/failed and unwinds the
 *   stake (reversePayment): a reversal must never be treated as unrelated.
 * - Validates provider reference, amount, and currency against the local
 *   payment before settling (item 4); mismatches are rejected loudly.
 * - Every delivery is recorded as a ProviderEvent; true duplicates get 200;
 *   settlement is atomic (settlePayment); unexpected failures get non-2xx so
 *   the provider redelivers (item 7).
 */
export async function POST(req: NextRequest) {
  const sig = req.headers.get("x-whop-signature") ?? "";
  const raw = await req.text();

  if (!verifyWhopSignature(raw, sig)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const eventId = whopEventId(payload, raw);
  const eventType = whopEventType(payload);
  const paymentId = paymentIdFromWhopPayload(payload);
  if (!paymentId) {
    await prisma.providerEvent.upsert({
      where: { providerEventId: eventId },
      create: { provider: "WHOP", providerEventId: eventId, eventType, outcome: "IGNORED", detail: "no-paymentId", payload: payload as object },
      update: { outcome: "IGNORED", detail: "no-paymentId" },
    });
    return NextResponse.json({ ok: true, note: "no paymentId in payload" });
  }

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) {
    await prisma.providerEvent.upsert({
      where: { providerEventId: eventId },
      create: { provider: "WHOP", providerEventId: eventId, eventType, outcome: "IGNORED", detail: "unknown-payment", payload: payload as object },
      update: { outcome: "IGNORED", detail: "unknown-payment" },
    });
    // 200: retrying an unknown payment can never succeed.
    return NextResponse.json({ ok: true, note: "unknown payment" });
  }

  // Money-reversing signals (refund / chargeback / dispute) are classified
  // BEFORE paid/failed: a payload can carry both a paid type and a refunded
  // status, and the reversal must win — otherwise the network hands the money
  // back while our ledger keeps the stake on the board and in the pool.
  const reversal = whopPayloadReversal(payload);
  if (reversal) {
    try {
      const outcome = await reversePayment(paymentId, {
        provider: "whop",
        eventId,
        eventType,
        reversal,
        payload: payload as object,
      });
      // Ledger-invariant failures are terminal: 200 + ERROR row routes to
      // operator review rather than a redelivery loop that cannot succeed.
      if (outcome.outcome === "rejected") {
        return NextResponse.json({ ok: false, error: outcome.reason }, { status: 200 });
      }
      return NextResponse.json({ ok: true, outcome: outcome.outcome });
    } catch {
      return NextResponse.json({ ok: false, error: "reverse-retryable" }, { status: 500 });
    }
  }

  const paid = whopPayloadIsPaid(payload);
  const money = whopMoney(payload);

  if (!paid) {
    // Explicit failure → mark failed. Anything else is an unrelated event
    // (P0-03): record IGNORED and leave the pending payment untouched — a
    // noisy event stream must never cancel a real checkout.
    if (!whopPayloadIsFailed(payload)) {
      await prisma.providerEvent.upsert({
        where: { providerEventId: eventId },
        create: { provider: "WHOP", providerEventId: eventId, eventType, paymentId, outcome: "IGNORED", detail: "unrelated-event", payload: payload as object },
        update: { outcome: "IGNORED", detail: "unrelated-event" },
      });
      return NextResponse.json({ ok: true, outcome: "ignored" });
    }
    const outcome = await settlePayment(paymentId, {
      provider: "whop",
      eventId,
      eventType,
      paid: false,
    });
    return NextResponse.json({ ok: true, outcome: outcome.outcome });
  }

  // Paid signal: validate money claims + reference before touching the ledger.
  const moneyErr = validateWhopMoney(payment.amountUsd, money);
  if (moneyErr) {
    await prisma.providerEvent.upsert({
      where: { providerEventId: eventId },
      create: { provider: "WHOP", providerEventId: eventId, eventType, paymentId, outcome: "ERROR", detail: moneyErr, payload: payload as object },
      update: { outcome: "ERROR", detail: moneyErr },
    });
    // Non-2xx is wrong here (redelivery won't fix a mismatch); 200 + ERROR
    // row routes it to operator review instead of retrying forever.
    return NextResponse.json({ ok: false, error: moneyErr }, { status: 200 });
  }
  if (money.providerRef && payment.providerRef && money.providerRef !== payment.providerRef) {
    const detail = `reference-mismatch:${money.providerRef}`;
    await prisma.providerEvent.upsert({
      where: { providerEventId: eventId },
      create: { provider: "WHOP", providerEventId: eventId, eventType, paymentId, outcome: "ERROR", detail, payload: payload as object },
      update: { outcome: "ERROR", detail },
    });
    return NextResponse.json({ ok: false, error: detail }, { status: 200 });
  }
  if (money.providerRef && !payment.providerRef) {
    // A provider session id must never attach to two payments. Claimed
    // elsewhere → operator review, not a 500 retry loop.
    const claimed = await prisma.payment.findUnique({ where: { providerRef: money.providerRef } });
    if (claimed && claimed.id !== paymentId) {
      const detail = `reference-claimed:${money.providerRef}`;
      await prisma.providerEvent.upsert({
        where: { providerEventId: eventId },
        create: { provider: "WHOP", providerEventId: eventId, eventType, paymentId, outcome: "ERROR", detail, payload: payload as object },
        update: { outcome: "ERROR", detail },
      });
      return NextResponse.json({ ok: false, error: detail }, { status: 200 });
    }
  }
  if (payment.status !== PaymentStatus.PENDING) {
    await prisma.providerEvent.upsert({
      where: { providerEventId: eventId },
      create: { provider: "WHOP", providerEventId: eventId, eventType, paymentId, outcome: "DUPLICATE", detail: `already-${payment.status.toLowerCase()}`, payload: payload as object },
      update: { outcome: "DUPLICATE", detail: `already-${payment.status.toLowerCase()}` },
    });
    return NextResponse.json({ ok: true, outcome: "already-settled" });
  }

  try {
    const outcome = await settlePayment(paymentId, {
      provider: "whop",
      eventId,
      eventType,
      paid: true,
      amountUsd: money.amountUsd,
      currency: money.currency,
      providerRef: money.providerRef ?? payment.providerRef,
    });
    // Deterministic rejections (take-below-reserve, ledger-invariant) are
    // terminal: 200 + ERROR row routes to operator review, never a 500 loop.
    if (outcome.outcome === "rejected") {
      return NextResponse.json({ ok: false, error: outcome.reason }, { status: 200 });
    }
    return NextResponse.json({ ok: true, outcome: outcome.outcome });
  } catch {
    // Retryable: non-2xx so Whop redelivers; the event row says ERROR.
    return NextResponse.json({ ok: false, error: "settle-retryable" }, { status: 500 });
  }
}
