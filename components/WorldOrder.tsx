"use client";
import { Card } from "./Card";
import { Avatar } from "./Avatar";
import useSWR from "swr";
import { fetchJson, isTableOrderRows, type TableOrderRow } from "../lib/api";

export function WorldOrder({
  onClose,
  onExpand,
  onMinimize,
  expanded,
}: {
  onClose?: () => void;
  onExpand?: () => void;
  /** Desktop rail: collapse the rail into its round FAB. */
  onMinimize?: () => void;
  /** Rendered inside the fullscreen-ish expand overlay: swap in the worldmap.lol-style cream header, drop own controls, and let the parent shell scroll instead. */
  expanded?: boolean;
}) {
  // Server-computed Table Order (Phase 4, P1-10): ALL stakes summed per
  // startup — the client no longer awards the wrong users from leader rows.
  const { data, error } = useSWR<TableOrderRow[]>("/api/table-order", (url: string) => fetchJson(url, isTableOrderRows), {
    refreshInterval: 30000,
  });
  const rows = (data ?? []).map((r, i) => ({ ...r, rank: i + 1 }));

  return (
    <div className={`flex flex-col ${expanded ? "h-full" : ""}`}>
      {expanded ? (
        <div
          className="-mx-6 -mt-6 mb-4 relative flex shrink-0 items-start gap-3 px-6 pt-6 pb-5"
          style={{ background: "linear-gradient(180deg,#FFEFC1,#FFCE4B)" }}
        >
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-white text-2xl shadow-card">⚗️</div>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-[11px] tracking-[.14em] text-ink/60 font-extrabold uppercase">the table · live</div>
            <h2 className="mt-0.5 font-display text-[27px] leading-none font-bold text-ink">Table Order</h2>
            <div className="mt-1.5 text-xs font-extrabold text-ink/70">TOP 10 · MOST SPENT</div>
          </div>
          {onClose && (
            <button
              aria-label="Close"
              title="Close"
              onClick={onClose}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/85 text-mutedink hover:text-ink [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px]"
            >
              ✕
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] tracking-[.14em] text-mutedink font-extrabold uppercase">the table · live</div>
            <h2 className="mt-0.5 font-display text-[27px] leading-none font-bold">⚗️ Table Order</h2>
            <div className="mt-1.5 text-xs font-extrabold text-moneyink">TOP 10 · MOST SPENT</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {onExpand && (
              <button aria-label="Expand" title="Expand" onClick={onExpand} className="grid h-7 w-7 place-items-center rounded-full bg-icy text-mutedink hover:text-ink [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px]">⤢</button>
            )}
            {onMinimize && (
              <button aria-label="Minimize table order" title="Minimize" onClick={onMinimize} className="grid h-7 w-7 place-items-center rounded-full bg-icy text-mutedink hover:text-ink [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px]">
                ✕
              </button>
            )}
            {onClose && (
              <button aria-label="Close" title="Close" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-full bg-icy text-mutedink hover:text-ink [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px]">✕</button>
            )}
          </div>
        </div>
      )}
      <div className={`flex flex-col overflow-auto pr-1 ${expanded ? "flex-1" : "mt-4 max-h-[44vh]"}`}>
        {error && (
          <div className="rounded-xl bg-icy p-3 text-sm font-bold text-mutedink">Couldn&apos;t load standings.</div>
        )}
        {!data && !error
          ? [0, 1, 2, 3, 4].map((i) => <div key={i} className="h-[52px] rounded-xl bg-icy animate-pulse mb-1" />)
          : null}
        {rows.map((r) => {
          const logo = r.logoUrl;
          // Podium: #1 keeps its gold card; #2/#3 mirror it in silver/bronze
          // (same layout, own wash/edge/badge); hover deepens the OWN rank
          // color. #4+ keep the plain list look exactly as before.
          const podium =
            r.rank === 1
              ? { border: "border-goldwashedge", bg: "bg-goldwash", hover: "hover:bg-golddeep", badge: "bg-sale" }
              : r.rank === 2
                ? { border: "border-silveredge", bg: "bg-silverwash", hover: "hover:bg-silverdeep", badge: "bg-medalsilver" }
                : r.rank === 3
                  ? { border: "border-bronzeedge", bg: "bg-bronzewash", hover: "hover:bg-bronzedeep", badge: "bg-medalbronze" }
                  : null;
          return (
            <a
              key={r.domain}
              href={r.stakeId ? `/go/${r.stakeId}` : `/s/${encodeURIComponent(r.domain)}`}
              target="_blank"
              rel="sponsored nofollow noopener"
              className={`grid items-center text-left no-underline transition-colors ${
                podium
                  ? `mb-1 grid-cols-[34px_32px_1fr_auto] gap-2.5 rounded-[14px] border ${podium.border} ${podium.bg} ${podium.hover} px-2.5 py-3`
                  : "grid-cols-[34px_20px_1fr_auto] gap-2.5 rounded-[9px] border-b border-hairline px-2 py-2.5 hover:bg-icy"
              }`}
            >
              {podium ? (
                <span className={`grid h-7 min-w-[34px] place-items-center rounded-lg ${podium.badge} text-[12px] font-extrabold text-ink`}>#{r.rank}</span>
              ) : (
                <span className="text-center text-[13.5px] font-display font-bold text-mutedink">#{r.rank}</span>
              )}
              <Avatar
                src={logo}
                domain={r.domain}
                size={podium ? 32 : 20}
                rounded={podium ? "rounded-lg" : "rounded-[5px]"}
              />
              <span className="min-w-0">
                <span className={`block truncate font-extrabold text-ink ${podium ? "text-base" : "text-sm"}`}>{r.domain}</span>
                <span className={`${podium ? "text-xs" : "text-[11.5px]"} block truncate font-bold text-mutedink`}>{r.elements} elements · 👑 {r.crowns}</span>
              </span>
              <span className={`${podium ? "text-[19px]" : "text-sm"} whitespace-nowrap font-display font-bold text-moneyink`}>${r.totalSpent}</span>
            </a>
          );
        })}
      </div>
      <div className="mt-2 shrink-0 text-center text-[11px] font-bold text-mutedink whitespace-nowrap">total staked across every element · click a row to visit their site</div>
    </div>
  );
}

export function RailShell({ children }: { children: React.ReactNode }) {
  return <Card className="overflow-hidden rounded-[22px] p-5 shadow-card animate-panel-in">{children}</Card>;
}
