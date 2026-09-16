import { NextRequest, NextResponse } from "next/server";
import { jobGate } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";
import { providerAmountAgrees, providerCurrencyAgrees } from "@/lib/money";
import { apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: getReconcileStatus, POST: postReconcile });

/** A rejected delivery younger than this may still be a retry in flight: the
 *  webhook answers 5xx for retryable failures and Stripe redelivers on its own
 *  schedule, superseding the ERROR row when it succeeds. An hour is longer than
 *  any of those retries and short enough that a deterministic rejection (which
 *  can never succeed on redelivery) still reaches a human the same morning. */
const UNAPPLIED_GRACE_MS = 60 * 60_000;

/** How far back `unapplied` looks, and how many rows it will read. A register
 *  with more than this many unresolved ERROR rows inside 90 days has a problem
 *  the report cannot improve by printing more of it. */
const UNAPPLIED_LOOKBACK_MS = 90 * 24 * 60 * 60_000;
const UNAPPLIED_SCAN_LIMIT = 500;

/** Stripe's own checkout sessions expire 24 hours after creation, so a PENDING
 *  row older than this is one whose outcome we will never learn. */
const STALE_PENDING_MS = 24 * 60 * 60_000;

/**
 * Money reconciliation report (Phase 2 follow-up).
 *
 * `Payment.providerAmount` / `providerCurrency` were written and never read,
 * and `validateProviderMoney` answered "fine" both for a verified amount and for a
 * provider that stated none — so an unverified charge was indistinguishable
 * from a cross-checked one. This is the surface that reads them back.
 *
 * Four findings. Two fail `ok`, two are advisory, and the split is what keeps
 * the failing two worth paging on:
 *  - `divergent` (fails `ok`): a PAID payment whose stored provider figure
 *    contradicts the charge — it matches neither dollars nor cents, or it
 *    names a currency that is not USD. Impossible by construction, since the
 *    webhook rejects contradictions before settling, so any hit means the
 *    acceptance rule, or a path that bypassed it, is wrong.
 *  - `unapplied` (fails `ok`, R08-3): a delivery that ended in ERROR and was
 *    never superseded, on a payment that is still PENDING or still PAID. The
 *    register is where a rejected capture waits for a human: the delivery that
 *    could not be applied answers 200 (a redelivery cannot fix a mismatch) or
 *    5xx (retryable), and in both cases the row is the only trace that money
 *    may have moved while the ledger did not. Deliveries younger than
 *    UNAPPLIED_GRACE_MS are excluded so a retry in flight is not a page.
 *  - `unverified` (advisory): a PAID payment carrying no provider figure at
 *    all. Not a defect — providers may omit it — but the money was accepted on
 *    our own checkout figure alone, and this is the only place that is visible.
 *  - `stale` (advisory, R08-3/R08-5): a PENDING payment older than the provider
 *    session's own lifetime. Its outcome will never arrive, so either the
 *    delivery was lost or the checkout never reached the provider. Rows that
 *    never got a session at all are swept by /api/jobs/abandoned-checkouts;
 *    what remains here is a session we opened and never heard about, which is
 *    operator work and not a page (a lost delivery is upstream's to explain).
 *
 * The comparison runs in TypeScript through the same predicates the live
 * webhook uses, never re-encoded in SQL: the first draft of this route compared
 * the enum column to 'PAID' (the column holds 'paid') and would have failed
 * every call, and a second copy of the acceptance rule can only drift from the
 * first. Paid payments are low-volume by nature; if that ever stops being true,
 * this wants a grouped query rather than a column of rows.
 *
 * Read-only, authenticated and metered like its job neighbours (jobGate). It echoes
 * identifiers and amounts only, so it is safe to run from the pinger or cron.
 *
 * The two money findings are answered as **503**, not as `ok: false` inside a
 * 200. The status code is the only channel the monitor can read — the free
 * cron-job.org tier fails a job on non-2xx and cannot inspect the body, and the
 * GitHub tick that polls this route exits non-zero on non-200 — so this report
 * could previously have found real money contradictions while the monitor that
 * calls it stayed green forever. The advisory `unverified` and `stale` blocks
 * deliberately keep returning 200: they describe money that was accepted
 * correctly but never cross-checked, and checkouts that will never settle,
 * which are worth reading and not worth paging on. A report that paged on them
 * would be muted before the money case ever fired.
 */
