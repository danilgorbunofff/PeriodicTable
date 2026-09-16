/**
 * Listing visibility (Phase 6 moderation).
 *
 * - VISIBLE: everywhere.
 * - UNLISTED: direct-link surfaces only (tiles, element detail, profile).
 *   Excluded from discovery: search, board tabs, table order.
 * - HIDDEN: excluded from every public surface; profile 404s; /go refuses.
 *   Financial history (stakes, payments, aggregates) is NEVER deleted —
 *   hidden money stays in pool/count totals, documented on the operator run.
 */
import { ModerationState, type Prisma } from "@prisma/client";

/** Startups visible on discovery surfaces (search/boards/table-order). */
import { prisma } from "./prisma";

export const DISCOVERABLE_STATES: ModerationState[] = ["VISIBLE"];

/** Startups visible on positional/direct surfaces (tiles, detail, profile). */
export const DIRECT_STATES: ModerationState[] = ["VISIBLE", "UNLISTED"];

/**
 * The one predicate that decides whether a stake owns a tile face (R03-2): a
 * directly-visible listing holding a live amount. A fully reversed stake keeps
 * its money in the aggregates but gives the face back.
 *
 * Both the tile face (`/api/elements`) and the claim headline
 * (`/api/stats.claimedElements`) must use this clause. When the headline used
 * the denormalised `Element.stakeCount` instead, hiding one listing made the
 * homepage report a claimed tile that the board drew empty — a false statement
 * about someone's money, in the direction that flatters us.
 */
export const FACE_STAKE_WHERE = {
  startup: { moderationState: { in: DIRECT_STATES } },
  amountUsd: { gt: 0 },
} satisfies Prisma.StakeWhereInput;

export function isDiscoverable(state: ModerationState): boolean {
  return state === "VISIBLE";
}

export function isDirectVisible(state: ModerationState): boolean {
  return state === "VISIBLE" || state === "UNLISTED";
}

/**
 * The triage promise, in one place (R16-12).
 *
 * `/legal/contact` tells a reporter their report is "actioned within 72 hours"
 * and nothing in the product counted the wait: the queue route ordered by
 * `createdAt desc` and answered 50 rows, so the report that had waited longest
 * was the least likely to be read. A promise with no metric is a promise nobody
 * can keep on purpose, so this is the metric.
 */
export const TRIAGE_PROMISE_HOURS = 72;

export type QueueAge = {
  /** Open (untriaged) reports, whatever their age. */
  open: number;
  /** Open reports already older than the promise. */
  overdue: number;
  /** Hours the oldest open report has waited; null when the queue is empty. */
  oldestHours: number | null;
  /** The oldest open report's creation time, ISO, or null. */
  oldestAt: string | null;
  /** Whether the promise is being breached right now. */
  breached: boolean;
};

/**
 * Age of the triage queue, measured against TRIAGE_PROMISE_HOURS.
 *
 * Counted rather than sampled: `overdue` is what the operator acts on, and a
 * count capped by a page size (the queue answers 50 rows) would understate the
 * backlog at exactly the moment the backlog matters. The oldest row is read
 * separately because ordering ascending is the one query that answers "which
 * report has waited longest" — the queue's own ordering cannot.
 *
 * `breached` is the promise itself and not a general health flag: open reports
 * inside the window are not a problem, and the caller that pages on this must
 * page on the breach, not on `open > 0`.
 */
export async function reportQueueAge(
  now: Date = new Date(),
): Promise<QueueAge> {
  const openWhere = { status: "OPEN" as const };
  const cutoff = new Date(now.getTime() - TRIAGE_PROMISE_HOURS * 60 * 60_000);
  const [open, overdue, oldest] = await Promise.all([
    prisma.report.count({ where: openWhere }),
    prisma.report.count({ where: { ...openWhere, createdAt: { lt: cutoff } } }),
    prisma.report.findFirst({
      where: openWhere,
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);
  const oldestHours = oldest
    ? Math.max(0, Math.round((now.getTime() - oldest.createdAt.getTime()) / 36_000) / 100)
    : null;
  return {
    open,
    overdue,
    oldestHours,
    oldestAt: oldest ? oldest.createdAt.toISOString() : null,
    breached: overdue > 0,
  };
}
