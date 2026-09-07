"use client";
import { useEffect, useState } from "react";
import { Card } from "./Card";

export function StatsCard({
  totalBids = 269,
  claimedCount = 5,
}: {
  totalBids?: number;
  claimedCount?: number;
}) {
  const [bids, setBids] = useState(totalBids);
  useEffect(() => {
    const t = setInterval(() => setBids((b) => b + (1 + Math.floor(Math.random() * 7))), 20000);
    return () => clearInterval(t);
  }, []);
  return (
    <Card className="flex flex-col items-start gap-2 px-4 py-[14px] text-[12.5px] leading-none rounded-[15px] shadow-float">
      <div className="whitespace-nowrap font-bold">🧪 <b className="text-ink font-extrabold">{claimedCount}</b> <span className="text-muted">elements live</span></div>
      <div className="whitespace-nowrap font-bold">
        💰 <span className="font-extrabold text-money">${bids.toLocaleString()}</span> <span className="text-muted">in bids</span>
      </div>
      <div className="text-muted whitespace-nowrap font-bold">{122 - claimedCount} unclaimed · from $5</div>
    </Card>
  );
}
