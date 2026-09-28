/* The little of the operator's identity this product is willing to hold.
 *
 * The published posture is deliberately minimal: the four documents name no
 * operator, no company, no postal address and no jurisdiction, and the only
 * contact point anywhere is `SUPPORT_EMAIL` in `lib/legal.ts`. What is left here
 * is the handful of values the operator's own configuration report tracks, read
 * from the server environment — never `NEXT_PUBLIC_`, so none of them can be
 * shipped to a browser as an empty string:
 *
 *   OPERATOR_NAME        a seller name, for a deployment that has a registered entity
 *   OPERATOR_COUNTRY     the country that entity is established in
 *   OPERATOR_TAX_ID      VAT / company / registration number, if one exists
 *   OPERATOR_DESCRIPTOR  the descriptor Stripe prints on card statements
 *
 * The receipt's legal block was removed 2026-09-28 (the mail is a confirmation,
 * the rules page carries the terms), so nothing here reaches a payer any more.
 * The advisories stay because a charge that cannot be recognised on a statement
 * is a dispute waiting to happen, and the config report is where an operator
 * sees that before a buyer does.
 */

export type OperatorInfo = {
  name: string | null;
  country: string | null;
  taxId: string | null;
  descriptor: string | null;
};

export const OPERATOR_ENV = {
  name: "OPERATOR_NAME",
  country: "OPERATOR_COUNTRY",
  taxId: "OPERATOR_TAX_ID",
  descriptor: "OPERATOR_DESCRIPTOR",
} as const;

function read(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function operatorInfo(env: NodeJS.ProcessEnv = process.env): OperatorInfo {
  return {
    name: read(env, OPERATOR_ENV.name),
    country: read(env, OPERATOR_ENV.country),
    taxId: read(env, OPERATOR_ENV.taxId),
    descriptor: read(env, OPERATOR_ENV.descriptor),
  };
}

/** Card-network rules for a statement descriptor: 5–22 characters, upper-case
 * letters, digits, spaces and a few separators. A value that fails this is
 * rejected by Stripe at charge time, which is why it is also an advisory.
 *
 * The bounds are load-bearing: 5 is Stripe's minimum and 22 its maximum, so the
 * class is `{4,21}` after the mandatory first character. An off-by-one here is
 * invisible until a charge is refused, which is the whole failure this predicate
 * exists to catch. */
export function descriptorIsValid(descriptor: string | null): boolean {
  if (!descriptor) return false;
  return /^[A-Z0-9][A-Z0-9 .*-]{4,21}$/.test(descriptor);
}

/** The operator-facing gaps, phrased as advisories for `lib/env.ts`.
 *
 * Only two things are listed. The statement descriptor decides whether a payer
 * recognises the charge on their card statement at all, and a registration
 * number is a fact a seller has to be able to state where one exists. Neither
 * is printed by this deployment any more, so a missing value breaks nothing a
 * visitor can see — which is why these are advisories in a status report rather
 * than a startup failure. */
export function operatorAdvisories(env: NodeJS.ProcessEnv = process.env): { key: string; reason: string }[] {
  const info = operatorInfo(env);
  const out: { key: string; reason: string }[] = [];
  if (!info.descriptor) out.push({ key: OPERATOR_ENV.descriptor, reason: "no card-statement descriptor is configured, so a charge cannot be recognised on a statement. Set the value Stripe prints." });
  else if (!descriptorIsValid(info.descriptor)) out.push({ key: OPERATOR_ENV.descriptor, reason: `descriptor "${info.descriptor}" is not a valid statement descriptor (5–22 characters, A–Z 0–9 space . * -); Stripe will reject or rewrite it.` });
  if (!info.taxId) out.push({ key: OPERATOR_ENV.taxId, reason: "no tax or company registration number is configured. Nothing is wrong if none exists — but where one does, the seller has to be able to state it, and this deployment records none." });
  return out;
}
