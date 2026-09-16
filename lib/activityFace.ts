import type { ActivityRow } from "./api";
import type { LiveState } from "./liveState";

/**
 * What the live-activity card may say (R02-5, R02-6).
 *
 * Two lies lived here. An empty feed and a pending feed were the same state in
 * the component (`!s0`), so a production response of `[]` sat on "loading…"
 * forever above a footer reading `0 recent`. And the footer asserted `live ·
 * updates every 30s` unconditionally, including after a refresh failed and the
 * rows on screen were retained from an earlier success.
 *
 * Both are decided here instead, from the same LiveState the rest of the app
 * uses, so the words on the card cannot disagree with the data behind it.
 */

export type ActivityHeader =
  | { kind: "error"; text: string }
  | { kind: "loading"; text: string }
  | { kind: "empty"; text: string }
  | { kind: "lead"; symbol: string; verb: string; city: string; demo: boolean };

export type ActivityFace = {
  header: ActivityHeader;
  /** The footer's status word, and what qualifies it. */
  status: string;
  detail: string;
  /** True only when the last request succeeded. */
  live: boolean;
  /** True when the rows on screen are retained from an earlier success. */
  lastKnown: boolean;
  /** The dot beside the panel title: amber and still whenever nothing is proven live. */
  dot: { className: string; ping: boolean };
};

const DOT_LIVE = { className: "bg-green-500 shadow-[0_0_8px_#22c55e]", ping: true };
const DOT_LAST_KNOWN = { className: "bg-amber-400", ping: false };

/** R19-3: the sentence a brand-new board says. The activity card and the Table
 * Order panel are the two surfaces a stranger meets first, and on launch day
 * both are empty — so they say it the same way, from here, once. */
export const NO_STAKES_YET = "No stakes yet — the first claim lands here.";

export function activityFace(state: LiveState, rows: ActivityRow[] | undefined): ActivityFace {
  const first = rows?.[0];
  const header: ActivityHeader =
    state === "unavailable"
      ? { kind: "error", text: "Couldn't load activity — retrying…" }
      : state === "loading"
        ? { kind: "loading", text: "loading…" }
        : !first
          ? { kind: "empty", text: NO_STAKES_YET }
          : {
              kind: "lead",
              symbol: first.elementSymbol.toUpperCase(),
              verb: kindVerb(first.kind),
              city: first.city ?? "somewhere",
              // R16-9: the header publishes the newest row's city as a fact.
              // For a seeded row that city was invented by the seeder, so the
              // card says what the row is rather than who did it.
              demo: !!first.demo,
            };

  if (state === "ok") {
    return { header, status: "live", detail: "updates every 30s", live: true, lastKnown: false, dot: DOT_LIVE };
  }
  if (state === "stale") {
    return {
      header,
      status: "last known",
      detail: "live updates paused",
      live: false,
      lastKnown: !!rows?.length,
      dot: DOT_LAST_KNOWN,
    };
  }
  return {
    header,
    status: state === "loading" ? "waiting" : "offline",
    detail: state === "loading" ? "no response yet" : "not updating",
    live: false,
    lastKnown: !!rows?.length,
    dot: DOT_LAST_KNOWN,
  };
}

/** The header line's verb for the newest event. */
export function kindVerb(kind: string): string {
  if (kind === "join") return "New bid";
  if (kind === "reclaim") return "Crown reclaimed";
  if (kind === "refund") return "Stake refunded";
  return "Stake bumped";
}

/** The per-row phrasing of the same events. */
export function kindLabel(kind: string): string {
  if (kind === "join") return "bid on";
  if (kind === "reclaim") return "reclaimed";
  if (kind === "refund") return "refunded";
  return "topped up";
}
