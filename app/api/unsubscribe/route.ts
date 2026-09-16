import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { resolveUnsubTarget, suppressionFor, suppressEmail, unsuppressEmail } from "@/lib/email";
import { apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: confirmUnsubscribe, POST: postUnsubscribe });

/**
 * One-click unsubscribe (Phase 6, P1-18 + RFC 8058), re-pointed at the address
 * rather than the listing (R10-5).
 *
 * What this route used to do was clear `Startup.email`, which is a *delivery
 * address*, not a permission: it stopped the mail by removing the destination,
 * so the next payment carrying the same address re-mailed the same person, and
 * a receipt addressed to `payment.email` was never affected at all. The refusal
 * is now a row on the address (`EmailAddress`) — the thing the person who
 * clicked actually controls.
 *
 * - GET renders a confirm form and never mutates state: link scanners and mail
 *   prefetchers must not unsubscribe anyone by following a link.
 * - POST applies the action carried by the same token and answers in the
 *   published shape (`{ok:true}` / `?unsub=done`) whether or not the token
 *   resolves, so the response is not an oracle. `?resubscribe=1` is the
 *   deliberate exception: to the holder of the token it shows whether mail is
 *   currently stopped, because that is the only way back.
 * - Mail clients that support one-click POST directly (see the
 *   `List-Unsubscribe` headers in lib/email.ts) get the same treatment.
 * - Tokens issued before this fix were the listing's (`Startup.unsubToken`) and
 *   still resolve, so the unsubscribe link in an old inbox keeps working.
 */

type Standing = { email: string; suppressed: boolean; listing: string | null };

/** The address a token governs, plus what we may honestly say about it. */
async function standing(token: string): Promise<Standing | null> {
  const target = await resolveUnsubTarget(token);
  if (!target) return null;
  if (target.kind === "address") {
    return { email: target.email, suppressed: (await suppressionFor(target.email)) !== null, listing: null };
  }
  // Listing-scoped token: the mail went to the notification address, or — when
  // the listing has none on file — to the address that funded the stake.
  const email =
    target.email ??
    (
      await prisma.payment.findFirst({
        where: { startupId: target.startupId, status: "PAID", email: { not: null } },
        orderBy: { paidAt: "desc" },
        select: { email: true },
      })
    )?.email ??
    null;
  if (!email) return null;
  const startup = await prisma.startup.findUnique({ where: { id: target.startupId }, select: { domain: true } });
  return { email, suppressed: (await suppressionFor(email)) !== null, listing: startup?.domain ?? null };
}

function page(body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><body style="margin:0;background:#f4f4f0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
<div style="max-width:440px;margin:60px auto;padding:28px;background:#fff;border-radius:20px;border:1px solid #eee;text-align:center;">
${body}</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function button(action: string, label: string, primary: boolean): string {
  const fg = primary ? "#fff" : "#111";
  const bg = primary ? "#111" : "#fff";
  return `<button type="submit" name="action" value="${action}" style="margin:6px 4px 0;background:${bg};color:${fg};font-weight:800;padding:12px 24px;border-radius:999px;border:1px solid #111;font-size:15px;cursor:pointer;">${label}</button>`;
}

async function confirmUnsubscribe(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("token") ?? "";
  // The token is a cuid we minted; anything else cannot resolve, so sanitizing
  // the hidden field only keeps a crafted value from breaking the markup.
  const field = raw.replace(/[^A-Za-z0-9_-]/g, "");
  const current = await standing(raw);

  if (!current) {
    // No oracle: an unknown link is not told whether it ever existed. The page
    // keeps the shape of the confirmed state rather than becoming an error.
    return page(
      `<h1 style="font-size:20px;margin:0 0 8px;">Link expired</h1>
<p style="font-size:14px;color:#555;">This unsubscribe link no longer resolves. If you are still getting mail, use the link in the newest message.</p>`
    );
  }

  const about = current.listing ? ` about <strong>${current.listing}</strong>` : "";
  const form = (inner: string) =>
    `<form method="POST" action="/api/unsubscribe"><input type="hidden" name="token" value="${field}" />${inner}</form>`;

  if (req.nextUrl.searchParams.get("resubscribe") === "1") {
    return page(
      current.suppressed
        ? `<h1 style="font-size:20px;margin:0 0 8px;">Start mail again?</h1>
<p style="font-size:14px;color:#555;">Mail to this address is stopped. Starting again means receipts and outbid notices for your stakes — nothing else.</p>
${form(button("unmute", "Start mail again", true))}`
        : `<h1 style="font-size:20px;margin:0 0 8px;">Mail is on</h1>
<p style="font-size:14px;color:#555;">Nothing to undo: this address is not stopped.</p>`
    );
  }

  return page(
    `<h1 style="font-size:20px;margin:0 0 8px;">Unsubscribe?</h1>
<p style="font-size:14px;color:#555;">Mail to this address${about} stops — receipts included. Your stakes stay live.</p>
${form(
  button("unsubscribe", "Stop all mail", true) +
    (current.suppressed ? "" : button("unmute", "Leave receipts alone", false))
)}
<p style="font-size:13px;color:#888;margin-top:14px;">Nothing has stopped yet — pick one.</p>
${
  current.suppressed
    ? ""
    : `<p style="font-size:13px;color:#888;margin-top:8px;">Changed your mind after stopping? <a href="/api/unsubscribe?token=${field}&amp;resubscribe=1" style="color:#111;">Start mail again</a>.</p>`
}`
  );
}

type Action = "unsubscribe" | "unmute";

const asAction = (raw: unknown): Action => (raw === "unmute" ? "unmute" : "unsubscribe");

async function apply(token: string, action: Action): Promise<void> {
  const current = await standing(token);
  // Unknown token: idempotent no-op with the same outcome shape (no oracle).
  if (!current) return;
  if (action === "unmute") {
    const changed = await unsuppressEmail(current.email);
    if (changed) await audit({ action: "EMAIL_RESUBSCRIBED", actorType: "owner", detail: current.email });
    return;
  }
  // Written even when the address was already refused, so the click is on the
  // record and the reason is the person's own: that is the reason an operator
  // sees for mail they may have expected.
  await suppressEmail({
    email: current.email,
    reason: "unsubscribe",
    source: current.listing ?? "unsubscribe-link",
    detail: "link clicked",
  });
  await audit({ action: "EMAIL_UNSUBSCRIBED", actorType: "owner", detail: current.email });
}

async function postUnsubscribe(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  let token = "";
  let action: Action = "unsubscribe";
  if (contentType.includes("application/json")) {
    try {
      const body = (await req.json()) as { token?: string; action?: string };
      token = body.token ?? "";
      action = asAction(body.action);
    } catch {
      token = "";
    }
    await apply(token, action);
    return NextResponse.json({ ok: true });
  }
  // RFC 8058 one-click clients POST the token in the URL with a
  // `List-Unsubscribe=One-Click` body, so the query string wins here; the
  // confirm page posts the token in the body instead. Reading the body first
  // would silently drop every one-click request: the one-click body parses as
  // valid form data, so the catch below would never fire. The action is only
  // ever read from the body — a one-click POST means "stop".
  token = req.nextUrl.searchParams.get("token") ?? "";
  let form: FormData | null = null;
  try {
    form = await req.formData();
  } catch {
    form = null;
  }
  if (!token) token = String(form?.get("token") ?? "");
  action = asAction(form?.get("action"));
  await apply(token, action);
  return NextResponse.redirect(new URL(`/?unsub=${action === "unmute" ? "on" : "done"}`, req.nextUrl.origin));
}
