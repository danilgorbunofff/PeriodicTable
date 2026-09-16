/** Waitlist confirmation (R05-7).
 *
 * The checkout-paused path promises "You're on the waitlist — we'll be in
 * touch." (components/Modals.tsx). This is that touch: one message per
 * address, no marketing, no further mail until checkout opens.
 */
import { esc } from "./escape";

export type WaitlistTemplateProps = {
  domain: string | null;
  tableUrl: string;
  /** R10-6: the per-entry unsubscribe link. Absent only for a caller that has
   * no token to give, which then keeps the reply-to-be-removed sentence. */
  unsubUrl?: string | null;
};

export function waitlistSubject(): string {
  return "You're on the waitlist";
}

export function waitlistHtml(p: WaitlistTemplateProps): string {
  const subjectLine = esc(p.domain ? `${p.domain} on periodictable.lol` : "periodictable.lol");
  const leave = p.unsubUrl
    ? `one message, sent because you asked to be notified · <a href="${p.unsubUrl}" style="color:#999;">leave the list</a>`
    : "one message, sent because you asked to be notified · reply to this address and we'll remove you";
  return `<!doctype html><html><body style="margin:0;background:#f4f4f0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px;">
    <div style="background:#fff;border-radius:20px;padding:28px;border:1px solid #eee;">
      <div style="font-size:13px;color:#888;font-weight:700;letter-spacing:1px;">PERIODICTABLE.LOL</div>
      <h1 style="font-size:22px;margin:12px 0 8px;">You're on the waitlist ✋</h1>
      <p style="font-size:15px;color:#444;line-height:1.5;">
        We have <strong>${subjectLine}</strong> on the list. Checkout is paused while we open
        payments; nothing has been charged and no card details were taken.
      </p>
      <p style="font-size:15px;color:#444;line-height:1.5;">
        We'll email this address when the table opens for staking. Until then you can watch
        the board — it stays free to read.
      </p>
      <a href="${p.tableUrl}" style="display:inline-block;margin-top:16px;background:#FFCE4B;color:#111;font-weight:800;padding:14px 28px;border-radius:999px;text-decoration:none;font-size:15px;">See the table</a>
      <p style="font-size:12px;color:#999;margin-top:20px;">
        ${leave}
      </p>
    </div>
  </div>
</body></html>`;
}
