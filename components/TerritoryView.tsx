"use client";
import { useState } from "react";
import Link from "next/link";
import { ChunkyButton } from "./ChunkyButton";
import type { ElementNode } from "../lib/elements";
import { MOCK_STAKES } from "../mocks/startups";
import { relTime } from "../lib/relTime";

export function TerritoryView({
  el,
  onClose,
  onStake,
}: {
  el: ElementNode;
  onClose: () => void;
  onStake: (el: ElementNode, amount: number) => void;
}) {
  const rows = MOCK_STAKES.filter((s) => s.symbol === el.symbol).sort((a, b) => b.amount - a.amount);
  const [hover, setHover] = useState<string | null>(null);
  const top = rows[0];
  const takeLead = top ? top.amount + 1 : 5;

  return (
    <div className="flex flex-col h-full relative">
      <div className="flex items-start justify-between">
        <div className="text-[11px] tracking-widest text-muted font-bold">
          {rows.length ? "CLAIMED TERRITORY" : "UNCLAIMED TERRITORY"}
        </div>
        <div className="flex gap-2 text-muted">
          <button aria-label="Expand" title="Expand" className="hover:text-ink">⤢</button>
          <button aria-label="Close" title="Close" onClick={onClose} className="hover:text-ink">✕</button>
        </div>
      </div>
      <h2 className="text-[28px] font-extrabold leading-tight mt-1">
        {el.symbol} <span className="font-bold">{el.name}</span>
      </h2>

      {rows.length === 0 ? (
        <>
          <div className="text-xs font-bold text-money mt-1">BE THE FIRST · $5</div>
          <div className="mt-3 bg-icy rounded-2xl p-3 text-sm">
            <span className="font-extrabold">?</span> No bids yet — plant your flag for $5. Yours until someone outbids you.
          </div>
          <div className="mt-auto sticky bottom-0 bg-white pt-3">
            <ChunkyButton className="w-full text-sm px-5 h-12" onClick={() => onStake(el, 5)}>
              Be the first — from $5
            </ChunkyButton>
            <div className="text-center text-[11px] text-muted mt-1">plant your flag · rank is your total stake</div>
          </div>
        </>
      ) : (
        <>
          <div className="text-xs font-bold text-money mt-1 whitespace-nowrap">
            {rows.length} bidding · #1 pays ${top.amount}
          </div>
          <div className="mt-3 flex-1 overflow-auto flex flex-col gap-1 pr-1">
            {rows.map((r, i) => (
              <div
                key={r.domain}
                onMouseEnter={() => setHover(r.domain)}
                onMouseLeave={() => setHover(null)}
                className={`px-3 py-2 rounded-2xl ${i === 0 ? "bg-goldwash" : "hover:bg-icy"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs w-5 text-muted font-bold shrink-0">{i === 0 ? "👑" : `#${i + 1}`}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={r.logo} alt="" className="w-6 h-6 rounded-full shrink-0" />
                      <span className="text-sm font-bold truncate">{r.domain}</span>
                      <span className="ml-auto text-sm font-extrabold text-money whitespace-nowrap">${r.amount}</span>
                </div>
                <div className="text-xs text-muted truncate pl-7">{r.pitch}</div>
                {hover === r.domain && (
                  <div className="absolute left-0 -translate-x-[108%] top-24 w-64 bg-white rounded-card shadow-card p-3 z-[var(--z-preview)] hidden md:block">
                    <div className="bg-icy rounded-xl h-24 grid place-items-center text-xs text-muted">loading preview…</div>
                    <div className="mt-2 text-sm font-bold">{r.domain}</div>
                    <div className="text-xs text-muted">{r.pitch}</div>
                    <div className="text-xs mt-1">🔗 <span className="text-money font-bold">{r.domain}</span></div>
                    <div className="text-xs text-live font-bold">🟢 {r.clicks} clicks delivered</div>
                    <Link href={`/s/${encodeURIComponent(r.domain)}`} className="text-xs font-bold text-money">
                      View profile →
                    </Link>
                  </div>
                )}
              </div>
            ))}
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
