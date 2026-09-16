import { NextRequest, NextResponse } from "next/server";
import { PaymentStatus } from "@prisma/client";
import { describeError, logError, logInfo, logWarn } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import {
  verifyStripeSignature,
  paymentIdFromStripePayload,
  stripePayloadIsPaid,
  stripePayloadIsFailed,
  stripePayloadIsDeclined,
  stripePayloadReversal,
  stripeEventId,
  stripeEventType,
  stripeMoney,
} from "@/lib/stripe";
import { validateProviderMoney } from "@/lib/money";
import { settlePayment, reversePayment, recordProviderEvent } from "@/lib/settle";
import { apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";

// Settlement writes the whole ledger in one Serializable transaction against
// Neon; see MONEY_TX for why the default 5 s Prisma budget is not enough.
export const maxDuration = 60;
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ POST: postStripeWebhook });

/**
 * Stripe webhook.
 *
 * - Verifies `stripe-signature` (HMAC-SHA256 over `${t}.${rawBody}`, 300s
 *   tolerance) against the raw bytes; 401 otherwise.
 * - Classifies paid ONLY on explicit provider signals (P0-03: statusless or
 *   unknown events are IGNORED with 200 — they must never apply a stake).
 * - Classifies refunds/chargebacks/disputes BEFORE paid/failed and unwinds the
 *   stake (reversePayment): a reversal must never be treated as unrelated.
 * - Validates provider reference, amount, and currency against the local
 *   payment before settling (item 4); mismatches are rejected loudly.
 * - Every delivery is recorded as a ProviderEvent; true duplicates get 200;
 *   settlement is atomic (settlePayment); unexpected failures get non-2xx so
 *   Stripe redelivers (item 7).
 */
/**
 * R18-2: every terminal delivery outcome is recorded in `ProviderEvent` and was
 * invisible everywhere else — an operator asking "why did the paid webhook
 * stop applying" had one table and no reader. The row stays the durable record
 * (and /api/admin/ops counts them); the line is what a deployment log — the
 * surface actually open at 03:00 — can show. `ERROR` is outcome-changing (a
 * delivery we refused and that redelivery cannot fix), so it is the level a
 * monitor may page on; `DUPLICATE` and `IGNORED` are the normal noise of a
 * webhook stream and log at `info`. Payloads, secrets and buyer data never
 * appear here: the event id and the payment id are already in the row.
 */
async function recordTerminal(event: Parameters<typeof recordProviderEvent>[0]): Promise<void> {
  await recordProviderEvent(event);
  const line = {
    outcome: event.outcome,
    detail: event.detail,
    eventType: event.eventType,
    eventId: event.eventId,
    paymentId: event.paymentId,
  };
  if (event.outcome === "ERROR") logError("stripe", "webhook-terminal", line);
  else logInfo("stripe", "webhook-terminal", line);
}

/**
 * Signatures that failed verification, and when the last line was written.
 *
 * R18-2: a 401 per delivery used to be completely silent — Stripe retries for
 * days and then disables the endpoint, and nothing on our side said why. The
 * line is throttled rather than per-request because this route is reachable by
 * anyone: an unauthenticated prober must not be able to fill the log (or page
 * on it) by guessing, and `suppressed` says how many refusals the line stands
 * for so a storm is still legible. Per process, like the checkout warning.
 */
const SIGNATURE_FAILURE_LOG_INTERVAL_MS = 60_000;
let signatureFailures = { logged: 0, since: 0 };

