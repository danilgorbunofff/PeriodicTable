/**
 * Transactional email — Resend via fetch when RESEND_API_KEY is set;
 * without a key, sends are logged as EmailLog{status:"logged"} so the
 * pipeline is testable end-to-end locally. Suppression + EmailLog always.
 */
import { prisma } from "./prisma";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

async function logEmail(row: {
  to: string;
  template: string;
  elementSymbol?: string | null;
  amountUsd?: number | null;
  status: string;
  detail?: string | null;
}) {
  await prisma.emailLog.create({
    data: {
      to: row.template === "outbid" ? row.to : row.to,
      template: row.template,
      elementSymbol: row.elementSymbol ?? null,
      amountUsd: row.amountUsd ?? null,
      status: row.status,
      detail: row.detail ?? null,
    },
  });
}

async function deliver(to: string, subject: string, html: string): Promise<"sent" | "logged" | "error"> {
  if (!process.env.RESEND_API_KEY) return "logged";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? "periodictable.lol <hi@periodictable.lol>",
        to,
        subject,
        html,
      }),
    });
    if (!res.ok) return "error";
    return "sent";
  } catch {
    return "error";
  }
}

export type OutbidEmailParams = {
  to: string;
  unsubToken: string;
  elementSymbol: string;
  elementName?: string;
  victimTotal: number;
  winnerDomain: string;
  winnerAmount: number;
};

export async function sendOutbidEmail(p: OutbidEmailParams) {
  const reclaim = Math.max(1, p.winnerAmount + 1 - p.victimTotal);
  const subject = `You were knocked off ${p.elementSymbol} 👑`;
  const html = outbidHtml(p, reclaim);
  const status = await deliver(p.to, subject, html);
  await logEmail({
    to: p.to,
    template: "outbid",
    elementSymbol: p.elementSymbol,
    amountUsd: reclaim,
    status,
    detail: subject,
  });
}

export type ReceiptEmailParams = {
  to: string;
  unsubToken: string;
  elementSymbol: string;
  elementName: string;
  amountUsd: number;
  rank: number;
  domain: string;
};

export async function sendReceiptEmail(p: ReceiptEmailParams) {
  const subject = `You're #1 in ${p.elementSymbol} (${p.elementName}) 🎉`;
  const html = receiptHtml(p);
  const status = await deliver(p.to, subject, html);
  await logEmail({
    to: p.to,
    template: "receipt",
    elementSymbol: p.elementSymbol,
    amountUsd: p.amountUsd,
    status,
    detail: subject,
  });
}

function outbidHtml(p: OutbidEmailParams, reclaim: number): string {
  const reclaimUrl = `${APP_URL}/?el=${p.elementSymbol}&stake=${reclaim}&email=${encodeURIComponent(p.to)}`;
  const unsubUrl = `${APP_URL}/api/unsubscribe?token=${p.unsubToken}`;
  return `<!doctype html><html><body style="margin:0;background:#f4f4f0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px;">
    <div style="background:#fff;border-radius:20px;padding:28px;border:1px solid #eee;">
      <div style="font-size:13px;color:#888;font-weight:700;letter-spacing:1px;">PERIODICTABLE.LOL</div>
      <h1 style="font-size:22px;margin:12px 0 8px;">You were knocked off ${p.elementSymbol} 👑</h1>
      <p style="font-size:15px;color:#444;line-height:1.5;">
        <strong>${p.winnerDomain}</strong> just took #1 with $${p.winnerAmount}.
        Your past stake still counts — reclaim it for <strong>$${reclaim}.00</strong> and take the crown back.
      </p>
      <a href="${reclaimUrl}" style="display:inline-block;margin-top:16px;background:#FFCE4B;color:#111;font-weight:800;padding:14px 28px;border-radius:999px;text-decoration:none;font-size:15px;">Reclaim now</a>
      <p style="font-size:12px;color:#999;margin-top:20px;">
        Past stake still counts · it's an ad buy, not a bet ·
        <a href="${unsubUrl}" style="color:#999;">unsubscribe</a>
      </p>
    </div>
  </div>
</body></html>`;
}

function receiptHtml(p: ReceiptEmailParams): string {
  const manageUrl = `${APP_URL}/s/${encodeURIComponent(p.domain)}`;
  const unsubUrl = `${APP_URL}/api/unsubscribe?token=${p.unsubToken}`;
  return `<!doctype html><html><body style="margin:0;background:#f4f4f0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:520px;max-width:520px;margin:0 auto;padding:24px 16px;">
    <div style="background:#fff;border-radius:20px;padding:28px;border:1px solid #eee;">
      <div style="font-size:13px;color:#888;font-weight:700;letter-spacing:1px;">PERIODICTABLE.LOL</div>
      <h1 style="font-size:22px;margin:12px 0 8px;">You're #1 in ${p.elementSymbol} (${p.elementName}) 🎉</h1>
      <p style="font-size:15px;color:#444;line-height:1.5;">
        Your $${p.amountUsd} stake puts you <strong>#${p.rank}</strong> on ${p.elementSymbol}.
        Every click from your tile is a verified redirect — watch 🟢 clicks delivered climb on your profile.
      </p>
      <a href="${manageUrl}" style="display:inline-block;margin-top:16px;background:#FFCE4B;color:#111;font-weight:800;padding:14px 28px;border-radius:999px;text-decoration:none;font-size:15px;">Manage your spot →</a>
      <p style="font-size:12px;color:#999;margin-top:20px;">
        it's an ad buy, not a bet ·
        <a href="${unsubUrl}">unsubscribe</a>
      </p>
    </div>
  </div>
</body></html>`;
}
