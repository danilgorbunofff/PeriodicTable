import { NextRequest, NextResponse } from "next/server";
import { PaymentPath, PaymentProvider, PaymentStatus, ReservationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { classifyAndValidate, joinMin, validateTake } from "@/lib/pricing";
import { isEmail, validateCheckoutInput } from "@/lib/validate";
import { findElementBySymbol } from "@/lib/elements";
import { createStripeCheckoutSession, getProviderMode, stripePartiallyConfigured } from "@/lib/stripe";
import { rateLimitAsync } from "@/lib/rateStore";
import { clientIp } from "@/lib/ip";
import { verifyTurnstile, honeypotCaught, attestValid } from "@/lib/abuse";
import { consentRecord, attestVersionRefusal } from "@/lib/consent";
import { devSimulatorEnabled, paymentsLiveServer } from "@/lib/flags";
import { findOrCreateCheckoutStartup, fingerprintCheckout } from "@/lib/startups";
import {
  getActiveReservation,
  isReservationLive,
  releaseExpiredReservations,
  reservationConflict,
  RESERVATION_TTL_MS,
} from "@/lib/reservations";
import { withTxnRetry, MONEY_TX } from "@/lib/txn";
import { audit } from "@/lib/audit";
import { joinSpace } from "@/lib/stakeQuote";
import { apiRoute } from "@/lib/route";
import { checkMoneyPath } from "@/lib/moneyPath";

export const dynamic = "force-dynamic";

// The quote transaction (advisory lock + reservation + payment row) runs against
// Neon from Vercel; the default 5 s Prisma budget can expire mid-flight on a cold
// compute resume. See MONEY_TX.
export const maxDuration = 60;
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ POST: postCheckout });

type Body = {
  elementSym: string;
  startup?: { domain?: string; title?: string; pitch?: string; url?: string; linkType?: string };
  amountUsd: number;
  path?: "take" | "join";
  email?: string;
  idempotencyKey: string;
  honeypot?: string;
  attest?: boolean | string;
  /** The rules revision the modal displayed next to the checkbox (R16-7). */
  consentVersion?: string;
  turnstileToken?: string;
};

