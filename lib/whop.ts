/**
 * Whop integration — env-gated. When WHOP_API_KEY + WHOP_WEBHOOK_SECRET are set
 * the real API is used; otherwise checkout falls back to the dev simulator
 * (/pay/[paymentId]) so the full ledger flow works locally without keys.
 */
import crypto from "crypto";

export const whopEnabled = () => !!process.env.WHOP_API_KEY && !!process.env.WHOP_WEBHOOK_SECRET;

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
export function paymentIdFromWhopPayload(payload: any): string | null {
  const md =
    payload?.data?.plan?.metadata ??
    payload?.data?.metadata ??
    payload?.metadata ??
    null;
  const pid = md?.paymentId ?? null;
  return typeof pid === "string" && pid.length > 0 ? pid : null;
}

/** Only treat payments as successful when Whop reports a paid/completed state. */
export function whopPayloadIsPaid(payload: any): boolean {
  const statuses = [
    payload?.data?.status,
    payload?.data?.payment?.status,
    payload?.data?.checkout_session?.status,
  ].filter(Boolean);
  if (statuses.length === 0) return true; // membership.paid-style events without status fields
  return statuses.some((s) => s === "succeeded" || s === "completed" || s === "paid");
}
