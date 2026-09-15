/**
 * Stripe integration — env-gated. When STRIPE_SECRET_KEY +
 * STRIPE_WEBHOOK_SECRET are both set the real API is used; otherwise checkout
 * falls back to the dev simulator (/pay/[paymentId]) so the full ledger flow
 * works locally without keys.
 *
 * Phase 0: production payment gating lives in lib/flags.ts + lib/env.ts
 * (fail-closed: explicit PAYMENTS_LIVE=true AND both keys required).
 * This helper stays a pure "are both keys present" check.
 *
 * Phase 7: "both keys present" is only a *shape* check, so it decides the
 * provider mode and nothing else. Whether the dev simulator may exist at all is
 * an environment question answered by devSimulatorEnabled() below — re-exported
 * from lib/flags.ts so server code has one import site — and whether a
 * simulator may mint stakes is answered only by the deployment environment
 * (R07-1/R07-2).
 *
 * No SDK: the whole surface we need is one POST, one GET and one HMAC, and
 * Node's fetch and crypto cover all three. Keeping the runtime dependency list
 * at Prisma/Next/React/SWR is worth more than the SDK's conveniences.
 */
import crypto from "crypto";
import { type CredentialHealth } from "@/lib/env";
import { type ProviderMoney } from "@/lib/money";

// The one environment gate for the dev simulator (R07-1/R07-2): false in
// production and false whenever Stripe credentials are configured, regardless of
// provider mode. See lib/flags.ts for the rule and lib/phase5.test.ts for the
// cases.
export { devSimulatorEnabled } from "@/lib/flags";

export const stripeEnabled = () =>
  !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_WEBHOOK_SECRET;

/** Single provider-mode decision for the whole codebase (Phase 2, P1-04).
 * 'stripe' requires BOTH key and secret; anything partial is 'dev' locally and
 * payments-off in production (see lib/flags.ts + lib/env.ts).
 *
 * This answers "which provider does a *record* belong to" — it is the value
 * stored in Payment.provider. It is NOT permission to move money or to mint
 * stakes: callers that grant value must additionally require the deployment to
 * be a non-production one (devSimulatorEnabled()) or the real keys
 * (paymentsLiveServer()), because this function cannot tell a production
 * deployment from a laptop and answers 'dev' on a production box whose
 * STRIPE_WEBHOOK_SECRET is missing (R07-1).
 *
 * The string doubles as the Prisma PaymentProvider value (`Payment.provider`),
 * which is why the enum member is STRIPE @map("stripe"). */
export type ProviderMode = "stripe" | "dev";
export const getProviderMode = (): ProviderMode => (stripeEnabled() ? "stripe" : "dev");

/** True when exactly one of key/secret is set — a misconfiguration that
 * strands payments (P1-04).
 *
 * The reaction differs by environment on purpose: locally it is a warning at
 * checkout time (a developer may be halfway through pasting keys), while in
 * production it makes paymentsLiveServer() false so the storefront takes the
 * waitlist instead of money (R07-1) and the simulator is unavailable (R07-2)
 * until the pair is complete. */
export const stripePartiallyConfigured = () =>
  !!process.env.STRIPE_SECRET_KEY !== !!process.env.STRIPE_WEBHOOK_SECRET;

const STRIPE_API = "https://api.stripe.com/v1";

/** Anything key-shaped, so a provider message can be logged or reported without
 * carrying a credential. Stripe masks keys in its own errors, but that is
 * Stripe's promise rather than ours, and this text also travels into
 * /api/jobs/config bodies. */
function redactSecrets(text: string): string {
  return text.replace(/\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_]+/g, (m) => `${m.slice(0, m.indexOf("_") + 1)}[redacted]`);
}

/** How long a probe answer is reused. The pinger ticks every ten minutes, so a
 * minute is generous for freshness and keeps a burst of config reads to one
 * call. */
const PROBE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;
let probeCache: { key: string; at: number; health: CredentialHealth } | null = null;