/** Resume (or create) the provider session for a pending payment (P1-04).
 * Returns a usable checkout URL, or null when the provider is down
 * (caller returns retryable 502 — never a dead dev URL for live payments). */
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
  // Only a deployment where the simulator is permitted may hand out a /pay/ URL
  // (R07-2): an environment gate, not the provider mode, because mode is derived
  // from credential presence and a preview sharing the production database
  // would otherwise mint and settle real rows.
  if (devSimulatorEnabled()) {
    const url = `/pay/${payment.id}`;
    await prisma.payment.update({ where: { id: payment.id }, data: { providerCheckoutUrl: url } });
    return url;
  }
  const element = await prisma.element.findUniqueOrThrow({ where: { id: payment.elementId } });
  const startup = await prisma.startup.findUniqueOrThrow({ where: { id: payment.startupId } });
  const session = await createStripeCheckoutSession({
    paymentId: payment.id,
    amountUsd: payment.amountUsd,
    title: startup.title,
    elementSymbol: element.symbol,
    email: payment.email,
    redirectAfterPaid: `${origin}/?paid=${element.symbol}`,
    cancelUrl: `${origin}/?canceled=${element.symbol}`,
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
  if (byKey.status !== PaymentStatus.PENDING) {
    // Settled, refunded or abandoned: there is no session left to open, and
    // saying so is the only useful answer — the modal renders `error`.
    const state = byKey.status.toLowerCase();
    return NextResponse.json({
      paymentId: byKey.id,
      status: state,
      error: `This checkout is already ${state} — nothing was charged again.`,
    });
  }
  // Same envelope as the create path (R06-9): one payment must not answer with
  // two different bodies depending on who won the insert race, so the loser
  // reads back the reservation it was racing for.
  const checkoutUrl = await resumeCheckoutUrl(byKey, origin);
  if (!checkoutUrl) {
    // The row survives a provider failure, so a retry has something to reach
    // (R06-7): the same key replays this branch instead of forking a new row.
    return NextResponse.json(
      { error: "Payment provider unavailable. Try again.", code: "PROVIDER_UNAVAILABLE", paymentId: byKey.id },
      { status: 502 }
    );
  }
  const held = await prisma.claimReservation.findUnique({ where: { paymentId: byKey.id } });
  return NextResponse.json({
    paymentId: byKey.id,
    checkoutUrl,
    provider: getProviderMode(),
    ...(held && held.status === ReservationStatus.ACTIVE && isReservationLive(held)
      ? {
          reservation: {
            reservedTotal: held.reservedTotal,
            expiresAt: held.expiresAt.toISOString(),
            guaranteedTake: true,
          },
        }
      : {}),
  });
}

// Set once a half-configured Stripe pair has been reported (R07-5). Module scope
// rather than per request: the environment cannot change while this instance
// lives, so a second line would only repeat the first.
let partialConfigLogged = false;
// Same once-per-process shape for the R14-1(b) refusal: the verdict cannot change
// while the instance lives, and a per-request line is what the log becomes when
// someone points a load test at a shop that is up but unserviceable.
let prodConfigRefusedLogged = false;

async function postCheckout(req: NextRequest) {
  // R07-5: this warning used to sit *below* the paused guard, so the environment
  // that most needed it — production with a half-set Stripe pair, where payments
  // are paused — never reached it. It is logged before the guard now, because a
  // partial pair is a misconfiguration wherever it happens: in production it is
  // the reason buyers get a waitlist, locally it is why checkout fell back to
  // the simulator. Once per process, not once per request: the state cannot
  // change while the function instance lives, and a per-request line is what the
  // log becomes when someone points a load test at a paused shop.
  if (!partialConfigLogged && stripePartiallyConfigured()) {
    partialConfigLogged = true;
    console.error(
      "checkout: partial Stripe configuration (exactly one of STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET is set) — " +
        (paymentsLiveServer()
          ? "falling back to the dev simulator (permitted outside production only)"
          : "payments are paused, and the simulator is unavailable on this deployment")
    );
  }
  // R14-1(b): a shop that intends to charge must be able to service the charge
  // (lib/moneyPath.ts). 503 rather than the paused 403 — the deployment wants
  // money, so a retry is the right answer for the buyer and the log line is the
  // operator's signal.
  const money = checkMoneyPath();
  if (!money.ok) {
    if (!prodConfigRefusedLogged) {
      prodConfigRefusedLogged = true;
      console.error(
        "checkout: PAYMENTS_LIVE is set but the production configuration is incomplete — " +
          `refusing new payments (${money.required.length} required); ` +
          `GET /api/jobs/config lists them for an authenticated caller:\n- ${money.required.join("\n- ")}`
      );
    }
    return NextResponse.json(
      { error: "Checkout is temporarily unavailable. Try again shortly." },
      { status: 503 }
    );
  }
  if (!paymentsLiveServer()) {
    return NextResponse.json({ error: "Payments are paused — join the waitlist.", waitlist: true }, { status: 403 });
  }
  const ip = clientIp(req.headers);
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
  // R16-7: the checkbox's words are versioned. A tab left open across a rules
  // change would otherwise attest to a revision it never showed, and the record
  // would be a lie about what the payer read — so a mismatch is refused with a
  // message that says how to proceed. An absent version (older client, or the
  // acceptance tests that post a bare `attest: true`) is accepted and recorded
  // as the version in force at that moment.
  const staleRules = attestVersionRefusal(body.consentVersion);
  if (staleRules) {
    // `code` makes the refusal self-describing: the modal renders `error` under
    // the button, and a client that wants to distinguish "reload" from "you
    // forgot to tick it" does not have to match on prose.
    return NextResponse.json({ error: staleRules, code: "RULES_UPDATED", field: "attest" }, { status: 409 });
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
  // A receipt address is only useful if mail can reach it: the old gate
  // accepted anything holding an `@` (R06-10), so `a@b` was stored and only
  // bounced when the buyer tried to pay. Empty still means "no receipt".
  const rawEmail = typeof body.email === "string" ? body.email.trim() : "";
  if (rawEmail && !isEmail(rawEmail)) {
    return NextResponse.json({ error: "That email doesn't look right.", field: "email" }, { status: 400 });
  }
  const email = rawEmail || null;

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
  // Canonical casing (R04-4): the client echoes back the symbol the UI showed
  // it, and both casings must price the same element. The canonical form comes
  // from the element inventory — never from uppercasing, which mangles `Hbar`.
  const elementSymbol = findElementBySymbol(elementSym)?.symbol ?? elementSym;
  const fingerprint = fingerprintCheckout({ elementSym: elementSymbol, domain, amountUsd, email });

  // Idempotency FIRST (P1-03): resolve the key before any mutable operation.
  // Matching retries return the stored payment (+ resumable URL); key reuse
  // with a different payload is rejected. The lookup also precedes the rate
  // limiter (R06-2): a replay writes nothing, so it must not spend the buyer's
  // hourly attempt budget — otherwise an interrupted buyer who retries the key
  // of a payment they already own is answered 429 and never reaches their row.
  const byKey = await prisma.payment.findUnique({ where: { idempotencyKey } });
  if (byKey) {
    return await idempotentReplay(byKey, fingerprint, req.nextUrl.origin);
  }

  // Abuse: 5 NEW checkout attempts / IP / hour (spec 03). 429, never 500. The
  // bot gates and the pure shape checks run first, so the throttle sits in
  // front of every row-creating path and behind none that only reads.
  //
  // Phase 14: fails CLOSED on a rate-store outage (R14-2). This is the money
  // path — an outage that silently lifts the only per-source bound on
  // row-creating requests is a worse answer than a retryable 429.
  if (
    !(await rateLimitAsync(`checkout:${ip}`, 5, 3_600_000, {
      onStoreError: "closed",
    }))
  ) {
    return NextResponse.json({ error: "Too many checkout attempts. Try again later." }, { status: 429 });
  }

  const element = await prisma.element.findUnique({ where: { symbol: elementSymbol } });
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
    //
    // Reversed stakes (amountUsd 0) are excluded for the same reason: they are
    // kept as rows for click history, but a row the buyer can never be shown as
    // leading must not price the lead. Without this, a fully refunded element
    // quoted take-#1 at $1 (takeLeadPrice(0)) instead of the $5 floor.
    const leader = stakes.find((s) => s.startup.moderationState !== "HIDDEN" && s.amountUsd > 0);
    const leaderTotal = leader?.amountUsd as number | undefined;
    const leaderStartupId = leader?.startupId as string | undefined;
    // Row existence is not the test for "returning holder" — amount is. A fully
    // reversed stake leaves its row behind for click history, and treating that
    // as a prior holding would let a refunded bidder re-enter below the $5
    // first-join floor (and tie a real $5 stake) via the top-up branch.
    const myStake = existing ? stakes.find((s) => s.startupId === existing.id && s.amountUsd > 0) : undefined;
    const isNewHere = !myStake;
    const myPriorTotal = myStake ? (myStake.amountUsd as number) : 0;
    // Deliberately unfiltered: this is the no-tie guard, and a collision with a
    // hidden row is still a collision in the ledger ranking.
    const existingTotals = stakes.map((s) => s.amountUsd as number);

    // Live take hold (R09-1), read *before* classification. While a rival owns
    // this element's quote nobody else can reach the reserved total, and on a
    // floor-priced tile the tie rule refuses the only amount left below it — so
    // the hold is the fact that decides the bid, and it is named ahead of the
    // rule text that used to answer with "$5 is taken — add $1".
    const active = await getActiveReservation(tx, element.id);
    const conflict = reservationConflict({
      reservation: active,
      myStartupId: existing?.id ?? null,
      myPriorTotal,
      addUsd: amountUsd,
    });

    // Phase 3: single classify+validate source (pre-check ran unlocked; this
    // re-runs authoritatively under the lock).
    const classified = classifyAndValidate({ amount: amountUsd, leaderTotal, isNewHere, myPriorTotal, existingTotals });
    // A malformed amount keeps its shape message — a hold cannot explain it.
    if (conflict.conflict && (classified.ok || classified.code !== "PRICE_MOVED")) {
      // What can this bidder actually do while the hold runs? A newcomer needs
      // the smallest total that still lands under it; when there is none the
      // refusal says the tile is closed instead of hinting at a wrong amount.
      const space = isNewHere ? joinSpace(existingTotals, conflict.reservedTotal) : null;
      return {
        ok: false as const,
        status: 409,
        body: {
          error: `This element has a held take quote at $${conflict.reservedTotal}. Refresh for a new quote.`,
          code: "RESERVATION_CONFLICT",
          reservedTotal: conflict.reservedTotal,
          expiresAt: conflict.expiresAt.toISOString(),
          ...(space?.kind === "room" ? { joinHint: space.amount } : {}),
          ...(space?.kind === "locked" ? { joinBlocked: true as const } : {}),
        },
      };
    }
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
        provider: getProviderMode() === "stripe" ? PaymentProvider.STRIPE : PaymentProvider.DEV,
        idempotencyKey,
        requestFingerprint: fingerprint,
        ...(email ? { email } : {}),
        // R16-6: the evidence the old flow threw away. `consentRecord` takes the
        // clock here rather than defaulting inside the insert, so the recorded
        // moment is the one the gate accepted, not whenever the row flushed.
        ...consentRecord(),
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
      // The hold is the one promise the app makes with real money behind it:
      // settlement refuses a short payment for a reservation
      // (lib/settle.ts, `take-below-reserve`), so the amount must cover the
      // reserved winning total before the row that backs the quote exists.
      // Classification already returns TAKE only at `reservedTotal` or above,
      // which is what keeps this check from changing any outcome (R04-3).
      const takeErr = validateTake(amountUsd, reservedTotal);
      if (takeErr) {
        return { ok: false as const, status: 409, body: { error: takeErr, code: "BELOW_FLOOR", takeLead: reservedTotal } };
      }
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
        MONEY_TX
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
    // via the same idempotency key; no dead URL is handed out (P1-04). The id
    // travels with the error so the buyer's retry reaches its own row instead
    // of forking a second one (R06-7).
    return NextResponse.json(
      { error: "Payment provider unavailable. Try again.", code: "PROVIDER_UNAVAILABLE", paymentId: quoted.payment.id },
      { status: 502 }
    );
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
