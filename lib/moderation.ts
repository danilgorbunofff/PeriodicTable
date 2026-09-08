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
import { ModerationState } from "@prisma/client";

/** Startups visible on discovery surfaces (search/boards/table-order). */
export const DISCOVERABLE_STATES: ModerationState[] = ["VISIBLE"];

/** Startups visible on positional/direct surfaces (tiles, detail, profile). */
export const DIRECT_STATES: ModerationState[] = ["VISIBLE", "UNLISTED"];

export function isDiscoverable(state: ModerationState): boolean {
  return state === "VISIBLE";
}

export function isDirectVisible(state: ModerationState): boolean {
  return state === "VISIBLE" || state === "UNLISTED";
}