/**
 * Asks Stripe whether the configured key actually works (R07-4).
 *
 * Presence and validity are different questions, and only the second one decides
 * whether a buyer can pay: a truncated key is "configured" by every check in the
 * codebase, and every checkout then answers 502 while the storefront stays open.
 * `GET /v1/balance` is the cheapest authenticated call Stripe offers — no money
 * moves, nothing is created, and 401/403 answers exactly "would a session be
 * accepted?". Resolve to `unknown` (never `invalid`) when Stripe cannot be
 * reached, so a network blip is not reported as a bad key.
 *
 * Never returns or logs the key: the error text is redacted by shape.
 */
export async function probeStripeKey(
  opts: { fetchImpl?: typeof fetch; key?: string; now?: number } = {}
): Promise<CredentialHealth> {
  const key = opts.key ?? process.env.STRIPE_SECRET_KEY ?? "";
  if (!key) return { status: "absent" };
  const now = opts.now ?? Date.now();
  if (probeCache && probeCache.key === key && now - probeCache.at < PROBE_TTL_MS) return probeCache.health;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let health: CredentialHealth;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${STRIPE_API}/balance`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (res.ok) {
      health = { status: "valid" };
    } else {
      const body = await res.text().catch(() => "");
      const detail = `HTTP ${res.status}${
        body ? ` — ${redactSecrets(body).replace(/\s+/g, " ").slice(0, 200)}` : ""
      }`;
      health = res.status === 401 || res.status === 403 ? { status: "invalid", detail } : { status: "unknown", detail };
    }
  } catch {
    health = { status: "unknown", detail: "the Stripe API could not be reached" };
  } finally {
    clearTimeout(timer);
  }
  probeCache = { key, at: now, health };
  return health;
}

/** One `error` line per minute, carrying a count of what it stood in for
 * (R07-4). A rejected checkout is a lost sale rather than a warning, and a key
 * Stripe refuses fails *every* buyer — a line per request is a wall the operator
 * scrolls past, while a minute is fast enough to see and slow enough to read.
 *
 * Exported for the R07-4 cadence test; the only production caller is
 * createStripeCheckoutSession's failure path. */
const REJECTION_LOG_INTERVAL_MS = 60_000;
let rejectionLog = { at: 0, suppressed: 0 };

export function logCheckoutRejection(message: string): void {
  const now = Date.now();
  if (now - rejectionLog.at < REJECTION_LOG_INTERVAL_MS) {
    rejectionLog.suppressed += 1;
    return;
  }
  const suppressed = rejectionLog.suppressed;
  rejectionLog = { at: now, suppressed: 0 };
  console.error(`${message}${suppressed > 0 ? ` (+${suppressed} more rejected checkouts since the previous line)` : ""}`);
}

/** Product tax code attached to every line item.
 *
 * Managed Payments is enabled on this account (it is what makes Stripe the
 * merchant of record for tax), and under it a checkout session with a line item
 * that carries no eligible tax code is rejected outright — HTTP 400, no session
 * created, the buyer sees our generic 502. This omission was invisible in dev
 * mode, which never reaches Stripe, and it took the live-mode log line to
 * surface.
 *
 * `txcd_10000000` — "General – Electronically Supplied Services" — is Managed
 * Payments' own general category for a digital service delivered through the
 * internet with minimal human involvement: a paid tile is exactly that, and the
 * more specific categories (hosting, software, media, courses) all describe
 * something else. An ineligible code is refused as hard as a missing one, so
 * this is a reviewed constant rather than an env var: reclassifying the product
 * for tax is a decision to deploy, not to flip.
 * https://docs.stripe.com/payments/managed-payments/eligibility#product-tax-code-requirements */
const PRODUCT_TAX_CODE = "txcd_10000000";

export type StripeSession = { checkoutUrl: string; providerRef: string };

export async function createStripeCheckoutSession(params: {
  paymentId: string;
  amountUsd: number;
  title: string;
  elementSymbol: string;
  email?: string | null;
  redirectAfterPaid: string;
  cancelUrl?: string;
}): Promise<StripeSession | null> {
  if (!stripeEnabled()) {
    console.warn(
      `stripe: checkout session unavailable — missing ${
        [
          !process.env.STRIPE_SECRET_KEY && "STRIPE_SECRET_KEY",
          !process.env.STRIPE_WEBHOOK_SECRET && "STRIPE_WEBHOOK_SECRET",
        ]
          .filter(Boolean)
          .join(" + ") || "nothing"
      }`
    );
    return null;
  }
  try {
    // Stripe takes application/x-www-form-urlencoded, not JSON, and nests with
    // bracket notation. Every value here is a plain string, so URLSearchParams
    // does the encoding (including the `$`, `?` and `=` in the redirect URLs,
    // which are built from the request origin and would otherwise corrupt the
    // form body mid-way through).
    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("success_url", params.redirectAfterPaid);
    if (params.cancelUrl) body.set("cancel_url", params.cancelUrl);
    if (params.email) body.set("customer_email", params.email);
    body.set("line_items[0][quantity]", "1");
    body.set("line_items[0][price_data][currency]", "usd");
    // Our amount is whole dollars; Stripe's unit is integer cents. This is the
    // one conversion in the codebase and it happens exactly once, here — a
    // missed *100 charges a nickel for a five-dollar element.
    body.set("line_items[0][price_data][unit_amount]", String(Math.round(params.amountUsd * 100)));
    body.set("line_items[0][price_data][product_data][name]", params.title);
    body.set("line_items[0][price_data][product_data][tax_code]", PRODUCT_TAX_CODE);
    // Metadata goes on BOTH the session and the payment intent.
    //
    // The session copy covers checkout.session.* deliveries. The intent copy is
    // not redundancy: every money-reversing event (charge.refunded,
    // charge.dispute.created) delivers a CHARGE, and a charge carries the
    // payment intent's metadata and never the session's. Without this line each
    // refund arrives with no paymentId, gets filed IGNORED/unknown-payment, and
    // the buyer keeps both the refund and the stake — invisible, repeatable,
    // and free inventory. See stripePayloadReversal.
    body.set("metadata[paymentId]", params.paymentId);
    body.set("metadata[elementSymbol]", params.elementSymbol);
    body.set("payment_intent_data[metadata][paymentId]", params.paymentId);
    body.set("payment_intent_data[metadata][elementSymbol]", params.elementSymbol);

    const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        // Keyed on the payment row, so resuming a pending checkout returns the
        // session that may already be open in the buyer's tab instead of
        // minting a second one for the same money (P1-04).
        "Idempotency-Key": `pt_checkout_${params.paymentId}`,
      },
      body: body.toString(),
    });
    if (!res.ok) {
      // A rejected checkout is the difference between a buyer and no sale, and
      // the reason lives only in this response. Report it: the status, the
      // provider's own message, and the mode the configured key belongs to.
      // Live vs test is the distinction that actually gets misconfigured, and
      // it is not secret. Never the key itself.
      const detail = await res.text().catch(() => "");
      const key = process.env.STRIPE_SECRET_KEY ?? "";
      const auth = key.startsWith("sk_live_") ? "sk_live" : key.startsWith("sk_test_") ? "sk_test" : "unexpected-format";
      logCheckoutRejection(
        `stripe: checkout/sessions rejected (HTTP ${res.status}, key=${auth})` +
          (detail ? ` — ${redactSecrets(detail).replace(/\s+/g, " ").slice(0, 300)}` : "")
      );
      return null;
    }
    const json = await res.json();
    const checkoutUrl: string | undefined = json?.url ?? json?.data?.url;
    const providerRef: string | undefined = json?.id ?? json?.data?.id;
    if (!checkoutUrl || !providerRef) {
      console.warn(
        `stripe: checkout/sessions response missing ${[!checkoutUrl && "url", !providerRef && "id"]
          .filter(Boolean)
          .join(" + ")} — keys: ${Object.keys(json ?? {}).join(",") || "none"}`
      );
      return null;
    }
    return { checkoutUrl, providerRef };
  } catch (err) {
    console.warn(
      `stripe: checkout/sessions request failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/** Constant-time compare of two ASCII digests. Length is not secret, so an
 * early length check is fine; the compare itself never short-circuits. */
function digestMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** How stale a delivery's timestamp may be, in seconds. Matches Stripe's own
 * SDK default. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Stripe's signature envelope is `t=<unix>,v1=<hex>[,v1=<hex>…]`: HMAC-SHA256
 * over the string `${t}.${rawBody}`. Unlike the provider this replaces, the
 * envelope carries its own freshness proof, so replay protection is free —
 * provided we actually check it.
 *
 * Freshness is verified BEFORE the HMAC and rejected either way, because a
 * signature with no expiry is a signature that is valid forever: anyone who
 * observes one delivery could replay it, or re-time it into a forgery, at any
 * point in the future.
 *
 * `nowSeconds` is injectable so the tolerance window is testable without a
 * clock dependency.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;

  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === "v1") {
      candidates.push(value);
    }
  }
  if (timestamp === null || candidates.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  // The header may carry several signatures while an endpoint secret is being
  // rotated, so any matching v1 entry is enough.
  return candidates.some((candidate) => digestMatches(expected, candidate));
}

