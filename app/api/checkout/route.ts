import { NextRequest, NextResponse } from "next/server";
import { PaymentPath, PaymentProvider, PaymentStatus, ReservationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { classifyAndValidate, joinMin } from "@/lib/pricing";
import { validateCheckoutInput } from "@/lib/validate";
import { createWhopCheckoutSession, getProviderMode, whopPartiallyConfigured } from "@/lib/whop";
import { rateLimitAsync } from "@/lib/rateStore";
import { clientIp } from "@/lib/ip";
import { verifyTurnstile, honeypotCaught, attestValid } from "@/lib/abuse";
import { paymentsLiveServer } from "@/lib/flags";
import { findOrCreateCheckoutStartup, fingerprintCheckout } from "@/lib/startups";
import { getActiveReservation, releaseExpiredReservations, reservationConflict, RESERVATION_TTL_MS } from "@/lib/reservations";
import { withTxnRetry } from "@/lib/txn";
import { audit } from "@/lib/audit";

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

/** Resume (or create) the provider session for a pending payment (P1-04).
 * Returns a usable checkout URL, or null when the provider is down
 * (caller returns retryable 502 — never a dead dev URL for Whop payments). */
async function resumeCheckoutUrl(
  payment: {
    id: string;
    amountUsd: number;
    provider: PaymentProvider;
    providerCheckoutUrl: string | null;
    elementId: number;
    startupId: string;
    email: string | null;
  },
  origin: string
): Promise<string | null> {
  if (payment.providerCheckoutUrl) return payment.providerCheckoutUrl;
  if (getProviderMode() === "dev") {
    const url = `/pay/${payment.id}`;
    await prisma.payment.update({ where: { id: payment.id }, data: { providerCheckoutUrl: url } });
    return url;
  }
  const element = await prisma.element.findUniqueOrThrow({ where: { id: payment.elementId } });
  const startup = await prisma.startup.findUniqueOrThrow({ where: { id: payment.startupId } });
  const session = await createWhopCheckoutSession({
    paymentId: payment.id,
    amountUsd: payment.amountUsd,
    title: startup.title,
    elementSymbol: element.symbol,
    email: payment.email,
    redirectAfterPaid: `${origin}/?paid=${element.symbol}`,
  });
  if (!session) return null;
  await prisma.payment.update({
    where: { id: payment.id },
    data: { providerRef: session.providerRef, providerCheckoutUrl: session.checkoutUrl },
  });
  return session.checkoutUrl;
}

/** Shared idempotent-replay branch (P1-03): used on lookup hits AND on
 * unique-race recovery when a concurrent insert won. */
async function idempotentReplay(
  byKey: {
    id: string;
    amountUsd: number;
    provider: PaymentProvider;
    providerCheckoutUrl: string | null;
    elementId: number;
    startupId: string;
    email: string | null;
    status: PaymentStatus;
    requestFingerprint: string | null;
  },
  fingerprint: string,
  origin: string
) {
  if (byKey.requestFingerprint && byKey.requestFingerprint !== fingerprint) {
    return NextResponse.json(
      { error: "This idempotency key was already used for a different checkout.", code: "IDEMPOTENCY_CONFLICT" },
      { status: 409 }
    );
  }
  if (byKey.status === PaymentStatus.PENDING) {
    const checkoutUrl = await resumeCheckoutUrl(byKey, origin);
    if (!checkoutUrl) {
      return NextResponse.json({ error: "Payment provider unavailable. Try again." }, { status: 502 });
    }
    return NextResponse.json({ paymentId: byKey.id, status: "pending", checkoutUrl });
  }
  return NextResponse.json({ paymentId: byKey.id, status: byKey.status.toLowerCase() });
}

export async function POST(req: NextRequest) {  if (!paymentsLiveServer()) {
    return NextResponse.json({ error: "Payments are paused — join the waitlist.", waitlist: true }, { status: 403 });
  }
  if (whopPartiallyConfigured()) {
    console.warn("checkout: partial Whop configuration (key without secret or vice versa) — running in dev provider mode");
  }
  const ip = clientIp(req.headers);
  // Abuse: 5 checkout attempts / IP / hour (spec 03). 429, never 500.
  if (!(await rateLimitAsync(`checkout:${ip}`, 5, 3_600_000))) {
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

  const input = validateCheckoutInput({
    url: body.startup?.url,
    linkType: body.startup?.linkType,
    title: body.startup?.title,
    pitch: body.startup?.pitch,
  });
  if (!input.ok) return NextResponse.json({ error: input.error, field: input.field }, { status: 400 });

  // Identity (Phase 1): canonical domain comes ONLY from the validated
  // URL/handle. A caller-provided startup.domain is ignored.
  const domain = input.domain.toLowerCase();
  const fingerprint = fingerprintCheckout({ elementSym, domain, amountUsd, email });

  // Idempotency FIRST (P1-03): resolve the key before any mutable operation.
  // Matching retries return the stored payment (+ resumable URL); key reuse
  // with a different payload is rejected.
  const byKey = await prisma.payment.findUnique({ where: { idempotencyKey } });
  if (byKey) {
    return await idempotentReplay(byKey, fingerprint, req.nextUrl.origin);
  }

  const element = await prisma.element.findUnique({ where: { symbol: elementSym } });
  if (!element) return NextResponse.json({ error: "Element not found." }, { status: 404 });

  const existing = await prisma.startup.findUnique({ where: { domain } });

  // Locked quote (P0-05): re-read the leaderboard under a per-element
  // advisory lock, re-validate the price, check reservations, and create the
  // payment (+ reservation) atomically. Retries outside the lock may be stale.
  //
  // Unique-race recovery (P1-03): two concurrent checkouts can both miss the
  // idempotency lookup or both see a free element. The loser gets P2002; the
  // aborted tx is discarded and the winner's row is replayed — never a 500.
  let quoted;
  try {
    quoted = await withTxnRetry(() =>
      prisma.$transaction(
        async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${element.id})`;
    await releaseExpiredReservations(tx);

    const stakes = await tx.stake.findMany({
      where: { elementId: element.id },
      orderBy: [{ amountUsd: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { amountUsd: true, startupId: true, startup: { select: { moderationState: true } } },
    });
    // Price off the leader the buyer was actually shown. Identity-bearing
    // surfaces exclude HIDDEN listings (lib/moderation.ts), and the displayed
    // take-lead price is derived from that filtered list
    // (app/api/elements/[sym]/route.ts) — so pricing off the unfiltered top
    // stake could demand more than the page advertised, or classify the
    // advertised amount as a mere join. Hidden money still counts in
    // pool/count (deliberate policy); it just no longer sets the price.
    const leader = stakes.find((s) => s.startup.moderationState !== "HIDDEN");
    const leaderTotal = leader?.amountUsd as number | undefined;
    const leaderStartupId = leader?.startupId as string | undefined;
    const myStake = existing ? stakes.find((s) => s.startupId === existing.id) : undefined;
    const isNewHere = !myStake;
    const myPriorTotal = myStake ? (myStake.amountUsd as number) : 0;
    // Deliberately unfiltered: this is the no-tie guard, and a collision with a
    // hidden row is still a collision in the ledger ranking.
    const existingTotals = stakes.map((s) => s.amountUsd as number);

    // Phase 3: single classify+validate source (pre-check ran unlocked; this
    // re-runs authoritatively under the lock).
    const classified = classifyAndValidate({ amount: amountUsd, leaderTotal, isNewHere, myPriorTotal, existingTotals });
    if (!classified.ok) {
      return {
        ok: false as const,
        status: 409,
        body: {
          error: classified.error,
          code: classified.code,
          takeLead: leaderTotal != null ? leaderTotal + 1 : joinMin(),
        },
      };
    }
    const path: PaymentPath =
      classified.path === "TAKE"
        ? PaymentPath.TAKE
        : classified.path === "JOIN"
          ? PaymentPath.JOIN
          : classified.path === "RECLAIM"
            ? PaymentPath.RECLAIM
            : PaymentPath.STAKE;

    // Reservation conflict (one ACTIVE take quote per element).
    const active = await getActiveReservation(tx, element.id);
    const conflict = reservationConflict({
      reservation: active,
      myStartupId: existing?.id ?? null,
      myPriorTotal,
      addUsd: amountUsd,
    });
    if (conflict.conflict) {
      return {
        ok: false as const,
        status: 409,
        body: {
          error: `This element has a held take quote at $${conflict.reservedTotal}. Refresh for a new quote.`,
          code: "RESERVATION_CONFLICT",
          reservedTotal: conflict.reservedTotal,
          expiresAt: conflict.expiresAt.toISOString(),
        },
      };
    }

    // Ownership (Phase 1): existing profiles are IMMUTABLE here.
    const { startup } = await findOrCreateCheckoutStartup(
      {
        domain,
        title: input.title,
        pitch: input.pitch,
        url: input.url,
        linkType: input.linkType,
        email,
      },
      tx
    );

    const payment = await tx.payment.create({
      data: {
        elementId: element.id,
        startupId: startup.id,
        amountUsd,
        path,
        provider: getProviderMode() === "whop" ? PaymentProvider.WHOP : PaymentProvider.DEV,
        idempotencyKey,
        requestFingerprint: fingerprint,
        ...(email ? { email } : {}),
      },
    });

    // Contested takes hold a short-lived guaranteed quote (P0-05). Empty-tile
    // first claims need no reservation — concurrent $5 joins must succeed.
    // NOTE: no P2002 catch here — a unique violation inside an interactive
    // transaction poisons the whole tx. The residual insert race is handled
    // by the outer P2002 recovery below (abort + 409).
    let reservation: { reservedTotal: number; expiresAt: string } | null = null;
    if (path === PaymentPath.TAKE && leaderTotal != null) {
      const reservedTotal = leaderTotal + 1;
      const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
      await tx.claimReservation.create({
        data: {
          elementId: element.id,
          startupId: startup.id,
          paymentId: payment.id,
          quotedLeaderTotal: leaderTotal,
          quotedLeaderStartupId: leaderStartupId ?? null,
          reservedTotal,
          status: ReservationStatus.ACTIVE,
          expiresAt,
        },
      });
      reservation = { reservedTotal, expiresAt: expiresAt.toISOString() };
    }

    return { ok: true as const, payment, startupTitle: startup.title, reservation };
        },
        { isolationLevel: "Serializable" }
      )
    );
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      // Lost a unique race (duplicate key or duplicate ACTIVE quote): replay
      // the winner instead of 500ing (P1-03).
      const winner = await prisma.payment.findUnique({ where: { idempotencyKey } });
      if (winner) return await idempotentReplay(winner, fingerprint, req.nextUrl.origin);
      const current = await getActiveReservation(prisma, element.id);
      return NextResponse.json(
        {
          error: "This element just received a held take quote. Refresh for a new quote.",
          code: "RESERVATION_CONFLICT",
          ...(current ? { reservedTotal: current.reservedTotal, expiresAt: current.expiresAt.toISOString() } : {}),
        },
        { status: 409 }
      );
    }
    throw e;
  }

  if (!quoted.ok) return NextResponse.json(quoted.body, { status: quoted.status });

  await audit({
    action: "CHECKOUT_STARTED",
    startupId: quoted.payment.startupId,
    elementId: element.id,
    paymentId: quoted.payment.id,
    detail: `${quoted.payment.path} $${amountUsd}`,
  });

  const checkoutUrl = await resumeCheckoutUrl(quoted.payment, req.nextUrl.origin);
  if (!checkoutUrl) {
    // Provider session creation failed — the pending payment stays retryable
    // via the same idempotency key; no dead URL is handed out (P1-04).
    return NextResponse.json({ error: "Payment provider unavailable. Try again." }, { status: 502 });
  }
  return NextResponse.json({
    paymentId: quoted.payment.id,
    checkoutUrl,
    provider: getProviderMode(),
    ...(quoted.reservation
      ? { reservation: { ...quoted.reservation, guaranteedTake: true } }
      : {}),
  });
}
