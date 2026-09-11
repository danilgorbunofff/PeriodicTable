import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * One-click unsubscribe (Phase 6, P1-18 + RFC 8058).
 *
 * - GET renders a confirm form (humans click, link scanners must not
 *   unsubscribe anyone by prefetching). It never mutates state.
 * - POST processes idempotently: unknown tokens succeed silently (no oracle),
 *   clearing an already-empty email is a no-op success.
 * - Mail clients that support one-click POST directly (see List-Unsubscribe
 *   headers in lib/email.ts).
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  return new NextResponse(
    `<!doctype html><html><body style="margin:0;background:#f4f4f0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
<div style="max-width:440px;margin:60px auto;padding:28px;background:#fff;border-radius:20px;border:1px solid #eee;text-align:center;">
<h1 style="font-size:20px;margin:0 0 8px;">Unsubscribe?</h1>
<p style="font-size:14px;color:#555;">Stop outbid and receipt emails for this listing. Your stakes stay live.</p>
<form method="POST" action="/api/unsubscribe">
<input type="hidden" name="token" value="${token.replace(/"/g, "")}" />
<button type="submit" style="margin-top:12px;background:#111;color:#fff;font-weight:800;padding:12px 28px;border-radius:999px;border:none;font-size:15px;cursor:pointer;">Unsubscribe me</button>
</form></div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

async function clearEmail(token: string): Promise<"done" | "unknown"> {
  if (!token) return "unknown";
  const startup = await prisma.startup.findUnique({ where: { unsubToken: token } });
  if (!startup) return "unknown"; // idempotent: no oracle, same outcome shape
  if (startup.email) {
    await prisma.startup.update({ where: { id: startup.id }, data: { email: null } });
  }
  return "done";
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  let token = "";
  if (contentType.includes("application/json")) {
    try {
      token = ((await req.json()) as { token?: string }).token ?? "";
    } catch {
      token = "";
    }
    await clearEmail(token);
    return NextResponse.json({ ok: true });
  }
  // RFC 8058 one-click clients POST the token in the URL with a
  // `List-Unsubscribe=One-Click` body, so the query string wins here; the
  // confirm page posts the token in the body instead. Reading the body first
  // would silently drop every one-click request: the one-click body parses as
  // valid form data, so the catch below would never fire.
  token = req.nextUrl.searchParams.get("token") ?? "";
  if (!token) {
    try {
      token = String((await req.formData()).get("token") ?? "");
    } catch {
      token = "";
    }
  }
  await clearEmail(token);
  return NextResponse.redirect(new URL("/?unsub=done", req.nextUrl.origin));
}
