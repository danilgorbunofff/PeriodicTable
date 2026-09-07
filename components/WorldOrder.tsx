"use client";
import { useMemo } from "react";
import { Card } from "./Card";
import { MOCK_STAKES } from "../mocks/startups";

export function WorldOrder({ onOpen }: { onOpen: (domain: string) => void }) {
  const rows = useMemo(() => {
    const byDomain: Record<string, { total: number; elements: Set<string>; crowns: number }> = {};
    for (const s of MOCK_STAKES) {
      const d = byDomain[s.domain] ?? { total: 0, elements: new Set(), crowns: 0 };
      d.total += s.amount;
      d.elements.add(s.symbol);
      byDomain[s.domain] = d;
    }
    // crown = top stake per element
    const topByEl: Record<string, string> = {};
    for (const s of MOCK_STAKES) {
      const cur = MOCK_STAKES.find((x) => x.domain === topByEl[s.symbol]);
      if (!cur || s.amount > cur.amount) topByEl[s.symbol] = s.domain;
    }
    for (const domain of Object.keys(byDomain)) {
      byDomain[domain].crowns = Object.values(topByEl).filter((d) => d === domain).length;
    }
    return Object.entries(byDomain)
      .map(([domain, data]) => ({ domain, ...data }))
      .sort((a, b) => b.total - a.total)
      .map((row, i) => ({ ...row, rank: i + 1 }));
  }, []);

  return (
    <div className="flex flex-col">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] tracking-[.14em] text-muted font-extrabold uppercase">the table · live</div>
          <h2 className="mt-0.5 font-display text-[27px] leading-none font-bold">⚗️ Table Order</h2>
          <div className="mt-1.5 text-xs font-extrabold text-money">TOP 10 · MOST SPENT</div>
        </div>
        <button aria-label="Expand" title="Expand" className="grid h-7 w-7 place-items-center rounded-full bg-icy text-muted hover:text-ink">⤢</button>
      </div>
      <div className="mt-4 flex max-h-[44vh] flex-col overflow-auto pr-1">
        {rows.map((r) => {
          const logo = MOCK_STAKES.find((s) => s.domain === r.domain)?.logo;
          const first = r.rank === 1;
          return (
            <button
              key={r.domain}
              onClick={() => onOpen(r.domain)}
              className={`grid items-center text-left transition-colors ${
                first
                  ? "mb-1 grid-cols-[24px_32px_1fr_auto] gap-2.5 rounded-[14px] border border-goldwashedge bg-goldwash px-2.5 py-3"
                  : "grid-cols-[30px_20px_1fr_auto] gap-2.5 rounded-[9px] border-b border-hairline px-2 py-2.5 hover:bg-icy"
              }`}
            >
              <span className={`${first ? "text-xl" : "text-[13.5px]"} text-center font-display font-bold text-muted`}>{first ? "👑" : `#${r.rank}`}</span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {logo && <img src={logo} alt="" className={`${first ? "h-8 w-8 rounded-lg" : "h-5 w-5 rounded-[5px]"} shrink-0`} />}
              <span className="min-w-0">
                <span className={`block truncate font-extrabold text-ink ${first ? "text-base" : "text-sm"}`}>{r.domain}</span>
                <span className={`${first ? "text-xs" : "text-[11.5px]"} block truncate font-bold text-muted`}>{r.elements.size} elements · 👑 {r.crowns}</span>
              </span>
              <span className={`${first ? "text-[19px]" : "text-sm"} whitespace-nowrap font-display font-bold text-money`}>${r.total}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 text-center text-[11px] font-bold text-muted whitespace-nowrap">total staked across every element · click one to stake</div>
    </div>
  );
}

export function RailShell({ children }: { children: React.ReactNode }) {
  return <Card className="overflow-hidden rounded-[22px] p-5 shadow-card">{children}</Card>;
}
