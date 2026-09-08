import { NextRequest, NextResponse } from "next/server";
import { PaymentProvider } from "@prisma/client";
import { settlePayment } from "@/lib/settle";
import { getProviderMode } from "@/lib/whop";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Dev-only payment simulator (Phase 2: same settle service as production).
 * Disabled whenever Whop is fully configured, and refuses non-DEV payments,
 * so it can never grant stakes for free in production.
 */
export async function POST(req: NextRequest) {
  if (getProviderMode() !== "dev") {
    return NextResponse.json({ error: "Disabled when Whop is enabled." }, { status: 403 });
  }
  const { paymentId, outcome } = (await req.json()) as { paymentId?: string; outcome?: string };
  if (!paymentId) return NextResponse.json({ error: "paymentId required" }, { status: 400 });

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  if (payment.provider !== PaymentProvider.DEV) {
    return NextResponse.json({ error: "Simulator handles dev payments only." }, { status: 403 });
  }
  if (payment.status !== "PENDING") {
    // Terminal state: report it, change nothing (P2-03 — no false "confirmed").
    return NextResponse.json({ ok: true, status: payment.status.toLowerCase(), terminal: true });
  }

  try {
    const result = await settlePayment(paymentId, {
      provider: "dev",
      eventId: `dev-${paymentId}-${outcome === "fail" ? "fail" : "pay"}`,
      eventType: outcome === "fail" ? "dev.simulated-failure" : "dev.simulated-payment",
      paid: outcome !== "fail",
    });
    if (result.outcome === "failed") {
      return NextResponse.json({ ok: true, status: "failed", terminal: true });
    }
    if (result.outcome === "applied") {
      return NextResponse.json({ ok: true, status: "paid", terminal: true, elementSymbol: result.elementSymbol });
    }
    if (result.outcome === "rejected") {
      return NextResponse.json({ ok: false, status: "rejected", terminal: true, error: result.reason });
    }
    const fresh = await prisma.payment.findUnique({ where: { id: paymentId } });
    return NextResponse.json({ ok: true, status: fresh?.status.toLowerCase() ?? "unknown", terminal: true });
  } catch {
    return NextResponse.json({ ok: false, error: "settle-retryable" }, { status: 500 });
  }
}
