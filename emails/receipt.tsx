/** Receipt email template (copy lock).
 * Subject: `You're #1 in C (Carbon) 🎉` — and at any other rank
 * `You're #2 in C (Carbon)`, because a receipt reports the rank the stake
 * actually settled at (R09-2: a payment that loses a same-moment race must not
 * be receipted as the #1 it was aimed at).
 *
 * Deliberately short: the amount, the rank, the profile link and the
 * unsubscribe line. The seller/descriptor/tax/reference block was removed
 * (2026-09-28) — the rules page carries those terms, and the mail is the
 * buyer's confirmation, not a legal document.
 */
import { esc } from "./escape";

export type ReceiptTemplateProps = {
  elementSymbol: string;
  elementName: string;
  amountUsd: number;
  rank: number;
  domain: string;
  /** R10-4: set when this payment added to a stake the buyer already held, so
   * the mail can state both the charge and the resulting position instead of
   * letting "$3" read as the whole stake. */
  topUpUsd?: number | null;
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
  // R10-4: a reclaim payment is charged as the difference, so the receipt has to
  // say what the charge did to the position — one line per fact, never a
  // substituted number.
  const stake = p.topUpUsd
    ? `Your $${p.topUpUsd} top-up adds to the stake you already held: <strong>$${p.amountUsd}</strong> now stands for you on ${esc(p.elementSymbol)}, at <strong>#${p.rank}</strong>.`
    : `Your $${p.amountUsd} stake puts you <strong>#${p.rank}</strong> on ${esc(p.elementSymbol)}.`;
  return `<!doctype html><html><body style="margin:0;background:#f4f4f0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px;">
    <div style="background:#fff;border-radius:20px;padding:28px;border:1px solid #eee;">
      <div style="font-size:13px;color:#888;font-weight:700;letter-spacing:1px;">PERIODICTABLE.LOL</div>
      <h1 style="font-size:22px;margin:12px 0 8px;">${esc(headline)}</h1>
      <p style="font-size:15px;color:#444;line-height:1.5;">
        ${stake}
        Every click from your tile is a verified redirect — watch 🟢 clicks delivered climb on your profile.
      </p>
      <a href="${p.viewUrl}" style="display:inline-block;margin-top:16px;background:#FFCE4B;color:#111;font-weight:800;padding:14px 28px;border-radius:999px;text-decoration:none;font-size:15px;">View your spot →</a>
      <p style="font-size:12px;color:#999;margin-top:20px;">
        it&apos;s an ad buy, not a bet ·
        <a href="${p.unsubUrl}">unsubscribe</a>
      </p>
    </div>
  </div>
</body></html>`;
}
