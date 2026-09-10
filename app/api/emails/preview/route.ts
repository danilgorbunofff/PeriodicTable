import { NextRequest, NextResponse } from "next/server";
import { outbidHtml, outbidSubject } from "@/emails/outbid";
import { receiptHtml } from "@/emails/receipt";

export const dynamic = "force-dynamic";

/** Dev-only email preview (spec 02). Disabled in production. */
export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const template = req.nextUrl.searchParams.get("template") ?? "outbid";
  const sym = req.nextUrl.searchParams.get("sym") ?? "C";
  if (template === "receipt") {
    const html = receiptHtml({
      elementSymbol: sym,
      elementName: "Carbon",
      amountUsd: 21,
      rank: 1,
      domain: "b.com",
      viewUrl: "http://localhost:3000/s/b.com",
      unsubUrl: "http://localhost:3000/api/unsubscribe?token=preview",
    });
    return new NextResponse(html, { headers: { "Content-Type": "text/html" } });
  }
  const subject = outbidSubject({ elementSymbol: sym });
  const html = outbidHtml({
    elementSymbol: sym,
    winnerDomain: "b.com",
    winnerAmount: 21,
    reclaim: 2,
    reclaimUrl: `http://localhost:3000/?el=${sym}&stake=2`,
    unsubUrl: "http://localhost:3000/api/unsubscribe?token=preview",
  });
  return new NextResponse(html, {
    headers: { "Content-Type": "text/html", "X-Subject-Preview": subject },
  });
}