type StripeObject = {
  id?: unknown;
  object?: unknown;
  amount?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  status?: unknown;
  payment_status?: unknown;
  metadata?: { paymentId?: unknown } | null;
};

/** The delivered entity. Stripe wraps every event as
 * `{ id, type, data: { object } }`, so one accessor serves every event kind —
 * the entity inside is a session, charge, dispute or refund depending on type. */
function stripeObject(payload: unknown): StripeObject | null {
  const p = payload as { data?: { object?: unknown } } | null;
  const o = p?.data?.object;
  return o && typeof o === "object" ? (o as StripeObject) : null;
}

/** Extract our paymentId from Stripe object metadata.
 *
 * Reads the delivered entity's own metadata, which is why the create call
 * writes the paymentId to the payment intent as well as the session: reversal
 * events deliver a charge, and a charge carries only the intent's copy. */
export function paymentIdFromStripePayload(payload: unknown): string | null {
  const md = stripeObject(payload)?.metadata ?? null;
  const pid = (md as { paymentId?: unknown } | null)?.paymentId ?? null;
  return typeof pid === "string" && pid.length > 0 ? pid : null;
}

export function stripeEventType(payload: unknown): string {
  const p = payload as { type?: unknown } | null;
  const t = p?.type;
  return typeof t === "string" && t.length > 0 ? t : "unknown";
}

