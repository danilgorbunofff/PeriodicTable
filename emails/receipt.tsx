/** Receipt email template (copy lock).
 * Subject: `You're #1 in C (Carbon) 🎉` — and at any other rank
 * `You're #2 in C (Carbon)`, because a receipt reports the rank the stake
 * actually settled at (R09-2: a lapsed take is applied at its stale amount and
 * must not be receipted as the #1 it was quoted for).
 */
import type { ReceiptLegal } from "../lib/legal";
import { esc } from "./escape";

export type ReceiptTemplateProps = {
  elementSymbol: string;
  elementName: string;
  amountUsd: number;
  rank: number;
  domain: string;
  /** Set when the payment carried a take quote that expired before it settled:
   * the figure the quote held, so the receipt can say the rank is the board's
   * answer rather than the quote's. */
  lapsedTakeTotal?: number | null;
  /** R10-4: set when this payment added to a stake the buyer already held, so
   * the mail can state both the charge and the resulting position instead of
   * letting "$3" read as the whole stake. */
  topUpUsd?: number | null;
  /** The legal block of the receipt: seller, statement descriptor, tax position
   * and registration, the day the rules were accepted, the payment reference and
   * where to write before disputing.
   * Optional so a caller that has none of it still renders a receipt, but
   * `lib/email.ts` always supplies it — and `lib/receiptLegal.test.ts` fails if
   * the sent mail loses it. */
  legal?: ReceiptLegal | null;
  /** Public profile link. Listing edits are not offered in v1 — the profile
   * is set at checkout and is final, so this is a "view", not a "manage". */
  viewUrl: string;
  unsubUrl: string;
};

export function receiptSubject(p: { elementSymbol: string; elementName: string; rank?: number }): string {
  const name = `${p.elementSymbol} (${p.elementName})`;
  return (p.rank ?? 1) <= 1 ? `You're #1 in ${name} 🎉` : `You're #${p.rank} in ${name}`;
}

export function receiptHtml(p: ReceiptTemplateProps) {
  const headline = receiptSubject({ elementSymbol: p.elementSymbol, elementName: p.elementName, rank: p.rank });
  const lapse = p.lapsedTakeTotal
    ? `<p style="font-size:14px;color:#a4601a;background:#fff8e6;border-radius:12px;padding:12px;line-height:1.5;margin:12px 0 0;">
        Your $${p.lapsedTakeTotal} take quote lapsed before this payment cleared, so it settled as an ordinary stake at <strong>#${p.rank}</strong>.
      </p>`
    : "";
  // R10-4: a reclaim payment is charged as the difference, so the receipt has to
  // say what the charge did to the position — one line per fact, never a
  // substituted number.
  const stake = p.topUpUsd
    ? `Your $${p.topUpUsd} top-up adds to the stake you already held: <strong>$${p.amountUsd}</strong> now stands for you on ${esc(p.elementSymbol)}, at <strong>#${p.rank}</strong>.`
    : `Your $${p.amountUsd} stake puts you <strong>#${p.rank}</strong> on ${esc(p.elementSymbol)}.`;
  // R16-4/R16-5/R16-7: the block that turns this from a price notice into a
  // document a payer can check against a statement. Each line appears only when
  // the deployment knows the value; nothing is padded with a placeholder.
  const legalLine = (label: string, value: string) =>
    `<div style="font-size:12px;color:#777;line-height:1.6;"><strong>${label}</strong> ${value}</div>`;
  const legal = p.legal
    ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid #eee;">
      ${p.legal.seller ? legalLine("Sold by", esc(p.legal.seller)) : ""}
      ${p.legal.descriptor ? legalLine("Card statement", `your statement shows <strong>${esc(p.legal.descriptor)}</strong>`) : ""}
      ${legalLine("Tax", `${esc(p.legal.taxLine)}${p.legal.taxId ? ` Registration ${esc(p.legal.taxId)}.` : ""}`)}
      ${legalLine("Rules", `${p.legal.rulesAcceptedAt ? `accepted at checkout on ${esc(p.legal.rulesAcceptedAt)} — ` : ""}<a href="${esc(p.legal.rulesUrl)}">read them</a>`)}
      ${p.legal.reference ? legalLine("Payment reference", esc(p.legal.reference)) : ""}
      ${legalLine("Refunds", `a stake buys advertising delivered on settlement, so it is final: no refunds or withdrawals. If something is wrong with this charge, write to <a href="mailto:${esc(p.legal.billing)}">${esc(p.legal.billing)}</a> before disputing it — this reference is what identifies the payment.`)}
    </div>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f4f4f0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px;">
    <div style="background:#fff;border-radius:20px;padding:28px;border:1px solid #eee;">
      <div style="font-size:13px;color:#888;font-weight:700;letter-spacing:1px;">PERIODICTABLE.LOL</div>
      <h1 style="font-size:22px;margin:12px 0 8px;">${esc(headline)}</h1>
      <p style="font-size:15px;color:#444;line-height:1.5;">
        ${stake}
        Every click from your tile is a verified redirect — watch 🟢 clicks delivered climb on your profile.
      </p>${lapse}${legal}
      <a href="${p.viewUrl}" style="display:inline-block;margin-top:16px;background:#FFCE4B;color:#111;font-weight:800;padding:14px 28px;border-radius:999px;text-decoration:none;font-size:15px;">View your spot →</a>
      <p style="font-size:12px;color:#999;margin-top:20px;">
        it&apos;s an ad buy, not a bet ·
        <a href="${p.unsubUrl}">unsubscribe</a>
      </p>
    </div>
  </div>
</body></html>`;
}
