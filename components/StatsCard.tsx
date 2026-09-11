"use client";
import { Card } from "./Card";
import type { StatsResponse } from "../lib/api";

/** Written where a figure is unknown. An em dash reads as "no value", which is
 *  the truth; a zero reads as "we counted, and there are none". */
const UNKNOWN = "—";

/** Homepage stats (Phase 4, P1-09): exact quantities — claimed tiles live,
 * total staked USD (summed), unclaimed tiles.
 *
 *  Every figure stays an em dash until `stats` arrives. The card previously
 *  defaulted to 0 / $0 / 122, and those three numbers together do not read as
 *  "no data" — they read as a *fact*: nothing has ever sold and all 122 elements
 *  are free. On a page whose whole premise is that they are not, that is the
 *  most expensive possible thing to guess. Unknown and zero are different
 *  claims, so the card renders the one that is always safe.
 *
 *  `stale` marks values that are real but no longer current (SWR keeps the last
 *  good response when a refresh fails). Worth showing — just not worth passing
 *  off as live. */
export function StatsCard({ stats, stale }: { stats?: StatsResponse; stale?: boolean }) {
  const claimed = stats?.claimedElements;
  const staked = stats?.totalStakedUsd;
  const unclaimed = stats?.unclaimedElements;

  return (
    <Card className="flex flex-col items-start gap-2.5 px-4 py-4 text-sm leading-none rounded-[15px] shadow-float">
      <div className="whitespace-nowrap font-bold">🧪 <b className="text-ink font-extrabold">{claimed ?? UNKNOWN}</b> <span className="text-mutedink">elements live</span></div>
      <div className="whitespace-nowrap font-bold">
        💰 <span className="font-extrabold text-moneyink">{staked === undefined ? UNKNOWN : `$${staked.toLocaleString()}`}</span>
        <span className="text-mutedink"> in bids</span>
      </div>
      <div className="text-mutedink whitespace-nowrap font-bold">{unclaimed ?? UNKNOWN} unclaimed</div>
      {stale && <div className="whitespace-nowrap text-xs font-bold text-mutedink">Last known</div>}
    </Card>
  );
}
