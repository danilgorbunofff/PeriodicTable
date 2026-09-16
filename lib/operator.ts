/* The little of the operator's identity this product is willing to hold.
 *
 * The published posture is deliberately minimal: the four documents name no
 * operator, no company, no postal address and no jurisdiction, and the only
 * contact point anywhere is `SUPPORT_EMAIL` in `lib/legal.ts`. What is left here
 * is the handful of values a *receipt* cannot do without, read from the server
 * environment — never `NEXT_PUBLIC_`, so none of them can be shipped to a browser
 * as an empty string:
 *
 *   OPERATOR_NAME        a seller name, for a deployment that has a registered entity
 *   OPERATOR_COUNTRY     the country that entity is established in
 *   OPERATOR_TAX_ID      VAT / company / registration number, if one exists
 *   OPERATOR_DESCRIPTOR  the descriptor Stripe prints on card statements
 *
 * Both halves of the rule are load-bearing: an unset value is omitted from the
 * mail rather than rendered as a labelled blank (a payer cannot act on "not
 * published in this deployment"), and no page prints any of these at all — the
 * receipt is the only surface where a payer has to be able to recognise the
 * charge and the seller behind it.
 */

import { RECEIPT_TAX_LINE, SUPPORT_EMAIL, type ReceiptLegal } from "./legal";

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

/**
 * The receipt's legal block, assembled from the deployment's configuration.
 *
 * Nulls are deliberate. An unset seller name, country, descriptor or tax id is
 * omitted from the mail rather than rendered as a placeholder: the block exists
 * to let a payer recognise a charge, and a line that says nothing is worse than
 * no line. There is no rules *version* on it either — the documents are not
 * versioned — only the day the wording was accepted and where to read it, which
 * is what a dispute over "what did I agree to" turns on.
 */
export function receiptLegal(opts: {
  rulesUrl: string;
  reference?: string | null;
  consentAt?: Date | null;
  env?: NodeJS.ProcessEnv;
}): ReceiptLegal {
  const info = operatorInfo(opts.env);
  const seller = [info.name, info.country ? `established in ${info.country}` : null].filter(Boolean).join(", ");
  return {
    seller: seller || null,
    descriptor: descriptorIsValid(info.descriptor) ? info.descriptor : null,
    taxLine: RECEIPT_TAX_LINE,
    taxId: info.taxId,
    rulesUrl: opts.rulesUrl,
    // Day precision on purpose: the record exists to identify the wording
    // accepted, and a receipt that prints a time in the deployment's zone
    // invites a dispute about the clock instead of the charge.
    rulesAcceptedAt: opts.consentAt ? opts.consentAt.toISOString().slice(0, 10) : null,
    reference: opts.reference ?? null,
    billing: SUPPORT_EMAIL,
  };
}

/** The operator-facing gaps, phrased as advisories for `lib/env.ts`.
 *
 * Only two things are listed, because only two things in this module reach a
 * payer: the statement descriptor (without it a charge cannot be recognised, and
 * an invalid one is refused or rewritten by Stripe) and a registration number
 * (which a receipt legally has to name where one exists). The published pages
 * name neither, so a missing value breaks nothing a visitor can see — which is
 * why these are advisories in a status report rather than a startup failure. */
export function operatorAdvisories(env: NodeJS.ProcessEnv = process.env): { key: string; reason: string }[] {
  const info = operatorInfo(env);
  const out: { key: string; reason: string }[] = [];
  if (!info.descriptor) out.push({ key: OPERATOR_ENV.descriptor, reason: "no card-statement descriptor is configured, so a charge cannot be recognised from the receipt. Set the value Stripe prints." });
  else if (!descriptorIsValid(info.descriptor)) out.push({ key: OPERATOR_ENV.descriptor, reason: `descriptor "${info.descriptor}" is not a valid statement descriptor (5–22 characters, A–Z 0–9 space . * -); Stripe will reject or rewrite it.` });
  if (!info.taxId) out.push({ key: OPERATOR_ENV.taxId, reason: "no tax or company registration number is configured. Nothing is wrong if none exists — but where one does, the receipt has to name it, and until this is set no receipt does." });
  return out;
}
