"use client";
import { useState } from "react";
import useSWR from "swr";
import { ChunkyButton } from "./ChunkyButton";
import { Avatar } from "./Avatar";
import type { ElementNode } from "../lib/elements";
import { fetcher, type ElementDetail } from "../lib/api";
import { FAMILY_FILL } from "../lib/familyFill";
import { relTime } from "../lib/relTime";

export function TerritoryView({
  el,
  onClose,
  onStake,
  onExpand,
  expanded,
}: {
  el: ElementNode;
  onClose: () => void;
  onStake: (el: ElementNode, amount: number) => void;
  onExpand?: () => void;
  /** Rendered inside the fullscreen-ish expand overlay: drop own header controls, Modal supplies the close affordance. */
  expanded?: boolean;
}) {
  const { data, error, mutate } = useSWR<ElementDetail>(`/api/elements/${el.symbol}`, fetcher, {
    refreshInterval: 30000,
  });
  const rows = data?.stakes ?? [];
  const [hover, setHover] = useState<string | null>(null);
  const top = rows[0];
  const takeLead = data?.prices.takeLead ?? (top ? top.amount + 1 : 5);
  const joinMin = data?.prices.joinMin ?? 5;
  const totalStaked = data?.pool ?? 0;

  return (
    <div className="flex flex-col h-full relative">
      {expanded ? (
        <div
          className="-mx-6 -mt-6 mb-4 flex shrink-0 items-start gap-3 px-6 pt-6 pb-5"
          style={{ background: "linear-gradient(180deg,#FFEFC1,#FFCE4B)" }}
        >
          <div
            className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-xl font-display font-bold shadow-card"
            style={{ background: rows.length ? FAMILY_FILL[el.family] : "#fff" }}
          >
            {el.symbol}
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-[11px] tracking-widest font-extrabold uppercase text-ink/60">
              {rows.length ? "CLAIMED TERRITORY" : "UNCLAIMED TERRITORY"}
            </div>
            <h2 className="mt-0.5 font-display text-[27px] leading-none font-bold text-ink">
              {el.symbol} {el.name}
            </h2>
            <div className="mt-1.5 text-xs font-extrabold text-ink/70 whitespace-nowrap">
              {rows.length ? `${rows.length} bidding · $${totalStaked} staked` : "no bids yet · $5 to be the first"}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between">
          <div className="text-[11px] tracking-widest text-muted font-bold">
            {rows.length ? "CLAIMED TERRITORY" : "UNCLAIMED TERRITORY"}
          </div>
          <div className="flex gap-1.5">
            {onExpand && (
              <button aria-label="Expand" title="Expand" onClick={onExpand} className="grid h-7 w-7 place-items-center rounded-full bg-icy text-muted hover:text-ink">⤢</button>
            )}
            <button aria-label="Close" title="Close" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-full bg-icy text-muted hover:text-ink">✕</button>
          </div>
        </div>
      )}
      {!expanded && (
        <h2 className="font-display text-[28px] font-bold leading-tight mt-1">
          {el.symbol} <span className="font-semibold">{el.name}</span>
        </h2>
      )}

      {rows.length === 0 ? (
        <>
          <div className="text-xs font-bold text-money mt-1">BE THE FIRST · ${joinMin}</div>
          <div className="mt-3 bg-icy rounded-2xl p-3 text-sm">
            <span className="font-extrabold">?</span> No bids yet — plant your flag for ${joinMin}. Yours until someone outbids you.
          </div>
          <div className="mt-auto sticky bottom-0 bg-white pt-3">
            <ChunkyButton className="w-full text-sm px-5 h-12" onClick={() => onStake(el, joinMin)}>
              Be the first — from ${joinMin}
            </ChunkyButton>
            <div className="text-center text-[11px] text-muted mt-1">plant your flag · rank is your total stake</div>
          </div>
        </>
      ) : (
        <>
          {!expanded && (
            <div className="text-xs font-bold text-money mt-1 whitespace-nowrap">
              {rows.length} bidding · #1 pays ${top.amount}
            </div>
          )}
          <div className={`flex-1 overflow-auto flex flex-col gap-1 pr-1 ${expanded ? "" : "mt-3"}`}>
            {!data && !error
              ? [0, 1, 2, 3].map((i) => <div key={i} className="h-[52px] rounded-2xl bg-icy animate-pulse" />)
              : rows.map((r, i) => (
              <a
                key={r.domain}
                href={r.stakeId ? `/go/${r.stakeId}` : `/s/${encodeURIComponent(r.domain)}`}
                target="_blank"
                rel="sponsored nofollow noopener"
                onMouseEnter={() => setHover(r.domain)}
                onMouseLeave={() => setHover(null)}
                className={`relative block px-3 py-2 rounded-2xl no-underline ${i === 0 ? "bg-goldwash" : "hover:bg-icy"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="grid h-7 min-w-[30px] shrink-0 place-items-center rounded-lg bg-sale text-[11px] font-extrabold text-white">#{i + 1}</span>
                  <Avatar src={r.logo} domain={r.domain} size={24} rounded="rounded-full" />
                      <span className="text-sm font-bold text-ink truncate">{r.domain}</span>
                      <span className="ml-auto text-sm font-extrabold text-money whitespace-nowrap">${r.amount}</span>
                </div>
                <div className="text-xs text-muted truncate pl-[38px]">{r.pitch}</div>
                {hover === r.domain && (
                  <div className="absolute left-0 -translate-x-[108%] top-0 w-64 bg-white rounded-card shadow-card p-3 z-[var(--z-preview)] hidden md:block">
                    <div className="bg-icy rounded-xl h-24 grid place-items-center text-xs text-muted">loading preview…</div>
                    <div className="mt-2 text-sm font-bold">{r.domain}</div>
                    <div className="text-xs text-muted">{r.pitch}</div>
                    <div className="text-xs mt-1">🔗 <span className="text-money font-bold">{r.domain}</span></div>
                    <div className="text-xs text-live font-bold">🟢 {r.clicks} clicks delivered</div>
                    <div className="text-xs font-bold text-money">View profile →</div>
                  </div>
                )}
              </a>
              ))}
            {error && (
              <div className="rounded-2xl bg-icy p-3 text-sm font-bold text-muted">
                Couldn&apos;t load {el.symbol} —{" "}
                <button className="underline font-extrabold" onClick={() => mutate()}>retry</button>
              </div>
            )}
          </div>
          <div className="sticky bottom-0 bg-white pt-2">
            <ChunkyButton className="w-full text-sm px-5 h-12" onClick={() => onStake(el, takeLead)}>
              Claim a spot — for ${takeLead}
            </ChunkyButton>
            <div className="text-center text-[11px] text-muted mt-1">rank is your total stake · top up to climb</div>
          </div>
        </>
      )}
      <div className="mt-2 text-[11px] text-muted">IUPAC Standard · {relTime(Date.now() - 3600_000)}</div>
    </div>
  );
}
