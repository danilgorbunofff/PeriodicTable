/** Refund email template (copy lock).
 * Subject: `Refunded: your $5 stake on C (Carbon)`
 *
 * The one buyer-facing mail in the money-reversal path (R08-2). Deliberately
 * not a receipt: a receipt documents a purchase, and the purchase it would
 * describe no longer stands. It states the refund and the consequence, and
 * nothing else — no "sorry to see you go" upside-down sell, no re-purchase CTA
 * on a payment the network just took back.
 */
import { esc } from "./escape";

export type RefundTemplateProps = {
  elementSymbol: string;
  elementName: string;
  amountUsd: number;
  /** The buyer's own listing, which loses the position this payment held. */
  domain: string;
  /** Provider charge/session reference, when we have one on file. Shown only
   *  when present: it is what the buyer quotes to their bank. */
  providerRef: string | null;
  unsubUrl: string;
};

export function refundSubject(p: { elementSymbol: string; amountUsd: number }): string {
  return `Refunded: your $${p.amountUsd} stake on ${p.elementSymbol}`;
}

export function refundHtml(p: RefundTemplateProps): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px;">
    <div style="background:#fff;border-radius:20px;padding:28px;border:1px solid #eee;">
      <div style="font-size:13px;color:#888;font-weight:700;letter-spacing:1px;">PERIODICTABLE.LOL</div>
      <h1 style="font-size:22px;margin:12px 0 8px;">$${p.amountUsd} refunded</h1>
      <p style="font-size:15px;color:#444;line-height:1.5;">
        We reversed the $${p.amountUsd} you paid for <strong>${esc(p.elementSymbol)} (${esc(p.elementName)})</strong>.
        That stake no longer counts toward ${esc(p.domain)} and its place on the board is gone.
      </p>
      <p style="font-size:15px;color:#444;line-height:1.5;">
        Whether you asked for this or your bank did, the money is on its way back to the card
        you paid with. Banks usually post it within 5&ndash;10 business days.
      </p>
      <p style="font-size:12px;color:#999;margin-top:20px;">
        ${p.providerRef ? `reference ${esc(p.providerRef)} · ` : ""}it&apos;s an ad buy, not a bet ·
        <a href="${p.unsubUrl}">unsubscribe</a>
      </p>
    </div>
  </div>
</body></html>`;
}
