import { getProdConfigReport, isProduction } from "./env";
import { paymentsLiveServer } from "./flags";

/* R14-1(b) — "live" is not the same as "serviceable".

   A production deployment that sets PAYMENTS_LIVE=true and holds both Stripe
   credentials takes money. If it is missing something else it requires
   (RESEND_API_KEY → the buyer pays and no receipt exists; CRON_SECRET → the
   outbox never drains; ADMIN_TOKEN → nobody can retry it), the sale succeeds and
   the consequence is invisible until someone complains. The finding's own
   reproduction is a local production build with the Stripe names unset; the
   general shape is "a required variable is one `vercel env rm` away".

   The gate keys on the *intent* flag, not on the report alone. A pre-launch
   deployment deliberately has no Stripe keys, and its report therefore lists
   STRIPE_SECRET_KEY among the required findings — refusing checkout with a 503
   there would replace the storefront's waitlist promise (403 + `waitlist: true`)
   with a generic failure, i.e. break the one path R14-1 says must keep working.
   So: paused shop → the report is none of checkout's business; live-intent shop →
   the report decides. */

export type MoneyPathVerdict =
  | { ok: true }
  | { ok: false; required: string[] };

/**
 * Whether this process may take a payment at all.
 *
 * Read per request, not cached: it is ten environment lookups against a request
 * that is about to open a transaction against Neon, and a cached verdict is
 * state that a test cannot reset.
 */
export function checkMoneyPath(): MoneyPathVerdict {
  if (!isProduction() || !paymentsLiveServer()) return { ok: true };
  const required = getProdConfigReport()
    .findings.filter((f) => f.severity === "required")
    .map((f) => f.detail);
  return required.length === 0 ? { ok: true } : { ok: false, required };
}
