/** Provider-agnostic money assertions.
 *
 * These live apart from any one provider's adapter because the reconciliation
 * report asks them of stored rows while the webhook asks them of live
 * deliveries. Two encodings of the same rule drift, and the report would then
 * bless a figure the webhook itself rejects.
 */

export type ProviderMoney = {
  /** As the provider stated it, normalised to dollars. */
  amountUsd: number | null;
  currency: string | null;
  providerRef: string | null;
};

/** The result of checking the provider's money claims against our payment.
 * `absent` is a distinct state, not a synonym for `ok`: some deliveries state
 * no amount at all, and collapsing that into "verified" is how an unverified
 * charge becomes invisible. Callers must decide explicitly what to do with it
 * (the webhook settles and records the delivery as amount-unverified, and
 * /api/jobs/reconcile counts exactly those). */
export type ProviderMoneyCheck =
  | { status: "ok" } // provider's figure matches ours
  | { status: "absent" } // provider stated no amount — nothing was verified
  | { status: "rejected"; reason: string }; // contradiction: never settle this

/** Does a provider's amount figure describe the money we charged?
 *
 * Providers disagree on units — some quote dollars, some integer cents — so
 * EITHER representation of the same money is agreement. Adapters are expected
 * to normalise to dollars, but a payload that slips through in cents must not
 * be read as a contradiction, because rejecting it strands a real buyer. */
export function providerAmountAgrees(ourAmountUsd: number, providerAmount: number): boolean {
  return providerAmount === ourAmountUsd || Math.round(providerAmount) / 100 === ourAmountUsd;
}

/** Does a provider's currency claim describe money we can accept? A provider
 * that states none is not contradicting us; one that names anything but USD is. */
export function providerCurrencyAgrees(providerCurrency: string | null): boolean {
  return !providerCurrency || providerCurrency.toLowerCase() === "usd";
}

/** Validate provider money claims against the local payment. */
export function validateProviderMoney(
  localAmountUsd: number,
  money: ProviderMoney
): ProviderMoneyCheck {
  if (!providerCurrencyAgrees(money.currency)) {
    return { status: "rejected", reason: `currency-mismatch:${money.currency}` };
  }
  if (money.amountUsd == null) return { status: "absent" };
  if (providerAmountAgrees(localAmountUsd, money.amountUsd)) return { status: "ok" };
  return { status: "rejected", reason: `amount-mismatch:${money.amountUsd}` };
}
