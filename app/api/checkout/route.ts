import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { validateTopUp, joinMin } from "@/lib/pricing";
import { validateCheckoutInput } from "@/lib/validate";
import { createWhopCheckoutSession, whopEnabled } from "@/lib/whop";
import { rateLimit } from "@/lib/rateLimit";
import { verifyTurnstile, honeypotCaught, attestValid } from "@/lib/abuse";
import { paymentsLiveServer } from "@/lib/flags";

export const dynamic = "force-dynamic";

type Body = {
  elementSym: string;
  startup?: { domain?: string; title?: string; pitch?: string; url?: string; linkType?: string };
  amountUsd: number;
  path?: "take" | "join";
  email?: string;
  idempotencyKey: string;
  honeypot?: string;
  attest?: boolean | string;
  turnstileToken?: string;
};

export async function POST(req: NextRequest) {
  if (!paymentsLiveServer()) {
    return NextResponse.json({ error: "Payments are paused — join the waitlist.", waitlist: true }, { status: 403 });
  }
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "0.0.0.0";
  // Abuse: 5 checkout attempts / IP / hour (spec 03). 429, never 500.
  if (!rateLimit(`checkout:${ip}`, 5, 3_600_000)) {
    return NextResponse.json({ error: "Too many checkout attempts. Try again later." }, { status: 429 });
  }
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (honeypotCaught(body.honeypot)) {
    return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 400 });
  }
  if (!attestValid(body.attest)) {
    return NextResponse.json({ error: "Please confirm you own or may promote this URL.", field: "attest" }, { status: 400 });
  }
  if (!(await verifyTurnstile(body.turnstileToken, ip))) {
    return NextResponse.json({ error: "Bot check failed. Try again." }, { status: 400 });
  }

  const { elementSym, amountUsd, idempotencyKey } = body;
  if (!elementSym || typeof elementSym !== "string") {
    return NextResponse.json({ error: "elementSym is required." }, { status: 400 });
  }
  if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
    return NextResponse.json({ error: "idempotencyKey is required." }, { status: 400 });
  }
  if (!Number.isInteger(amountUsd) || amountUsd < 1) {
    return NextResponse.json({ error: "Whole dollars only." }, { status: 400 });
  }
  const email = typeof body.email === "string" && body.email.includes("@") ? body.email.trim() : null;

  const element = await prisma.element.findUnique({ where: { symbol: elementSym } });
  if (!element) return NextResponse.json({ error: "Element not found." }, { status: 404 });

  // Re-validate pricing against the LIVE leaderboard (client quote can be stale).
  const stakes = await prisma.stake.findMany({
    where: { elementId: element.id },
    orderBy: { amountUsd: "desc" },
    select: { amountUsd: true, startupId: true },
  });
  const leaderTotal = stakes[0]?.amountUsd as number | undefined;

  const input = validateCheckoutInput({
    url: body.startup?.url,
    linkType: body.startup?.linkType,
    title: body.startup?.title,
    pitch: body.startup?.pitch,
  });
  if (!input.ok) return NextResponse.json({ error: input.error, field: input.field }, { status: 400 });

  // Identity: prefer explicit domain, else derive from URL; a startup is "new"
  // on this element when it has no stake there yet.
  const domain = (body.startup?.domain ?? input.domain).toLowerCase();
  const existing = await prisma.startup.findUnique({ where: { domain } });
  const myStake = stakes.find((s) => s.startupId === existing?.id);
  const isNewHere = !myStake;

  const vErr = validateTopUp(amountUsd, leaderTotal, isNewHere);
  if (vErr) {
    // 409 = price moved / minimum not met. Include live takeLead so the modal
    // can show "Price moved to $X — continue?" instead of charging stale.
    return NextResponse.json(
      { error: vErr, takeLead: leaderTotal != null ? leaderTotal + 1 : joinMin() },
      { status: 409 }
    );
  }
  if (isNewHere && amountUsd < joinMin()) {
    return NextResponse.json({ error: `First stake on ${element.symbol} is $${joinMin()}+.` }, { status: 409 });
  }

  // Upsert startup identity
  const startup = await prisma.startup.upsert({
    where: { domain },
    create: {
      domain,
      title: (body.startup?.title ?? input.title ?? domain).slice(0, 32),
      pitch: (body.startup?.pitch ?? input.pitch ?? "").slice(0, 140),
      url: input.url,
      linkType: input.linkType,
      logoUrl: `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
      ...(email ? { email } : {}),
    },
    update: {
      ...(email ? { email } : {}),
      url: input.url,
      linkType: input.linkType,
    },
  });

  const path: "take" | "join" | "stake" =
    isNewHere && leaderTotal != null && amountUsd > leaderTotal ? "take" : isNewHere ? "join" : "stake";

  // Idempotency: same key returns the original payment without creating a duplicate.
  const byKey = await prisma.payment.findUnique({ where: { idempotencyKey } });
  if (byKey) {
    return NextResponse.json({
      paymentId: byKey.id,
      status: byKey.status,
      ...(byKey.status === "pending" ? { checkoutUrl: `/pay/${byKey.id}` } : {}),
    });
  }

  const payment = await prisma.payment.create({
    data: {
      stakeId: "pending",
      elementId: element.id,
      startupId: startup.id,
      amountUsd,
      path,
      provider: whopEnabled() ? "whop" : "dev",
      idempotencyKey,
      ...(email ? { email } : {}),
    },
  });

  if (whopEnabled()) {
    const session = await createWhopCheckoutSession({
      paymentId: payment.id,
      amountUsd,
      title: startup.title,
      elementSymbol: element.symbol,
      email,
      redirectAfterPaid: `${req.nextUrl.origin}/?paid=${element.symbol}`,
    });
    if (session) {
      await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: session.providerRef } });
      return NextResponse.json({ paymentId: payment.id, checkoutUrl: session.checkoutUrl, provider: "whop" });
    }
    // Whop API failed — keep the pending payment; client shows a retryable error.
    return NextResponse.json({ error: "Payment provider unavailable. Try again." }, { status: 502 });
  }

  // Dev simulator path (no Whop keys): /pay/[paymentId] applies on "pay".
  return NextResponse.json({ paymentId: payment.id, checkoutUrl: `/pay/${payment.id}`, provider: "dev" });
}