async function getReconcileStatus(req: NextRequest) {
  const denied = await jobGate(req, "jobs/reconcile", req.nextUrl.searchParams.get("secret"));
  if (denied) return denied;

  const paidRows = await prisma.payment.findMany({
    where: { status: "PAID" },
    select: { id: true, amountUsd: true, providerAmount: true, providerCurrency: true, paidAt: true },
    orderBy: { paidAt: "desc" },
  });

  // Count every contradiction, show at most five: a count capped by the sample
  // size would understate exactly the problem this report exists to surface.
  const divergentRows = paidRows.filter(
    (r) =>
      (r.providerAmount !== null && !providerAmountAgrees(r.amountUsd, r.providerAmount)) ||
      !providerCurrencyAgrees(r.providerCurrency)
  );

  const unverifiedWhere = { status: "PAID" as const, providerAmount: null };
  const unverifiedCount = await prisma.payment.count({ where: unverifiedWhere });
  const unverifiedByProvider = await prisma.payment.groupBy({
    by: ["provider"],
    where: unverifiedWhere,
    _count: { _all: true },
  });
  const unverifiedSamples = await prisma.payment.findMany({
    where: unverifiedWhere,
    select: { id: true, amountUsd: true, provider: true, paidAt: true },
    orderBy: { paidAt: "desc" },
    take: 5,
  });

  // R08-3: rejected deliveries that were never superseded. The window/status
  // comparison is done here rather than in SQL for the same reason the money
  // comparison is: the predicate is the acceptance rule's own reading of the
  // register, and a second copy of it in a query can only drift from this one.
  const errorRows = await prisma.providerEvent.findMany({
    where: {
      outcome: "ERROR",
      createdAt: { lt: new Date(Date.now() - UNAPPLIED_GRACE_MS), gt: new Date(Date.now() - UNAPPLIED_LOOKBACK_MS) },
      paymentId: { not: null },
    },
    select: {
      id: true,
      providerEventId: true,
      eventType: true,
      detail: true,
      createdAt: true,
      payment: { select: { id: true, status: true, amountUsd: true, provider: true, paidAt: true } },
    },
    orderBy: { createdAt: "desc" },
    take: UNAPPLIED_SCAN_LIMIT,
  });
  const unappliedRows = errorRows.filter((r) => {
    const p = r.payment;
    if (!p) return false;
    // Captured and never applied: the payment is still waiting for a delivery
    // that a rejected one was supposed to be.
    if (p.status === "PENDING") return true;
    // Applied and then refused: a reversal that arrived after the money was
    // applied and could not unwind. Before-application failures are excluded —
    // a rejection that a later delivery superseded is a stale row, not a live
    // contradiction.
    return p.status === "PAID" && p.paidAt !== null && r.createdAt > p.paidAt;
  });

  const staleWhere = {
    status: "PENDING" as const,
    createdAt: { lt: new Date(Date.now() - STALE_PENDING_MS) },
  };
  const staleCount = await prisma.payment.count({ where: staleWhere });
  const staleSamples = await prisma.payment.findMany({
    where: staleWhere,
    select: { id: true, amountUsd: true, provider: true, providerCheckoutUrl: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 5,
  });

  const failing = divergentRows.length > 0 || unappliedRows.length > 0;

  return NextResponse.json(
    {
      ok: !failing,
      paidTotal: paidRows.length,
      divergent: { count: divergentRows.length, samples: divergentRows.slice(0, 5) },
      unapplied: {
        count: unappliedRows.length,
        scanned: errorRows.length,
        truncated: errorRows.length === UNAPPLIED_SCAN_LIMIT,
        samples: unappliedRows.slice(0, 5).map((r) => ({
          event: r.providerEventId,
          eventType: r.eventType,
          detail: r.detail,
          at: r.createdAt,
          payment: r.payment,
        })),
        note: "A delivery ended in ERROR and was never superseded, on a payment that is still PENDING (money captured, nothing applied) or still PAID (a reversal that never unwound). Rejections younger than an hour are excluded: those may still be a retry in flight.",
      },
      unverified: {
        count: unverifiedCount,
        byProvider: unverifiedByProvider.map((r) => ({ provider: r.provider, count: r._count._all })),
        samples: unverifiedSamples,
        note: "Paid on our own checkout figure alone: the provider's delivery stated no amount, so nothing could be cross-checked.",
      },
      stale: {
        count: staleCount,
        samples: staleSamples,
        note: "Pending past the provider session's own lifetime, so no delivery is coming. Rows with no session at all are cancelled by /api/jobs/abandoned-checkouts; these carry one and are operator work.",
      },
    },
    { status: failing ? 503 : 200 }
  );
}

/** Same auth, same report — the second verb exists so this can be reached by
 * whatever schedule the deployment has. It is deliberately NOT in vercel.json,
 * and on the Hobby plan it could not be: the two cron slots are both daily mail
 * retries, which have no other wake-up, while this report is polled every ten
 * minutes by .github/workflows/outbox-tick.yml — better than a daily cron would
 * have been. A cron run here would also produce a response nobody reads; the
 * status code is the signal, so this belongs on a monitor's URL list next to
 * /api/jobs/config, which is exactly where the tick put it. */
async function postReconcile(req: NextRequest) {
  return getReconcileStatus(req);
}
