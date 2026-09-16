/* The consent act, as a record (R16-6, R16-7).
 *
 * Doc 16 §3.3: the checkout's single checkbox carries two attestations — 18+,
 * and the rules — the client sends a bare boolean, the server validates
 * `attest === true` (`lib/abuse.ts`) and *nothing is persisted*. A payment could
 * therefore be refused for a missing checkbox, but a payment that went through
 * had no evidence of what the payer was shown or agreed to.
 *
 * This module makes the act recordable:
 *   - `ATTEST_VERSION` is the revision of the rules in force, imported from the
 *     same constant the documents and the checkout modal render, so the words
 *     shown, the version printed, and the version recorded cannot drift;
 *   - `CONSENT_TEXT_HASH` is a digest of the exact statement shown, so the
 *     record proves what the words were without storing them per payment;
 *   - `consentRecord()` produces the three values `Payment` carries, and
 *     `attestVersionRefusal()` is the server's check on the version a client
 *     says it displayed (a stale tab is refused rather than silently recorded
 *     against terms it never showed).
 *
 * Server-side only (`node:crypto`). The client needs nothing but the version
 * string, which is plain data in `lib/legal.ts`.
 */

import { createHash } from "node:crypto";
import { CONSENT_STATEMENT, CONSENT_VERSION } from "./legal";

/** The revision of the rules a stake is bought under. */
export const ATTEST_VERSION = CONSENT_VERSION;

export function consentTextHash(text: string, version: string = ATTEST_VERSION): string {
  return createHash("sha256").update(`${version}\n${text}`, "utf8").digest("hex");
}

/** Digest of the words the checkbox affirms. Recomputing it from
 * `CONSENT_STATEMENT` is what makes an edit to the copy a visible change. */
export const CONSENT_TEXT_HASH = consentTextHash(CONSENT_STATEMENT);

export type ConsentRecord = {
  consentVersion: string;
  consentTextHash: string;
  consentAt: Date;
};

export function consentRecord(now: Date = new Date()): ConsentRecord {
  return { consentVersion: ATTEST_VERSION, consentTextHash: CONSENT_TEXT_HASH, consentAt: now };
}

/** Why a client's claimed version is refused, or `null` when it is acceptable.
 * An absent version is tolerated (older clients, and the acceptance tests that
 * post a bare `attest: true`) and recorded as the version in force at the time;
 * a *wrong* version is a hard refusal, because the payer would be agreeing to
 * something other than what they read. */
export function attestVersionRefusal(sent: unknown): string | null {
  if (sent === undefined || sent === null || sent === "") return null;
  if (typeof sent !== "string") return "Please reload the page and try again.";
  if (sent !== ATTEST_VERSION) {
    return "These rules have been updated since this page was loaded. Open Rules & payments, read the current version, and tick the box again.";
  }
  return null;
}
