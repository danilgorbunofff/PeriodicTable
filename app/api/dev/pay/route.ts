import { NextRequest, NextResponse } from "next/server";
import { PaymentProvider } from "@prisma/client";
import { settlePayment } from "@/lib/settle";
import { devSimulatorEnabled } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { rateLimitAsync } from "@/lib/rateStore";
import { clientIp } from "@/lib/ip";
import { apiRoute, apiError } from "@/lib/route";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ POST: postDevPay });

/**
 * Dev-only payment simulator (Phase 2: same settle service as production).
 *
 * This route invents a paid `Payment`, so it is the most dangerous endpoint in
 * the app and its gate is the deployment, not the provider mode: the mode is
 * derived from credential presence alone, so a production box whose
 * STRIPE_WEBHOOK_SECRET was missing read as 'dev' and this route granted stakes
 * for free to anyone holding a paymentId (R07-1). A paymentId is not a secret —
 * it is in the /pay/<id> URL — so that gate was the only thing in the way.
 *
 * Gates, in order, cheapest and least dependent first:
 *   1. devSimulatorEnabled() — false in production and false whenever Stripe
 *      credentials are configured, so production can never mint a stake here.
 *      Checked before the body is parsed and before the database is touched,
 *      so a refused request costs nothing and reveals nothing.
 *   2. the per-IP budget (R11-4) — the simulator settles a payment per call and
 *      had no limiter at all, in the one mode where the provider gate is also
 *      the fallback (see the paragraph above).
 *   3. paymentId is required.
 *   4. the row's provider must be DEV — a legacy WHOP row that predates the
 *      Stripe migration cannot be settled through a simulator (R07-6).
 */
async function postDevPay(req: NextRequest) {
  if (!devSimulatorEnabled()) {
    return NextResponse.json({ error: "Simulator disabled on this deployment." }, { status: 403 });
  }
  // Budget per IP, per hour. Deliberately looser than checkout's 5/hour (R11-4
  // proposed "the same limiter"): this route exists to be called repeatedly
  // while a developer rehearses a flow, and a 5/hour cap would break the tool
  // it protects on the first morning of testing. The finding is that no bound
  // existed — a script could settle payments as fast as it could write, which
  // `15` showed flattening one element.
  const ip = clientIp(req.headers);
  if (!(await rateLimitAsync(`devpay:${ip}`, 30, 3_600_000))) {
    return apiError("Too many requests. Try again later.", { status: 429, code: "RATE_LIMITED" });
  }
  let body: { paymentId?: string; outcome?: string };
  try {
    // Unparsable JSON is a request-shape error, not a server fault: this was an
    // uncaught `req.json()`, so an empty body answered 500 (R11-3's matrix).
    body = (await req.json()) as { paymentId?: string; outcome?: string };
  } catch {
    return apiError("Invalid JSON body.", { status: 400, code: "BAD_JSON" });
  }
  const { paymentId, outcome } = body;
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
