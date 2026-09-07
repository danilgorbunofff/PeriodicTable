import { NextRequest, NextResponse } from "next/server";
import { markPaidAndApply, markFailed } from "@/lib/applyPayment";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Dev-only payment simulator. Disabled whenever WHOP_API_KEY is set so it can
 * never be used to grant stakes for free in production.
 */
export async function POST(req: NextRequest) {
  if (process.env.WHOP_API_KEY) {
    return NextResponse.json({ error: "Disabled when Whop is enabled." }, { status: 403 });
  }
  const { paymentId, outcome } = (await req.json()) as { paymentId?: string; outcome?: string };
  if (!paymentId) return NextResponse.json({ error: "paymentId required" }, { status: 400 });

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  if (payment.status !== "pending") {
    return NextResponse.json({ ok: true, status: payment.status });
  }

  if (outcome === "fail") {
    await markFailed(paymentId);
    return NextResponse.json({ ok: true, status: "failed" });
  }
  await markPaidAndApply(paymentId);
  const fresh = await prisma.payment.findUnique({ where: { id: paymentId } });
  return NextResponse.json({ ok: true, status: fresh?.status ?? "paid" });
}
