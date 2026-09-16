import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { clientIp } from "@/lib/ip";
import { rateLimitAsync } from "@/lib/rateStore";
import { apiRoute } from "@/lib/route";
import {
  normalizeRecipient,
  resendEventEffect,
  RESEND_EVENT_TYPES,
  suppressEmail,
  verifyResendWebhook,
} from "@/lib/email";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ POST: postResendWebhook });

/** How much of the provider's text to keep. Long enough to name the reason,
 *  short enough that a body echoing the recipient is not stored at length. */
const MAX_DETAIL = 300;

type ResendPayload = {
  type?: unknown;
  data?: {
    email_id?: unknown;
    to?: unknown;
    bounce?: { type?: unknown; message?: unknown } | null;
    failed?: { reason?: unknown } | null;
  } | null;
};

const text = (v: unknown, max = MAX_DETAIL): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** `to` is an array in current payloads and was a string in older ones. */
function recipientOf(data: ResendPayload["data"]): string | null {
  const to = data?.to;
  const raw = Array.isArray(to) ? to.find((v) => typeof v === "string" && v.trim()) : to;
  return typeof raw === "string" && raw.trim() ? normalizeRecipient(raw) : null;
}

/**
 * Resend delivery webhook (R10-7).
 *
 * Until this existed, the product had no way to hear that mail was not
 * arriving: a hard bounce or a spam complaint reached Resend's dashboard and
 * nothing else, and we kept sending to an address that had refused us — which
 * is how a sending domain's reputation is lost.
 *
 * - Authenticated by Resend's own Svix signature over the raw bytes
 *   (verifyResendWebhook); 401 on anything else. An unauthenticated caller must
 *   never be able to suppress an address: the list is only credible if every
 *   entry is evidence-backed.
 * - Reads the raw body *before* parsing, because the signature covers bytes.
 * - Acts on permanent bounces, complaints, and provider send failures; a
 *   transient bounce is audited and otherwise ignored (see `resendEventEffect`).
 * - Records the decision where an operator looks for it: the `EmailAddress` row
 *   (the refusal itself, with the provider's reason in `detail`), an audit row
 *   naming the address, and — when the provider's message id matches a row we
 *   sent — the bounce text attached to that `EmailLog` row. Correlation rides on
 *   `providerMessageId`, which is why the send path stores it.
 * - Answers 200 for everything it has authenticated, including events it
 *   ignores. A 4xx/5xx here means "we failed", and the provider's answer to that
 *   is retrying a delivery we would fail again — and, eventually, disabling the
 *   endpoint.
 */
async function postResendWebhook(req: NextRequest) {
  const ip = clientIp(req.headers);
  if (!(await rateLimitAsync(`resend:${ip}`, 120, 60_000))) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  const raw = await req.text();
  if (!verifyResendWebhook(raw, req.headers)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let payload: ResendPayload;
  try {
    payload = JSON.parse(raw) as ResendPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const type = text(payload.type, 64);
  if (!type) return NextResponse.json({ error: "Missing event type." }, { status: 400 });
  if (!(RESEND_EVENT_TYPES as readonly string[]).includes(type)) {
    // Not a failure: an event we do not know about was still delivered, and
    // failing it would only make the provider retry something we will never
    // understand.
    console.log(`[resend-webhook] ignoring unknown event ${type}`);
    return NextResponse.json({ ok: true, ignored: type });
  }

  const address = recipientOf(payload.data);
  const messageId = text(payload.data?.email_id, 128);
  const bounceType = text(payload.data?.bounce?.type, 64);
  const providerText =
    text(payload.data?.bounce?.message) ?? text(payload.data?.failed?.reason) ?? null;
  const { suppress, note } = resendEventEffect(type, bounceType);

  if (!address) {
    // Authenticated, relevant, and unactionable: record that we were told, so a
    // provider problem that names no address is not silence.
    await audit({
      action: "EMAIL_UNDELIVERABLE",
      actorType: "system",
      actorRef: "resend",
      detail: `${type} ${note}${messageId ? ` mid:${messageId}` : ""} (no recipient in payload)`,
    });
    console.log(`[resend-webhook] ${type} carried no recipient`);
    return NextResponse.json({ ok: true, acted: false });
  }

  const detail = `${type} ${note}${providerText ? `: ${providerText}` : ""}`;
  if (suppress) {
    await suppressEmail({
      email: address,
      reason: suppress,
      source: `resend:${type}`,
      detail: providerText ? `${note}: ${providerText}` : note,
    });
    if (messageId) {
      // Annotate, never overwrite: a row that carries an error already explains
      // itself, and this is the provider's later account of the same message.
      await prisma.emailLog.updateMany({
        where: { providerMessageId: messageId, error: null },
        data: { error: `${note}${providerText ? `: ${providerText}` : ""}`.slice(0, MAX_DETAIL) },
      });
    }
  }
  await audit({
    action: "EMAIL_UNDELIVERABLE",
    actorType: "system",
    actorRef: "resend",
    detail: `${address} ${detail}${messageId ? ` mid:${messageId}` : ""}`,
  });
  console.log(
    `[resend-webhook] ${type} ${address}${suppress ? ` → suppressed:${suppress}` : " (no suppression)"}`
  );
  return NextResponse.json({ ok: true, acted: !!suppress, suppressed: suppress ?? null });
}
