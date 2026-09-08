/** Launch flags (Phase 5, spec 02-launch-gate-runbook.md + Phase 0 hardening).
 * Production is fail-closed: payments are live ONLY when explicitly enabled
 * (PAYMENTS_LIVE=true) AND the provider is fully configured (Whop key+secret).
 * Partial provider config or an absent flag disables payments instead of
 * defaulting live. Outside production the dev simulator keeps the previous
 * default-live-unless-false behavior so local E2E still works.
 */
import { isProduction } from "./env";

function providerConfigured(): boolean {
  return !!process.env.WHOP_API_KEY && !!process.env.WHOP_WEBHOOK_SECRET;
}

export function paymentsLiveServer(): boolean {
  if ((process.env.PAYMENTS_LIVE ?? "").toLowerCase() === "false") return false;
  if (isProduction()) {
    return process.env.PAYMENTS_LIVE === "true" && providerConfigured();
  }
  return (process.env.PAYMENTS_LIVE ?? "true").toLowerCase() !== "false";
}

export function paymentsLiveClient(): boolean {
  if ((process.env.NEXT_PUBLIC_PAYMENTS_LIVE ?? "").toLowerCase() === "false") return false;
  if (isProduction() || process.env.NEXT_PUBLIC_VERCEL_ENV === "production") {
    return process.env.NEXT_PUBLIC_PAYMENTS_LIVE === "true";
  }
  return (process.env.NEXT_PUBLIC_PAYMENTS_LIVE ?? "true").toLowerCase() !== "false";
}
