/**
 * Whop integration — env-gated. When WHOP_API_KEY + WHOP_WEBHOOK_SECRET are set
 * the real API is used; otherwise checkout falls back to the dev simulator
 * (/pay/[paymentId]) so the full ledger flow works locally without keys.
 *
 * Phase 0: production payment gating lives in lib/flags.ts + lib/env.ts
 * (fail-closed: explicit PAYMENTS_LIVE=true AND both keys required).
 * This helper stays a pure "are both keys present" check.
 */
import crypto from "crypto";

export const whopEnabled = () => !!process.env.WHOP_API_KEY && !!process.env.WHOP_WEBHOOK_SECRET;

/** Single provider-mode decision for the whole codebase (Phase 2, P1-04).
 * 'whop' requires BOTH key and secret; anything partial is 'dev' locally and
 * payments-off in production (see lib/flags.ts + lib/env.ts). */
export type ProviderMode = "whop" | "dev";
export const getProviderMode = (): ProviderMode => (whopEnabled() ? "whop" : "dev");

/** True when exactly one of key/secret is set — a misconfiguration that
 * strands payments (P1-04). Production refuses to start (lib/env.ts);
 * development logs a warning at checkout time. */
export const whopPartiallyConfigured = () =>
  !!process.env.WHOP_API_KEY !== !!process.env.WHOP_WEBHOOK_SECRET;

const WHOP_API = "https://api.whop.com/api/v2";

export type WhopSession = { checkoutUrl: string; providerRef: string };