/**
 * Only treat payments as successful on an explicit provider signal (P0-03).
 * Fail-closed: unknown, missing, pending, failed, or refunded states return
 * false. A signed-but-unrelated event carrying our metadata can no longer
 * apply a stake.
 *
 * `checkout.session.completed` is the one paid event acted on, and it must
 * report `payment_status: "paid"` — async payment methods complete the session
 * before the money clears, and their follow-up is
 * `checkout.session.async_payment_succeeded`, also accepted here.
 *
 * `payment_intent.succeeded` and `charge.succeeded` are deliberately NOT
 * accepted, though they mean the same thing. They are emitted for the same
 * purchase alongside `checkout.session.completed`, and they carry the `pi_…`
 * and `ch_…` ids rather than the `cs_…` id stored as providerRef — so acting on
 * them turns one purchase into a reference-mismatch ERROR row and an operator
 * page, or a duplicate stake.
 */
export function stripePayloadIsPaid(payload: unknown): boolean {
  const type = stripeEventType(payload);
  if (type === "checkout.session.async_payment_succeeded") return true;
  if (type !== "checkout.session.completed") return false;
  return stripeObject(payload)?.payment_status === "paid";
}

/** Explicit failure signals only (event types). Anything else that is neither
 * paid, failed, nor reversed is UNRELATED — it must leave the payment untouched
 * (P0-03).
 *
 * Only session-level terminal outcomes qualify. `payment_intent.payment_failed`
 * is excluded on purpose: it fires for a single declined attempt, while the
 * session it belongs to stays open and payable, so treating it as failure marks
 * a recovering buyer's payment dead — and the retry that succeeds then cannot
 * settle it. An abandoned session is still caught by the expiry event, and a
 * stalled one by reservation TTL. */
