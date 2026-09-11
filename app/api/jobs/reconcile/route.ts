import { NextRequest, NextResponse } from "next/server";
import { jobAuth } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";
import { providerAmountAgrees, providerCurrencyAgrees } from "@/lib/whop";

export const dynamic = "force-dynamic";

/**
 * Money reconciliation report (Phase 2 follow-up).
 *
 * `Payment.providerAmount` / `providerCurrency` were written and never read,
 * and `validateWhopMoney` answered "fine" both for a verified amount and for a
 * provider that stated none — so an unverified charge was indistinguishable
 * from a cross-checked one. This is the surface that reads them back.
 *
 * Two findings, deliberately different in severity:
 *  - `divergent` (fails `ok`): a PAID payment whose stored provider figure
 *    contradicts the charge — it matches neither dollars nor cents, or it
 *    names a currency that is not USD. Impossible by construction, since the
 *    webhook rejects contradictions before settling, so any hit means the
 *    acceptance rule, or a path that bypassed it, is wrong.
 *  - `unverified` (advisory): a PAID payment carrying no provider figure at
 *    all. Not a defect — providers may omit it — but the money was accepted on
 *    our own checkout figure alone, and this is the only place that is visible.
 *
 * The comparison runs in TypeScript through the same predicates the live
 * webhook uses, never re-encoded in SQL: the first draft of this route compared
 * the enum column to 'PAID' (the column holds 'paid') and would have failed
 * every call, and a second copy of the acceptance rule can only drift from the
 * first. Paid payments are low-volume by nature; if that ever stops being true,
 * this wants a grouped query rather than a column of rows.
 *
 * Read-only, authenticated like its job neighbours (jobAuth). It echoes
 * identifiers and amounts only, so it is safe to run from the pinger or cron.
 */
export async function GET(req: NextRequest) {
  const denied = jobAuth(req, req.nextUrl.searchParams.get("secret"));
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

  return NextResponse.json({
    ok: divergentRows.length === 0,
    paidTotal: paidRows.length,
    divergent: { count: divergentRows.length, samples: divergentRows.slice(0, 5) },
    unverified: {
      count: unverifiedCount,
      byProvider: unverifiedByProvider.map((r) => ({ provider: r.provider, count: r._count._all })),
      samples: unverifiedSamples,
      note: "Paid on our own checkout figure alone: the provider's delivery stated no amount, so nothing could be cross-checked.",
    },
  });
}

/** Same auth, same report — the second verb exists so this can be put on a cron
 * without a code change, but it is deliberately NOT in vercel.json. A cron run
 * here would produce a response nobody reads; `ok: false` is a signal for a
 * monitor to alert on, so this belongs on the pinger's URL list next to
 * /api/jobs/config, alongside the day the report actually finds something. */
export async function POST(req: NextRequest) {
  return GET(req);
}
