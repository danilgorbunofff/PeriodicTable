/**
 * Transactional email — Resend via fetch when RESEND_API_KEY is set;
 * without a key, sends are logged as EmailLog{status:"logged"} so the
 * pipeline is testable end-to-end locally. Suppression + EmailLog always.
 */
import { prisma } from "./prisma";
import { outbidHtml, outbidSubject } from "../emails/outbid";
import { outbidReclaimUrl } from "./links";
import { receiptHtml, receiptSubject } from "../emails/receipt";
import { refundHtml, refundSubject } from "../emails/refund";
import { reportHtml, reportSubject } from "../emails/report";
import { waitlistHtml, waitlistSubject } from "../emails/waitlist";

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
      to: row.to,
      template: row.template,
      elementSymbol: row.elementSymbol ?? null,
      amountUsd: row.amountUsd ?? null,
      status: row.status,
      detail: row.detail ?? null,
    },
  });
}

async function deliver(
  to: string,
  subject: string,
  html: string,
  headers?: { unsubToken?: string }
): Promise<"sent" | "logged" | "error"> {
  if (!process.env.RESEND_API_KEY) return "logged";
  try {
    // RFC 8058 one-click unsubscribe (P1-18): POST endpoint + headers. The
    // token is opaque; no email address ever appears in a URL.
    const unsubUrl = headers?.unsubToken ? `${APP_URL}/api/unsubscribe?token=${headers.unsubToken}` : null;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        ...(unsubUrl
          ? {
              "List-Unsubscribe": `<${unsubUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            }
          : {}),
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? "periodictable.lol <hi@periodictable.lol>",
        to,
        subject,
        html,
      }),
      signal: AbortSignal.timeout(10_000),
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
  victimDomain: string;
  victimTotal: number;
  winnerDomain: string;
  winnerAmount: number;
};

export async function sendOutbidEmail(p: OutbidEmailParams) {
  const reclaim = Math.max(1, p.winnerAmount + 1 - p.victimTotal);
  const subject = outbidSubject({ elementSymbol: p.elementSymbol });
  const html = outbidHtml({
    elementSymbol: p.elementSymbol,
    winnerDomain: p.winnerDomain,
    winnerAmount: p.winnerAmount,
    reclaim,
    reclaimUrl: outbidReclaimUrl(APP_URL, {
      elementSymbol: p.elementSymbol,
      reclaim,
      domain: p.victimDomain,
    }),
    unsubUrl: `${APP_URL}/api/unsubscribe?token=${p.unsubToken}`,
  });
  const status = await deliver(p.to, subject, html, { unsubToken: p.unsubToken });
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
  const subject = receiptSubject({ elementSymbol: p.elementSymbol, elementName: p.elementName });
  const html = receiptHtml({
    elementSymbol: p.elementSymbol,
    elementName: p.elementName,
    amountUsd: p.amountUsd,
    rank: p.rank,
    domain: p.domain,
    viewUrl: `${APP_URL}/s/${encodeURIComponent(p.domain)}`,
    unsubUrl: `${APP_URL}/api/unsubscribe?token=${p.unsubToken}`,
  });
  const status = await deliver(p.to, subject, html, { unsubToken: p.unsubToken });
  await logEmail({
    to: p.to,
    template: "receipt",
    elementSymbol: p.elementSymbol,
    amountUsd: p.amountUsd,
    status,
    detail: subject,
  });
}

export type RefundEmailParams = {
  to: string;
  unsubToken: string;
  elementSymbol: string;
  elementName: string;
  amountUsd: number;
  domain: string;
  providerRef: string | null;
};

/** Buyer notice for a reversed payment (R08-2). Enqueued inside the reversal
 *  transaction, so the notice survives a process death between commit and
 *  delivery — a refund the buyer never hears about is the one mail in this
 *  system that cannot be left to best-effort. */
export async function sendRefundEmail(p: RefundEmailParams) {
  const subject = refundSubject({ elementSymbol: p.elementSymbol, amountUsd: p.amountUsd });
  const html = refundHtml({
    elementSymbol: p.elementSymbol,
    elementName: p.elementName,
    amountUsd: p.amountUsd,
    domain: p.domain,
    providerRef: p.providerRef,
    unsubUrl: `${APP_URL}/api/unsubscribe?token=${p.unsubToken}`,
  });
  const status = await deliver(p.to, subject, html, { unsubToken: p.unsubToken });
  await logEmail({
    to: p.to,
    template: "refund",
    elementSymbol: p.elementSymbol,
    amountUsd: p.amountUsd,
    status,
    detail: subject,
  });
}

export type ReportEmailParams = {
  to: string;
  id: string;
  domain: string | null;
  stakeId: string | null;
  reason: string;
  createdAt: Date;
};

/** Operator notification for a new report (R05-7). No unsubscribe header: this
 *  is a one-off operational message to the moderation inbox, not a list. */
export async function sendReportEmail(p: ReportEmailParams) {
  const subject = reportSubject({ domain: p.domain });
  const html = reportHtml({
    id: p.id,
    domain: p.domain,
    stakeId: p.stakeId,
    reason: p.reason,
    createdAt: `${p.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    queueUrl: `${APP_URL}/api/admin/reports`,
  });
  const status = await deliver(p.to, subject, html);
  await logEmail({ to: p.to, template: "report", status, detail: subject });
}

export type WaitlistEmailParams = {
  to: string;
  domain: string | null;
  source: string;
};

/** Confirmation to the address that joined the waitlist (R05-7). */
export async function sendWaitlistEmail(p: WaitlistEmailParams) {
  const subject = waitlistSubject();
  const html = waitlistHtml({ domain: p.domain, tableUrl: APP_URL });
  const status = await deliver(p.to, subject, html);
  await logEmail({ to: p.to, template: "waitlist", status, detail: `${subject} (${p.source})` });
}