const FAILED_EVENT_TYPES = new Set([
  "checkout.session.expired",
  "checkout.session.async_payment_failed",
]);

export function stripePayloadIsFailed(payload: unknown): boolean {
  return FAILED_EVENT_TYPES.has(stripeEventType(payload));
}

/** A single declined card attempt (R08-6).
 *
 * Not a failure and not unrelated. `payment_intent.payment_failed` fires when
 * one attempt is declined while the session it belongs to stays open and
 * payable, so it must not change the payment — but it is also not noise: it is
 * the buyer being turned down, and the register should be able to say so.
 *
 * The distinction matters because this event is not in the endpoint's
 * subscribed event list (see PROD-READINESS-CHECKLIST.md): if it is ever
 * subscribed, the delivery must arrive already classified rather than falling
 * into "unrelated-event" and looking like a stream we do not act on. */
const DECLINED_EVENT_TYPES = new Set(["payment_intent.payment_failed"]);

export function stripePayloadIsDeclined(payload: unknown): boolean {
  return DECLINED_EVENT_TYPES.has(stripeEventType(payload));
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
 *
 * `refund.created` and `refund.updated` are excluded even though they fire for
 * the same money, because they fire while a refund is still pending and can
 * still fail. `charge.refunded` is the completion signal for exactly that
 * event, so waiting for it loses no coverage — it only avoids unwinding a stake
 * for a refund that never left.
 */
const REVERSED_STATUSES = new Set(["refunded", "reversed", "disputed", "chargeback"]);
const REVERSED_EVENT_TYPES = new Set([
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.funds_withdrawn",
]);

export function stripePayloadReversal(payload: unknown): string | null {
  const status = stripeObject(payload)?.status;
  if (typeof status === "string" && REVERSED_STATUSES.has(status.toLowerCase())) {
    return `status:${status.toLowerCase()}`;
  }
  // Lowercased where the paid path is not: for a reversal the safe direction is
  // to over-match, because the two failure modes are not symmetric. A false
  // positive strips a stake for money we kept — loud (the buyer complains) and
  // recoverable (PAYMENT_REVERSED plus refundedAt name the payment, and a
  // re-apply is a fresh charge). A false negative is the original hole:
  // invisible, repeatable, and it hands the inventory over for free.
  const type = stripeEventType(payload).toLowerCase();
  return REVERSED_EVENT_TYPES.has(type) ? `type:${type}` : null;
}

/** Stable provider event id for replay detection (Phase 2, webhook item 5).
 * Prefers the provider's own id; falls back to a hash of the raw body so
 * redeliveries of the same bytes still dedupe. */
export function stripeEventId(payload: unknown, rawBody: string): string {
  const p = payload as { id?: unknown } | null;
  const id = p?.id ?? null;
  if (typeof id === "string" && id.length > 0) return `stripe:${id}`;
  return `stripe:sha:${crypto.createHash("sha256").update(rawBody, "utf8").digest("hex").slice(0, 32)}`;
}

/** Extract money/reference claims from a Stripe delivery.
 *
 * Stripe quotes integer cents everywhere, so normalise to dollars once, here,
 * rather than leaving every consumer to remember which unit it is holding.
 *
 * providerRef is claimed ONLY from a checkout session. A charge, dispute or
 * refund id is a different object's identity; writing one into the payment's
 * providerRef would strand the row against the session event that follows and
 * can trip the @unique constraint against an unrelated payment. */
export function stripeMoney(payload: unknown): ProviderMoney {
  const o = stripeObject(payload);
  if (!o) return { amountUsd: null, currency: null, providerRef: null };

  const rawCents = o.amount_total ?? o.amount ?? null;
  const cents = typeof rawCents === "number" ? rawCents : null;
  const currency = typeof o.currency === "string" ? o.currency.toLowerCase() : null;
  const isSession = o.object === "checkout.session";
  const ref = isSession && typeof o.id === "string" && o.id.length > 0 ? o.id : null;

  return {
    amountUsd: cents === null ? null : cents / 100,
    currency,
    providerRef: ref,
  };
}
