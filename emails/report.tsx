/** Operator notification for a new listing report (R05-7).
 *
 * The moderation queue (app/api/admin/reports) stays the durable record; this
 * mail is what makes the "actioned within 72 hours" promise on /legal/contact
 * a notice rather than a promise nobody sees. Recipient: REPORT_NOTIFY_EMAIL,
 * defaulting to the abuse address the legal page prints.
 */
import { esc } from "./escape";

export type ReportTemplateProps = {
  id: string;
  domain: string | null;
  stakeId: string | null;
  reason: string;
  createdAt: string;
  queueUrl: string;
};

export function reportSubject(p: { domain: string | null }): string {
  return `[report] ${p.domain ?? "unattached listing"}`;
}

export function reportHtml(p: ReportTemplateProps): string {
  const where = esc(p.domain ?? "(no listing attached)");
  return `<!doctype html><html><body style="margin:0;background:#f4f4f0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px;">
    <div style="background:#fff;border-radius:20px;padding:28px;border:1px solid #eee;">
      <div style="font-size:13px;color:#888;font-weight:700;letter-spacing:1px;">PERIODICTABLE.LOL · MODERATION</div>
      <h1 style="font-size:22px;margin:12px 0 8px;">New listing report</h1>
      <p style="font-size:15px;color:#444;line-height:1.5;">
        <strong>${where}</strong> was reported ${p.createdAt}.
      </p>
      <p style="font-size:15px;color:#444;line-height:1.5;background:#f7f7f4;border-radius:12px;padding:12px;margin-top:12px;">
        ${esc(p.reason)}
      </p>
      <p style="font-size:13px;color:#888;margin-top:16px;">
        report <code>${esc(p.id)}</code>${p.stakeId ? ` · stake <code>${esc(p.stakeId)}</code>` : ""}<br />
        ip is stored as a salted hash only.
      </p>
      <a href="${p.queueUrl}" style="display:inline-block;margin-top:16px;background:#FFCE4B;color:#111;font-weight:800;padding:14px 28px;border-radius:999px;text-decoration:none;font-size:15px;">Open the queue</a>
      <p style="font-size:12px;color:#999;margin-top:20px;">
        the queue is the source of truth · hiding a listing is a moderation decision, not a mail action
      </p>
    </div>
  </div>
</body></html>`;
}
