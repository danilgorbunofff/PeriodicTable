/* Operator identity, configured or explicitly blank (R16-11).
 *
 * Doc 16 §5.8 found zero hits for the operator's identity, address, company
 * number or jurisdiction anywhere in the product, and §3.2 A27 found the one
 * sentence that came close ("operated as an independent project; postal address
 * available on request"). This module is the single place those values can come
 * from, and the rule it enforces is that an unset value renders as a labelled
 * blank rather than as a plausible-sounding invention:
 *
 *   OPERATOR_NAME        legal entity or person operating the site
 *   OPERATOR_ADDRESS     postal address for legal correspondence / service
 *   OPERATOR_COUNTRY     country (or state) of establishment
 *   OPERATOR_LAW         governing law and venue for disputes
 *   OPERATOR_TAX_ID      VAT / company / registration number, if any
 *   OPERATOR_DESCRIPTOR  the descriptor Stripe prints on card statements
 *
 * The same values drive the About page (identity), the rules page and the
 * receipt (descriptor), the contact page (where to write) and the operator
 * advisories in `lib/env.ts` — so the site cannot print one descriptor while the
 * payment provider prints another, and a missing identity shows up in the same
 * status report the operator already reads (R16-12d).
 *
 * Deliberately server-side only: nothing here is `NEXT_PUBLIC_`, so a blank
 * cannot be silently shipped to browsers as an empty string.
 */

import { CONSENT_VERSION, RECEIPT_TAX_LINE, SUPPORT, type ReceiptLegal } from "./legal";

export type OperatorInfo = {
  name: string | null;
  address: string | null;
  country: string | null;
  law: string | null;
  taxId: string | null;
  descriptor: string | null;
};

export type OperatorLine = { label: string; value: string; text: string; configured: boolean };

export const OPERATOR_ENV = {
  name: "OPERATOR_NAME",
  address: "OPERATOR_ADDRESS",
  country: "OPERATOR_COUNTRY",
  law: "OPERATOR_LAW",
  taxId: "OPERATOR_TAX_ID",
  descriptor: "OPERATOR_DESCRIPTOR",
} as const;

/** Rendered wherever a configured value is missing: an explicit blank is a
 * statement, a guess is a false claim. */
export const OPERATOR_UNPUBLISHED = "not published in this deployment";

export const OPERATOR_LABELS: Record<keyof OperatorInfo, string> = {
  name: "Operator",
  address: "Postal address",
  country: "Country of establishment",
  law: "Governing law and venue",
  taxId: "Tax / company registration",
  descriptor: "Card statement descriptor",
};

function read(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function operatorInfo(env: NodeJS.ProcessEnv = process.env): OperatorInfo {
  return {
    name: read(env, OPERATOR_ENV.name),
    address: read(env, OPERATOR_ENV.address),
    country: read(env, OPERATOR_ENV.country),
    law: read(env, OPERATOR_ENV.law),
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

/** The About page's operator section, and the input to the acceptance check that
 * every one of these is either published or flagged. */
export function operatorLines(env: NodeJS.ProcessEnv = process.env): OperatorLine[] {
  const info = operatorInfo(env);
  const keys = Object.keys(OPERATOR_LABELS) as (keyof OperatorInfo)[];
  return keys.map((key) => {
    const value = info[key];
    const label = OPERATOR_LABELS[key];
    return {
      label,
      value: value ?? OPERATOR_UNPUBLISHED,
      text: `${label}: ${value ?? OPERATOR_UNPUBLISHED}`,
      configured: value !== null,
    };
  });
}

/**
 * The receipt's legal block (R16-4, R16-5, R16-7), assembled from the same
 * configuration the pages print — so the descriptor a payer compares against
 * their statement is the one the rules page published, and the rules version on
 * the receipt is the one the checkout recorded.
 *
 * Nulls are deliberate: an unset operator name, descriptor or tax id is omitted
 * from the mail rather than rendered as `OPERATOR_UNPUBLISHED`. A payer cannot
 * act on "not published in this deployment", and a receipt is the wrong place to
 * teach them the deployment's gaps — the About page and the operator advisories
 * are where those show up.
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
    rulesVersion: CONSENT_VERSION,
    rulesUrl: opts.rulesUrl,
    // Day precision on purpose: the record exists to identify the revision
    // accepted, and a receipt that prints a time in the deployment's zone
    // invites a dispute about the clock instead of the charge.
    rulesAcceptedAt: opts.consentAt ? opts.consentAt.toISOString().slice(0, 10) : null,
    reference: opts.reference ?? null,
    billing: SUPPORT.billing,
  };
}

/** The operator-facing gaps, phrased as advisories for `lib/env.ts` (R16-12b).
 * Only the fields a buyer or a regulator needs are listed here; the legal text
 * itself is versioned in `lib/legalDocs.ts`. */
export function operatorAdvisories(env: NodeJS.ProcessEnv = process.env): { key: string; reason: string }[] {
  const info = operatorInfo(env);
  const out: { key: string; reason: string }[] = [];
  if (!info.name) out.push({ key: OPERATOR_ENV.name, reason: "the site names no operator; the About page prints a blank. Configure a legal entity or person." });
  if (!info.address) out.push({ key: OPERATOR_ENV.address, reason: "no postal address for legal correspondence or service of process. Configure one, or accept that complaints have no address to be served on." });
  if (!info.country) out.push({ key: OPERATOR_ENV.country, reason: "the country of establishment is unset, so the governing-law statement on the About page is incomplete." });
  if (!info.law) out.push({ key: OPERATOR_ENV.law, reason: "no governing law or venue is published for disputes." });
  if (!info.descriptor) out.push({ key: OPERATOR_ENV.descriptor, reason: "no card-statement descriptor is published, so a charge cannot be recognised from the site or the receipt. Set the value Stripe prints." });
  else if (!descriptorIsValid(info.descriptor)) out.push({ key: OPERATOR_ENV.descriptor, reason: `descriptor "${info.descriptor}" is not a valid statement descriptor (5–22 characters, A–Z 0–9 space . * -); Stripe will reject or rewrite it.` });
  return out;
}
