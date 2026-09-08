"use client";
import { Card } from "./Card";

/** Homepage stats (Phase 4, P1-09): exact quantities — claimed tiles live,
 * total staked USD (summed), unclaimed tiles from $5. */
export function StatsCard({
  totalStakedUsd = 0,
  claimedCount = 0,
  elementsLive = 122,
}: {
  totalStakedUsd?: number;
  claimedCount?: number;
  elementsLive?: number;
}) {
  return (
    <Card className="flex flex-col items-start gap-2 px-4 py-[14px] text-[12.5px] leading-none rounded-[15px] shadow-float">
      <div className="whitespace-nowrap font-bold">🧪 <b className="text-ink font-extrabold">{claimedCount}</b> <span className="text-mutedink">elements live</span></div>
      <div className="whitespace-nowrap font-bold">
        💰 <span className="font-extrabold text-moneyink">${totalStakedUsd.toLocaleString()}</span> <span className="text-mutedink">in bids</span>
      </div>
      <div className="text-mutedink whitespace-nowrap font-bold">{elementsLive - claimedCount} unclaimed · from $5</div>
    </Card>
  );
}