async function postStripeWebhook(req: NextRequest) {
  const raw = await req.text();
  const signatureHeader = req.headers.get("stripe-signature");
  if (!verifyStripeSignature(raw, signatureHeader)) {
    // Shape, never value (R14-10): a missing header means the sender or a proxy
    // never passed it on, a present one means the secret is wrong — two
    // different operator actions, and neither is answerable from a bare 401.
    const now = Date.now();
    if (now - signatureFailures.since >= SIGNATURE_FAILURE_LOG_INTERVAL_MS) {
      logError("stripe", "webhook-bad-signature", {
        signatureHeader: signatureHeader ? "present" : "absent",
        sinceLastLine: signatureFailures.logged,
      });
      signatureFailures = { logged: 0, since: now };
    } else {
      signatureFailures.logged++;
    }
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  logInfo("stripe", "webhook-verified", {});

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const eventId = stripeEventId(payload, raw);
  const eventType = stripeEventType(payload);
  const paymentId = paymentIdFromStripePayload(payload);
  if (!paymentId) {
    await recordTerminal({
      provider: "stripe",
      eventId,
      eventType,
      paymentId: null,
      outcome: "IGNORED",
      detail: "no-paymentId",
      payload,
    });
    return NextResponse.json({ ok: true, note: "no paymentId in payload" });
  }

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) {
    // No paymentId on the row: it would violate the foreign key, and the
    // delivery is not about a payment we know. The id is in the payload.
    await recordTerminal({
      provider: "stripe",
      eventId,
      eventType,
      paymentId: null,
      outcome: "IGNORED",
      detail: "unknown-payment",
      payload,
    });
    // 200: retrying an unknown payment can never succeed.
    return NextResponse.json({ ok: true, note: "unknown payment" });
  }

  // Money-reversing signals (refund / chargeback / dispute) are classified
  // BEFORE paid/failed: a payload can carry both a paid type and a refunded
  // status, and the reversal must win — otherwise the network hands the money
  // back while our ledger keeps the stake on the board and in the pool.
  const reversal = stripePayloadReversal(payload);
  if (reversal) {
    try {
      const outcome = await reversePayment(paymentId, {
        provider: "stripe",
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
    } catch (e) {
      // A failure Stripe will redeliver is a degradation, not an outcome: the
      // operator sees it, nobody is woken for it (lib/log.ts's level rule).
      logWarn("stripe", "webhook-retryable", { path: "reverse", paymentId, eventId, error: describeError(e) });
      return NextResponse.json({ ok: false, error: "reverse-retryable" }, { status: 500 });
    }
  }

  const paid = stripePayloadIsPaid(payload);
  const money = stripeMoney(payload);

  if (!paid) {
    // Explicit failure → mark failed. Anything else is an unrelated event
    // (P0-03): record IGNORED and leave the pending payment untouched — a
    // noisy event stream must never cancel a real checkout.
    if (!stripePayloadIsFailed(payload)) {
      // R08-6: a declined card ATTEMPT is not an unrelated event. Nothing is
      // changed (the session stays payable, see stripePayloadIsDeclined), but
      // the register should say a buyer was turned down rather than bury it in
      // the noise — it is the difference between "no signal" and "the buyer
      // could not pay".
      await recordTerminal({
        provider: "stripe",
        eventId,
        eventType,
        paymentId,
        outcome: "IGNORED",
        detail: stripePayloadIsDeclined(payload) ? "declined-attempt" : "unrelated-event",
        payload,
      });
      return NextResponse.json({ ok: true, outcome: "ignored" });
    }
    const outcome = await settlePayment(paymentId, {
      provider: "stripe",
      eventId,
      eventType,
      paid: false,
    });
    return NextResponse.json({ ok: true, outcome: outcome.outcome });
  }

  // Paid signal: validate money claims + reference before touching the ledger.
  const check = validateProviderMoney(payment.amountUsd, money);
  if (check.status === "rejected") {
    const moneyErr = check.reason;
    await recordTerminal({
      provider: "stripe",
      eventId,
      eventType,
      paymentId,
      outcome: "ERROR",
      detail: moneyErr,
      payload,
    });
    // Non-2xx is wrong here (redelivery won't fix a mismatch); 200 + ERROR
    // row routes it to operator review instead of retrying forever.
    return NextResponse.json({ ok: false, error: moneyErr }, { status: 200 });
  }
  if (money.providerRef && payment.providerRef && money.providerRef !== payment.providerRef) {
    const detail = `reference-mismatch:${money.providerRef}`;
    await recordTerminal({
      provider: "stripe",
      eventId,
      eventType,
      paymentId,
      outcome: "ERROR",
      detail,
      payload,
    });
    return NextResponse.json({ ok: false, error: detail }, { status: 200 });
  }
  if (money.providerRef && !payment.providerRef) {
    // A provider session id must never attach to two payments. Claimed
    // elsewhere → operator review, not a 500 retry loop.
    const claimed = await prisma.payment.findUnique({ where: { providerRef: money.providerRef } });
    if (claimed && claimed.id !== paymentId) {
      const detail = `reference-claimed:${money.providerRef}`;
      await recordTerminal({
        provider: "stripe",
        eventId,
        eventType,
        paymentId,
        outcome: "ERROR",
        detail,
        payload,
      });
      return NextResponse.json({ ok: false, error: detail }, { status: 200 });
    }
  }
  if (payment.status !== PaymentStatus.PENDING) {
    await recordTerminal({
      provider: "stripe",
      eventId,
      eventType,
      paymentId,
      outcome: "DUPLICATE",
      detail: `already-${payment.status.toLowerCase()}`,
      payload,
    });
    return NextResponse.json({ ok: true, outcome: "already-settled" });
  }

  try {
    const outcome = await settlePayment(paymentId, {
      provider: "stripe",
      eventId,
      eventType,
      paid: true,
      amountUsd: money.amountUsd,
      currency: money.currency,
      providerRef: money.providerRef ?? payment.providerRef,
      // `absent` settles (the provider may state no amount), but it is recorded
      // as unverified — /api/jobs/reconcile counts exactly these.
      amountUnverified: check.status === "absent",
    });
    // Deterministic rejections (take-below-reserve, ledger-invariant) are
    // terminal: 200 + ERROR row routes to operator review, never a 500 loop.
    if (outcome.outcome === "rejected") {
      return NextResponse.json({ ok: false, error: outcome.reason }, { status: 200 });
    }
    return NextResponse.json({ ok: true, outcome: outcome.outcome });
  } catch (e) {
    // Retryable: non-2xx so Stripe redelivers; the event row says ERROR.
    logWarn("stripe", "webhook-retryable", { path: "settle", paymentId, eventId, error: describeError(e) });
    return NextResponse.json({ ok: false, error: "settle-retryable" }, { status: 500 });
  }
}
