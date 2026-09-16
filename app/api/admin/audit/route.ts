import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminGate } from "@/lib/jobs";
import { apiJson, apiError, apiRoute } from "@/lib/route";
import { isAuditAction } from "@/lib/audit";
import { OPS_WINDOW_DAYS } from "@/lib/opsMetrics";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: listAudit });

/**
 * The audit trail, in production (R18-5, doc 18 §3.8 row 7).
 *
 * `AuditLog` was written by every privileged mutation since Phase 1 and read by
 * nothing but tests — so "what has the operator done, and to whom" had exactly
 * one answer available at launch, `psql` against the production database from
 * whatever shell happened to be open. That is the surface a takedown request,
 * a payment reversal dispute and a "did we ever moderate this one" all run
 * through, and doc 18's acceptance criterion (R18-5) asks for a reader *or* a
 * documented query. This is the reader; `ops/takedown.md` keeps the query for
 * the case where the route itself is the thing that is down.
 *
 * Shape follows `admin/reports` (R11-6) on purpose:
 *
 * - filters are validated against the shared action list (`isAuditAction`), not
 *   cast into Prisma, so `?action=payment_reversed` is a 400 rather than an
 *   empty page that looks like "nothing was ever reversed";
 * - `?before=<id>` is the page cursor and `id` is the ordering tiebreak, so the
 *   boundary does not move between two rows sharing a timestamp;
 * - the operator-window counts ride in headers, because the body is a bare
 *   array that curl pipelines read positionally and the numbers are what an
 *   alert or a glance actually wants (`curl -i` / `-D -`).
 *
 * No address, no hashed IP, no rendered detail page: `detail` is returned
 * verbatim because it is the audit record — for `SUBJECT_ERASED` it is a count
 * by construction (R12-4), and for the mail actions it is the address, which is
 * the point of those rows. The route is `adminGate`d for the same reason.
 */
async function listAudit(req: NextRequest) {
  const denied = await adminGate(req, "admin/audit");
  if (denied) return denied;

  const action = req.nextUrl.searchParams.get("action");
  if (action !== null && !isAuditAction(action)) {
    return apiError("Unknown audit action.", { status: 400, code: "BAD_ACTION" });
  }
  const startup = req.nextUrl.searchParams.get("startup");
  const payment = req.nextUrl.searchParams.get("payment");
  const before = req.nextUrl.searchParams.get("before");

  const where = {
    ...(action ? { action } : {}),
    ...(startup ? { startupId: startup } : {}),
    ...(payment ? { paymentId: payment } : {}),
  };

  const since = new Date(Date.now() - OPS_WINDOW_DAYS * 86_400_000);
  const [rows, windowCounts] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
      take: 50,
      select: {
        id: true,
        action: true,
        actorType: true,
        actorRef: true,
        startupId: true,
        elementId: true,
        paymentId: true,
        detail: true,
        createdAt: true,
      },
    }),
    // One grouped aggregate answers both questions §3.8 row 7 asks: how much of
    // each privileged action happened, and how much of it was a human's doing.
    prisma.auditLog.groupBy({
      by: ["action", "actorType"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
  ]);

  const countOf = (name: string) =>
    windowCounts
      .filter((row) => row.action === name)
      .reduce((sum, row) => sum + row._count._all, 0);

  const res = apiJson(rows);
  // Operator data behind a bearer: never cacheable, and stated here rather than
  // left to whatever a proxy would do with `/api/*` (same line as `admin/ops`).
  res.headers.set("Cache-Control", "no-store, max-age=0");
  res.headers.set("X-Audit-Window-Days", String(OPS_WINDOW_DAYS));
  res.headers.set("X-Audit-Payment-Reversed", String(countOf("PAYMENT_REVERSED")));
  res.headers.set("X-Audit-Profile-Moderated", String(countOf("PROFILE_MODERATED")));
  res.headers.set("X-Audit-Report-Triaged", String(countOf("REPORT_TRIAGED")));
  res.headers.set(
    "X-Audit-Operator-Writes",
    String(
      windowCounts
        .filter((row) => row.actorType === "operator")
        .reduce((sum, row) => sum + row._count._all, 0),
    ),
  );
  return res;
}
