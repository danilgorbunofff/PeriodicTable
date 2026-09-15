/** Launch flags (Phase 5, spec 02-launch-gate-runbook.md + Phase 0 hardening).
 * Production is fail-closed: payments are live ONLY when explicitly enabled
 * (PAYMENTS_LIVE=true) AND the provider is fully configured (Stripe key+secret).
 * Partial provider config or an absent flag disables payments instead of
 * defaulting live. The dev simulator keeps the default-live-unless-false
 * behavior in a *development* process only: a preview deployment shares the
 * production database, so a stand-in provider there writes real stakes (R07-2).
 */
import { getAppEnv, isProduction } from "./env";

/** Mirrors the credential half of getProviderMode() (lib/stripe.ts) without
 * importing it: this module is reachable from the client bundle
 * (components/Modals.tsx reads paymentsLiveClient) and lib/stripe.ts imports
 * node:crypto. lib/stripe.test.ts asserts the two agree on both keys. */
function providerConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_WEBHOOK_SECRET;
}

/** Exactly one of the pair is set — the same condition as
 * stripePartiallyConfigured(), for the same reason the credential check above
 * is duplicated: this module is reachable from the client bundle. */
function partialProviderConfig(): boolean {
  return !!process.env.STRIPE_SECRET_KEY !== !!process.env.STRIPE_WEBHOOK_SECRET;
}

/**
 * Whether the dev simulator may stand in for the provider at all (R07-1/R07-2).
 *
 * Provider *mode* is derived from credential presence alone, and absence is not
 * consent: a production process holding only STRIPE_SECRET_KEY is "dev" by that
 * rule, so POST /api/dev/pay granted a permanent stake for free (R07-1), and a
 * preview deployment pointed at the production database did the same for real
 * money (R07-2). The simulator therefore additionally requires an environment
 * that is allowed to invent payments: a local development run, or the test
 * suite — and no Stripe credentials at all.
 *
 * A half-configured Stripe is deliberately not "no provider": it is an incident,
 * and the honest answer to it is the paused waitlist, never a free stake. That
 * holds in development too — the state is one paste away from being fixable, and
 * the alternative is a simulator whose page claims no key is configured while a
 * key sits in the environment (R07-7).
 */
export function devSimulatorEnabled(): boolean {
  // The kill switch stops the simulator too: an operator who pulls PAYMENTS_LIVE
  // means no stake is minted by any route, including the stand-in one.
  if ((process.env.PAYMENTS_LIVE ?? "").toLowerCase() === "false") return false;
  if (providerConfigured() || partialProviderConfig()) return false;
  const env = getAppEnv();
  return env === "development" || env === "test";
}

export function paymentsLiveServer(): boolean {
  if ((process.env.PAYMENTS_LIVE ?? "").toLowerCase() === "false") return false;
  if (isProduction()) {
    return process.env.PAYMENTS_LIVE === "true" && providerConfigured();
  }
  // Outside production the shop is live only when it can actually take money:
  // a fully configured Stripe, or the simulator in a development process. That
  // is what keeps a key-less preview deployment paused instead of free (R07-2),
  // with /api/jobs/config as the operator's signal. PAYMENTS_LIVE=true cannot
  // override it: a deployment that cannot settle a payment must not sell one.
  return providerConfigured() || devSimulatorEnabled();
}

export function paymentsLiveClient(): boolean {
  if ((process.env.NEXT_PUBLIC_PAYMENTS_LIVE ?? "").toLowerCase() === "false") return false;
  if (isProduction() || process.env.NEXT_PUBLIC_VERCEL_ENV === "production") {
    return process.env.NEXT_PUBLIC_PAYMENTS_LIVE === "true";
  }
  return (process.env.NEXT_PUBLIC_PAYMENTS_LIVE ?? "true").toLowerCase() !== "false";
}
