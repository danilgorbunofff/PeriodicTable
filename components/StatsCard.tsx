"use client";
import { Card } from "./Card";

export function StatsCard({
  totalBids = 0,
  claimedCount = 0,
  elementsLive = 122,
}: {
  totalBids?: number;
  claimedCount?: number;
  elementsLive?: number;
}) {
  return (
    <Card className="flex flex-col items-start gap-2 px-4 py-[14px] text-[12.5px] leading-none rounded-[15px] shadow-float">
      <div className="whitespace-nowrap font-bold">🧪 <b className="text-ink font-extrabold">{claimedCount}</b> <span className="text-muted">elements live</span></div>
      <div className="whitespace-nowrap font-bold">
        💰 <span className="font-extrabold text-money">${totalBids.toLocaleString()}</span> <span className="text-muted">in bids</span>
      </div>
      <div className="text-muted whitespace-nowrap font-bold">{elementsLive - claimedCount} unclaimed · from $5</div>
    </Card>
  );
}
