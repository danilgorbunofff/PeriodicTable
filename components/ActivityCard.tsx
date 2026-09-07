"use client";
import { useEffect, useState } from "react";
import { Card } from "./Card";
import { MOCK_ACTIVITY } from "../mocks/startups";
import { relTime } from "../lib/relTime";

const GEOS = ["Berlin", "Singapore", "Prague", "Austin", "Oslo"];

export function ActivityCard({ onOpen }: { onOpen: (symbol: string) => void }) {
  const [gi, setGi] = useState(0);
  const s0 = MOCK_ACTIVITY[0];
  useEffect(() => {
    const t = setInterval(() => setGi((i) => (i + 1) % GEOS.length), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <Card className="w-[300px] max-w-[calc(100vw-36px)] rounded-2xl px-3 py-2.5 shadow-float">
      <div className="font-display text-[12.5px] font-bold text-muted flex items-center gap-2">
        <span className="block h-2 w-2 rounded-full bg-green-500 shadow-[0_0_8px_#22c55e]" />
        Live activity
      </div>
      <div className="mt-1.5 border-b border-hairline pb-2 text-xs font-extrabold text-muted">
        {s0.symbol.toUpperCase()} Someone in <span className="text-ink">{GEOS[gi]}</span> is online
      </div>
      <div className="mt-1 flex flex-col">
        {MOCK_ACTIVITY.slice(0, 5).map((s) => (
          <button key={s.domain + s.symbol} onClick={() => onOpen(s.symbol)} className="rounded-lg p-[5px] text-left transition-colors hover:bg-icy">
            <div className="flex items-center gap-[9px]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.logo} alt="" className="h-5 w-5 shrink-0 rounded-[5px]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-extrabold text-ink">{s.domain}</div>
                <div className="truncate text-[11px] font-bold text-muted">
                  <span className="font-black text-ink">#1</span> in {s.symbol} {s.elementName}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end">
                <span className="text-[13px] font-black text-money">${s.amount}</span>
                <span className="text-[10px] font-bold text-muted">{relTime(s.ts)}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between border-t border-hairline pt-2 text-[11.5px] font-bold text-muted">
        <span><b className="text-ink">409</b> visitors · 72h</span>
        <span><b className="text-ink">8</b> watching</span>
      </div>
    </Card>
  );
}
