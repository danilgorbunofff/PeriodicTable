"use client";
import { useMemo } from "react";
import useSWR from "swr";
import { Card } from "./Card";
import { Avatar } from "./Avatar";
import { fetcher } from "../lib/api";

type Tile = {
  symbol: string;
  name: string;
  pool: number;
  count: number;
  leader: { domain: string; logoUrl: string; amount: number } | null;
};

export function WorldOrder({
  onClose,
  onExpand,
  expanded,
}: {
  onClose?: () => void;
  onExpand?: () => void;
  /** Rendered inside the fullscreen-ish expand overlay: swap in the worldmap.lol-style cream header, drop own controls, and let the parent shell scroll instead. */
  expanded?: boolean;
}) {
  const { data: tiles, error } = useSWR<Tile[]>("/api/elements", fetcher, { refreshInterval: 30000 });

  const rows = useMemo(() => {
    const byDomain: Record<string, { total: number; elements: Set<string>; crowns: number; logo: string }> = {};
    for (const t of tiles ?? []) {
      if (!t.leader) continue;
      const d = byDomain[t.leader.domain] ?? {
        total: 0,
        elements: new Set<string>(),
        crowns: 0,
        logo: t.leader.logoUrl,
      };
      d.crowns += 1;
      d.total += t.leader.amount;
      d.elements.add(t.symbol);
      d.logo = t.leader.logoUrl;
      byDomain[t.leader.domain] = d;
    }
    return Object.entries(byDomain)
      .map(([domain, data]) => ({ domain, ...data }))
      .sort((a, b) => b.total - a.total)
      .map((row, i) => ({ ...row, rank: i + 1 }));
  }, [tiles]);

  return (
    <div className={`flex flex-col ${expanded ? "h-full" : ""}`}>
      {expanded ? (
        <div
          className="-mx-6 -mt-6 mb-4 flex shrink-0 items-start gap-3 px-6 pt-6 pb-5"
          style={{ background: "linear-gradient(180deg,#FFEFC1,#FFCE4B)" }}
        >
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-white text-2xl shadow-card">⚗️</div>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-[11px] tracking-[.14em] text-ink/60 font-extrabold uppercase">the table · live</div>
            <h2 className="mt-0.5 font-display text-[27px] leading-none font-bold text-ink">Table Order</h2>
            <div className="mt-1.5 text-xs font-extrabold text-ink/70">TOP 10 · MOST SPENT</div>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] tracking-[.14em] text-muted font-extrabold uppercase">the table · live</div>
            <h2 className="mt-0.5 font-display text-[27px] leading-none font-bold">⚗️ Table Order</h2>
            <div className="mt-1.5 text-xs font-extrabold text-money">TOP 10 · MOST SPENT</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {onClose && (
              <button aria-label="Close" title="Close" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-full bg-icy text-muted hover:text-ink">✕</button>
            )}
            {onExpand && (
              <button aria-label="Expand" title="Expand" onClick={onExpand} className="grid h-7 w-7 place-items-center rounded-full bg-icy text-muted hover:text-ink">⤢</button>
            )}
          </div>
        </div>
      )}
      <div className={`flex flex-col overflow-auto pr-1 ${expanded ? "flex-1" : "mt-4 max-h-[44vh]"}`}>
        {error && (
          <div className="rounded-xl bg-icy p-3 text-sm font-bold text-muted">Couldn&apos;t load standings.</div>
        )}
        {!tiles && !error
          ? [0, 1, 2, 3, 4].map((i) => <div key={i} className="h-[52px] rounded-xl bg-icy animate-pulse mb-1" />)
          : null}
        {rows.map((r) => {
          const logo = r.logo;
          const first = r.rank === 1;
          return (
            <a
              key={r.domain}
              href={`/s/${encodeURIComponent(r.domain)}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`grid items-center text-left no-underline transition-colors ${
                first
                  ? "mb-1 grid-cols-[34px_32px_1fr_auto] gap-2.5 rounded-[14px] border border-goldwashedge bg-goldwash px-2.5 py-3"
                  : "grid-cols-[34px_20px_1fr_auto] gap-2.5 rounded-[9px] border-b border-hairline px-2 py-2.5 hover:bg-icy"
              }`}
            >
              {first ? (
                <span className="grid h-7 min-w-[34px] place-items-center rounded-lg bg-sale text-[12px] font-extrabold text-white">#1</span>
              ) : (
                <span className="text-center text-[13.5px] font-display font-bold text-muted">#{r.rank}</span>
              )}
              <Avatar
                src={logo}
                domain={r.domain}
                size={first ? 32 : 20}
                rounded={first ? "rounded-lg" : "rounded-[5px]"}
              />
              <span className="min-w-0">
                <span className={`block truncate font-extrabold text-ink ${first ? "text-base" : "text-sm"}`}>{r.domain}</span>
                <span className={`${first ? "text-xs" : "text-[11.5px]"} block truncate font-bold text-muted`}>{r.elements.size} elements · 👑 {r.crowns}</span>
              </span>
              <span className={`${first ? "text-[19px]" : "text-sm"} whitespace-nowrap font-display font-bold text-money`}>${r.total}</span>
            </a>
          );
        })}
      </div>
      <div className="mt-2 shrink-0 text-center text-[11px] font-bold text-muted whitespace-nowrap">total staked across every element · click one for details</div>
    </div>
  );
}

export function RailShell({ children }: { children: React.ReactNode }) {
  return <Card className="overflow-hidden rounded-[22px] p-5 shadow-card">{children}</Card>;
}
