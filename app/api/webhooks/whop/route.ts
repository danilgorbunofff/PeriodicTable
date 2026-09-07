import { NextRequest, NextResponse } from "next/server";
import { verifyWhopSignature, paymentIdFromWhopPayload, whopPayloadIsPaid } from "@/lib/whop";
import { markPaidAndApply, markFailed } from "@/lib/applyPayment";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sig = req.headers.get("x-whop-signature") === null ? "" : req.headers.get("x-whop-signature");
  const raw = await req.text();

  if (!verifyWhopSignature(raw, typeof sig === "string" ? sig : "")) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const paymentId = paymentIdFromWhopPayload(payload);
  if (!paymentId) return NextResponse.json({ ok: true, note: "no paymentId in payload" });

  if (whopPayloadIsPaid(payload)) {
    await markPaidAndApply(paymentId);
    // Always 200 on dupes — Whop retries non-2xx forever.
    return NextResponse.json({ ok: true });
  }

  const p = payload as { status?: string; event?: string };
  if (p.status === "failed" || p.event === "payment.failed") {
    await markFailed(paymentId);
  }
  return NextResponse.json({ ok: true });
}