export async function createWhopCheckoutSession(params: {
  paymentId: string;
  amountUsd: number;
  title: string;
  elementSymbol: string;
  email?: string | null;
  redirectAfterPaid: string;
}): Promise<WhopSession | null> {
  if (!whopEnabled()) return null;
  try {
    const body = {
      plan: {
        currency: "usd",
        recreate_on_expiration: true,
        initial_price: params.amountUsd,
        expiration_days: 1,
        metadata: {
          paymentId: params.paymentId,
          elementSymbol: params.elementSymbol,
        },
      },
      metadata: {
        paymentId: params.paymentId,
        elementSymbol: params.elementSymbol,
      },
      ...(params.email ? { email: params.email } : {}),
      redirect_after_payment: params.redirectAfterPaid,
    };

    const res = await fetch(`${WHOP_API}/checkout_sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHOP_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const checkoutUrl: string | undefined = json?.checkout_url ?? json?.data?.checkout_url ?? json?.url;
    const providerRef: string | undefined = json?.id ?? json?.data?.id;
    if (!checkoutUrl || !providerRef) return null;
    return { checkoutUrl, providerRef };
  } catch {
    return null;
  }
}

/** HMAC-SHA256 verify of the raw webhook body (Whop sends X-Whop-Signature). */
export function verifyWhopSignature(rawBody: string, signature: string | null): boolean {
  if (!process.env.WHOP_WEBHOOK_SECRET || !signature) return false;
  const digest = crypto
    .createHmac("sha256", process.env.WHOP_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("hex");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Extract our paymentId from Whop payload metadata (checks both plan and checkout session levels). */
export function paymentIdFromWhopPayload(payload: unknown): string | null {
  const p = payload as {
    data?: { plan?: { metadata?: { paymentId?: unknown } }; metadata?: { paymentId?: unknown }; payment?: { status?: unknown }; checkout_session?: { status?: unknown }; status?: unknown };
    metadata?: { paymentId?: unknown };
  } | null;
  const md = p?.data?.plan?.metadata ?? p?.data?.metadata ?? p?.metadata ?? null;
  const pid = (md as { paymentId?: unknown } | null)?.paymentId ?? null;
  return typeof pid === "string" && pid.length > 0 ? pid : null;
}

/** Only treat payments as successful on an explicit provider signal (P0-03).
 * Fail-closed: unknown, missing, pending, failed, or refunded states return
 * false. A signed-but-unrelated event carrying our metadata can no longer
 * apply a stake. Reversed states are false here too, but they are no longer
 * allowed to fall through to UNRELATED — see whopPayloadReversal. */
const PAID_STATUSES = new Set(["succeeded", "completed", "paid"]);
const PAID_EVENT_TYPES = new Set([
  "payment.succeeded",
  "payment.completed",
  "checkout.session.completed",
  "checkout_session.completed",
  "membership.paid",
  "charge.succeeded",
  "invoice.paid",
]);

export function whopEventType(payload: unknown): string {
  const p = payload as {
    type?: unknown;
    event?: unknown;
    data?: { type?: unknown };
  } | null;
  const t = p?.type ?? p?.event ?? p?.data?.type ?? "unknown";
  return typeof t === "string" && t.length > 0 ? t : "unknown";
}

export function whopPayloadIsPaid(payload: unknown): boolean {
  const p = payload as {
    data?: { status?: unknown; payment?: { status?: unknown }; checkout_session?: { status?: unknown } };
  } | null;
  const statuses = [p?.data?.status, p?.data?.payment?.status, p?.data?.checkout_session?.status].filter(
    (s): s is string => typeof s === "string"
  );
  if (statuses.some((s) => PAID_STATUSES.has(s))) return true;
  return PAID_EVENT_TYPES.has(whopEventType(payload));
}

/** Explicit failure signals only (statuses + event types). Anything else that
 * is neither paid, failed, nor reversed is UNRELATED — it must leave the
 * payment untouched (P0-03). */
const FAILED_STATUSES = new Set(["failed", "canceled", "cancelled", "expired"]);
const FAILED_EVENT_TYPES = new Set([
  "payment.failed",
  "checkout.session.expired",
  "checkout_session.expired",
  "charge.failed",
]);

export function whopPayloadIsFailed(payload: unknown): boolean {
  const p = payload as {
    data?: { status?: unknown; payment?: { status?: unknown }; checkout_session?: { status?: unknown } };
  } | null;
  const statuses = [p?.data?.status, p?.data?.payment?.status, p?.data?.checkout_session?.status].filter(
    (s): s is string => typeof s === "string"
  );
  if (statuses.some((s) => FAILED_STATUSES.has(s))) return true;
  return FAILED_EVENT_TYPES.has(whopEventType(payload));
}

/** Money-reversing signals: the provider returned, or clawed back, the buyer's
 * money. Kept strictly separate from PAID *and* FAILED.
 *
 * Not FAILED: a reversal is not a checkout that failed, and P0-03 forbids
 * letting a noisy event stream cancel a real checkout.
 *
 * Not UNRELATED either — that was the old behaviour, and it meant the network
 * returned the buyer's money while the stake stayed on the board and in the
 * pool, recorded as an unrelated event. Repeatable, self-incentivising, and
 * invisible. Published policy declines refunds (app/legal, Modals.tsx), but a
 * chargeback is not a policy you can decline.
 *
 * Returns the matched signal (for the audit trail) or null. Reversal amounts
 * are deliberately NOT validated against the local payment: a partial refund
 * is still a reversal, and a unit/amount mismatch must not block the unwind.
 */
const REVERSED_STATUSES = new Set([
  "refunded",
  "refund",
  "reversed",
  "disputed",
  "dispute",
  "chargeback",
  "chargebacked",
]);
const REVERSED_EVENT_TYPES = new Set([
  "payment.refunded",
  "payment.refund",
  "payment.disputed",
  "refund.created",
  "refund.succeeded",
  "refund.updated",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.funds_withdrawn",
  "chargeback.created",
  "dispute.created",
]);

export function whopPayloadReversal(payload: unknown): string | null {
  const p = payload as {
    data?: { status?: unknown; payment?: { status?: unknown }; checkout_session?: { status?: unknown } };
  } | null;
  const statuses = [p?.data?.status, p?.data?.payment?.status, p?.data?.checkout_session?.status].filter(
    (s): s is string => typeof s === "string"
  );
  const byStatus = statuses.map((s) => s.toLowerCase()).find((s) => REVERSED_STATUSES.has(s));
  if (byStatus) return `status:${byStatus}`;
  // Lowercased where the paid path is not: for a reversal the safe direction is
  // to over-match, because the two failure modes are not symmetric. A false
  // positive strips a stake for money we kept — loud (the buyer complains) and
  // recoverable (PAYMENT_REVERSED plus refundedAt name the payment, and a
  // re-apply is a fresh charge). A false negative is the original hole:
  // invisible, repeatable, and it hands the inventory over for free.
  const type = whopEventType(payload).toLowerCase();
  return REVERSED_EVENT_TYPES.has(type) ? `type:${type}` : null;
}

/** Stable provider event id for replay detection (Phase 2, webhook item 5).
 * Prefers the provider's own id; falls back to a hash of the raw body so
 * redeliveries of the same bytes still dedupe. */
export function whopEventId(payload: unknown, rawBody: string): string {
  const p = payload as { id?: unknown; data?: { id?: unknown } } | null;
  const id = p?.id ?? p?.data?.id ?? null;
  if (typeof id === "string" && id.length > 0) return `whop:${id}`;
  return `whop:sha:${crypto.createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;
}

export type WhopMoney = { amountUsd: number | null; currency: string | null; providerRef: string | null };

/** Extract money/reference claims from known payload shapes (Phase 2 item 4).
 * Amounts may be dollars or cents — accept when EITHER unit matches the local
 * payment, reject on explicit mismatch, ignore when absent. */
export function whopMoney(payload: unknown): WhopMoney {
  const p = payload as {
    data?: {
      amount?: unknown;
      total?: unknown;
      price?: unknown;
      initial_price?: unknown;
      currency?: unknown;
      id?: unknown;
      checkout_session?: { id?: unknown };
    };
  } | null;
  const d = p?.data ?? {};
  const rawAmount = d.amount ?? d.total ?? d.price ?? d.initial_price ?? null;
  const amount = typeof rawAmount === "number" ? rawAmount : null;
  const currency = typeof d.currency === "string" ? d.currency.toLowerCase() : null;
  const ref = d.id ?? d.checkout_session?.id ?? null;
  return {
    amountUsd: amount,
    currency,
    providerRef: typeof ref === "string" && ref.length > 0 ? ref : null,
  };
}

/** Validate provider money claims against the local payment (Phase 2 item 4).
 * Returns null when consistent/absent, otherwise a machine-readable reason. */
export function validateWhopMoney(localAmountUsd: number, money: WhopMoney): string | null {
  if (money.currency && money.currency !== "usd") return `currency-mismatch:${money.currency}`;
  if (money.amountUsd == null) return null;
  if (money.amountUsd === localAmountUsd) return null; // dollars
  if (Math.round(money.amountUsd) / 100 === localAmountUsd) return null; // cents
  return `amount-mismatch:${money.amountUsd}`;
}
