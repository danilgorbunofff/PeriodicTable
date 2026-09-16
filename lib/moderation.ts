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
import { audit } from "./audit";

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

/** The states an operator may put a listing into, in one place (R17-14). */
export const MODERATION_STATES: ModerationState[] = ["VISIBLE", "UNLISTED", "HIDDEN"];

/** How many listings one call may move. A wave of abuse arrives as tens of
 *  domains, not thousands, and the cap is what stops a single authenticated
 *  call from re-rendering the whole front page at once — an operator who
 *  genuinely has more than this should be reading the incident notes anyway,
 *  and looping the call is how they pace it. */
export const MAX_BATCH_DOMAINS = 50;

export type ModerationOutcome = {
  domain: string;
  state: ModerationState;
  previous: ModerationState;
  /** False when the listing already stood in the requested state. */
  changed: boolean;
};

/**
 * Move one listing to a moderation state, auditing it (R17-14).
 *
 * Extracted from the single-listing route so the bulk lever added by phase 17
 * cannot drift from it: same columns, same retention behaviour (HIDDEN clears
 * the stored preview and nothing else), same PROFILE_MODERATED audit row per
 * domain, financial rows never touched. `domain` is expected already
 * normalised by the caller; the row's own domain is what comes back.
 *
 * Returns null when there is no such listing, so a bulk caller can report the
 * typos it was given instead of silently skipping them.
 *
 * The reason is trimmed here as well as at the routes: `"  "` used to satisfy
 * the "a reason is required to hide or unlist" rule and land in the trail as
 * three spaces, which is a reason nobody wrote. The check belongs to the write
 * so both routes inherit it rather than each remembering to trim.
 */
export async function applyModeration(opts: {
  domain: string;
  state: ModerationState;
  reason?: string;
  operator: string;
  now?: Date;
}): Promise<ModerationOutcome | null> {
  const startup = await prisma.startup.findUnique({ where: { domain: opts.domain } });
  if (!startup) return null;
  const now = opts.now ?? new Date();
  const restoring = opts.state === "VISIBLE";
  const updated = await prisma.startup.update({
    where: { domain: startup.domain },
    data: {
      moderationState: opts.state,
      moderatedBy: restoring ? startup.moderatedBy : opts.operator,
      moderatedReason: restoring
        ? startup.moderatedReason
        : String(opts.reason ?? "").trim().slice(0, 300),
      moderatedAt: restoring ? startup.moderatedAt : now,
      restoredAt: restoring ? now : null,
      ...(opts.state === "HIDDEN" ? { previewImgUrl: null } : {}),
    },
  });
  await audit({
    action: "PROFILE_MODERATED",
    startupId: startup.id,
    actorType: "operator",
    actorRef: opts.operator,
    detail: `${startup.moderationState} → ${updated.moderationState}: ${updated.moderatedReason ?? "restored"}`.slice(0, 300),
  });
  return {
    domain: updated.domain,
    state: updated.moderationState,
    previous: startup.moderationState,
    changed: startup.moderationState !== updated.moderationState,
  };
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
