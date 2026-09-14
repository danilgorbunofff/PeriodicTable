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
