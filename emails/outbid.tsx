/** Outbid email template (copy lock — do not reword without PM).
 * Subject: `You were knocked off C (Carbon) 👑`
 * Body: `B (b.com) just took #1 with $21. Reclaim it for $2.00 → [Reclaim now]`
 */
export type OutbidTemplateProps = {
  elementSymbol: string;
  winnerDomain: string;
  winnerAmount: number;
  reclaim: number;
  reclaimUrl: string;
  unsubUrl: string;
};

export function outbidSubject(p: { elementSymbol: string }): string {
  return `You were knocked off ${p.elementSymbol} 👑`;
}

export function outbidHtml(p: OutbidTemplateProps): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px;">
    <div style="background:#fff;border-radius:20px;padding:28px;border:1px solid #eee;">
      <div style="font-size:13px;color:#888;font-weight:700;letter-spacing:1px;">PERIODICTABLE.LOL</div>
      <h1 style="font-size:22px;margin:12px 0 8px;">You were knocked off ${p.elementSymbol} 👑</h1>
      <p style="font-size:15px;color:#444;line-height:1.5;">
        <strong>${p.winnerDomain}</strong> just took #1 with $${p.winnerAmount}.
        Reclaim it for <strong>$${p.reclaim}.00</strong> and take the crown back.
      </p>
      <a href="${p.reclaimUrl}" style="display:inline-block;margin-top:16px;background:#FFCE4B;color:#111;font-weight:800;padding:14px 28px;border-radius:999px;text-decoration:none;font-size:15px;">Reclaim now</a>
      <p style="font-size:12px;color:#999;margin-top:20px;">
        your past stake still counts, so nothing&apos;s wasted · it&apos;s an ad buy, not a bet ·
        <a href="${p.unsubUrl}" style="color:#999;">unsubscribe</a>
      </p>
    </div>
  </div>
</body></html>`;
}
