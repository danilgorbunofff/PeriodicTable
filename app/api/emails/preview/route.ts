import { NextRequest, NextResponse } from "next/server";
import { ELEMENTS } from "@/lib/elements";
import { getAppEnv } from "@/lib/env";
import { esc } from "@/emails/escape";
import { outbidHtml, outbidSubject } from "@/emails/outbid";
import { receiptHtml, receiptSubject } from "@/emails/receipt";
import { refundHtml, refundSubject } from "@/emails/refund";
import { reportHtml, reportSubject } from "@/emails/report";
import { waitlistHtml, waitlistSubject } from "@/emails/waitlist";

export const dynamic = "force-dynamic";

/**
 * Dev-only email preview (spec 02), reworked in R10-8/R10-9.
 *
 * Four things were wrong with it:
 * - It returned the subject in an `X-Subject-Preview` header, and the default
 *   template's subject contains `👑`, which cannot be encoded into a header: the
 *   route answered `500` for its own default while `?template=receipt` (whose
 *   subject the route never put in a header) answered `200`. The subject is now
 *   rendered above the message — where the operator is looking anyway — so there
 *   is nothing to encode.
 * - The gate was `NODE_ENV === "production"`, which is not the same question as
 *   "is this deployment production". A production-flagged `next dev` reports
 *   `NODE_ENV=production`, so the preview was unreachable exactly where it was
 *   wanted; conversely it was reachable on a preview deployment, which is not the
 *   operator's laptop. It now uses the app-env predicate the other preview
 *   surfaces use.
 * - It reflected `sym` straight into the template, so a "preview" could render a
 *   symbol that does not exist and a real template bug (missing name, broken tile
 *   lookup) would look like intended output. `sym` is resolved against the
 *   canonical table, and an unmatched value is named in the banner instead of
 *   being rendered.
 * - It previewed two of the five templates. All of them are reachable now, since
 *   the route is also how a template change is checked.
 */
export async function GET(req: NextRequest) {
  if (getAppEnv() === "production") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const template = req.nextUrl.searchParams.get("template") ?? "outbid";
  const raw = (req.nextUrl.searchParams.get("sym") ?? "C").trim();
  const element =
    ELEMENTS.find((e) => e.symbol.toLowerCase() === raw.toLowerCase()) ?? ELEMENTS.find((e) => e.symbol === "C")!;
  const sym = element.symbol;
  const note = sym.toLowerCase() === raw.toLowerCase() ? "" : ` · sym=${raw} is not an element, showing ${sym}`;
  const unsubUrl = "http://localhost:3000/api/unsubscribe?token=preview";

  let subject: string;
  let html: string;
  switch (template) {
    case "receipt":
      subject = receiptSubject({ elementSymbol: sym, elementName: element.name, rank: 1 });
      html = receiptHtml({
        elementSymbol: sym,
        elementName: element.name,
        amountUsd: 21,
        rank: 1,
        topUpUsd: 5,
        domain: "b.com",
        viewUrl: "http://localhost:3000/s/b.com",
        unsubUrl,
      });
      break;
    case "refund":
      subject = refundSubject({ elementSymbol: sym, amountUsd: 21 });
      html = refundHtml({
        elementSymbol: sym,
        elementName: element.name,
        amountUsd: 21,
        domain: "b.com",
        providerRef: "cs_test_preview",
        unsubUrl,
      });
      break;
    case "report":
      subject = reportSubject({ domain: "b.com" });
      html = reportHtml({
        id: "rep_preview",
        domain: "b.com",
        stakeId: "stk_preview",
        reason: "<b>bold</b> report reason, as submitted",
        createdAt: "2024-01-01 00:00 UTC",
        queueUrl: "http://localhost:3000/api/admin/reports",
      });
      break;
    case "waitlist":
      subject = waitlistSubject();
      html = waitlistHtml({ domain: "b.com", tableUrl: "http://localhost:3000", unsubUrl });
      break;
    default:
      subject = outbidSubject({ elementSymbol: sym });
      html = outbidHtml({
        elementSymbol: sym,
        winnerDomain: "b.com",
        winnerAmount: 21,
        reclaim: 2,
        reentryFloor: 3,
        reclaimUrl: `http://localhost:3000/?el=${sym}&stake=2`,
        unsubUrl,
      });
  }

  return new NextResponse(
    `<div style="background:#111;color:#fff;font:13px/1.5 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;padding:8px 12px;">
template=${esc(template)} · subject: <strong>${esc(subject)}</strong>${esc(note)}
</div>${html}`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
