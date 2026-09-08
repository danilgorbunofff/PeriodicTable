"use client";
import { useRef, useState } from "react";
import useSWR from "swr";
import { ChunkyButton } from "./ChunkyButton";
import { Avatar } from "./Avatar";
import type { ElementNode } from "../lib/elements";
import { fetchJson, isElementDetail, type ElementDetail } from "../lib/api";
import { FAMILY_FILL } from "../lib/familyFill";
import { previewFor, faviconFor } from "../lib/screenshots";
import { track } from "../lib/analytics";

type ReportState = { domain: string; state: "pending" | "done" | "error" } | null;

export function TerritoryView({
  el,
  onClose,
  onStake,
  onExpand,
  onMinimize,
  expanded,
}: {
  el: ElementNode;
  onClose: () => void;
  onStake: (el: ElementNode, amount: number) => void;
  onExpand?: () => void;
  /** Desktop rail: collapse the rail into its round FAB. */
  onMinimize?: () => void;
  /** Rendered inside the fullscreen-ish expand overlay: drop own header controls, Modal supplies the close affordance. */
  expanded?: boolean;
}) {
  const { data, error, mutate } = useSWR<ElementDetail>(`/api/elements/${el.symbol}`, (url: string) =>
    fetchJson(url, isElementDetail)
  , {
    refreshInterval: 30000,
  });
  const loading = !data && !error;
  // P1-08: failure is NEVER rendered as business state. Error without data
  // gets an error panel — never the unclaimed CTA.
  const rows = data?.stakes ?? [];
  const [report, setReport] = useState<ReportState>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const top = rows[0];
  const takeLead = data?.prices.takeLead ?? (top ? top.amount + 1 : 5);
  const joinMin = data?.prices.joinMin ?? 5;
  const totalStaked = data?.pool ?? 0;

  async function sendReport(stakeId: string, domain: string) {
    if (report?.domain === domain && report.state === "pending") return;
    setReport({ domain, state: "pending" });
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stakeId, reason: "reported from drawer" }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      // P2-04: confirm ONLY a persisted report; surface failure honestly.
      setReport({ domain, state: res.ok && json?.ok ? "done" : "error" });
    } catch {
      setReport({ domain, state: "error" });
    }
  }

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
          <div className="text-[11px] tracking-widest text-mutedink font-bold">
            {rows.length ? "CLAIMED TERRITORY" : "UNCLAIMED TERRITORY"}
          </div>
          <div className="flex gap-1.5">
            {onMinimize && (
              <button aria-label="Minimize" title="Minimize" onClick={onMinimize} className="grid h-7 w-7 place-items-center rounded-full bg-icy text-mutedink hover:text-ink [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px]">
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            )}
            {onExpand && (
              <button aria-label="Expand" title="Expand" onClick={onExpand} className="grid h-7 w-7 place-items-center rounded-full bg-icy text-mutedink hover:text-ink [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px]">⤢</button>
            )}
            <button aria-label="Close" title="Close" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-full bg-icy text-mutedink hover:text-ink [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px]">✕</button>
          </div>
        </div>
      )}
      {!expanded && (
        <h2 className="font-display text-[28px] font-bold leading-tight mt-1">
          {el.symbol} <span className="font-semibold">{el.name}</span>
        </h2>
      )}

      {loading ? (
        <div className="flex-1 flex flex-col gap-1 mt-3" role="status" aria-label="Loading territory">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-[52px] rounded-2xl bg-icy animate-pulse" />)}
        </div>
      ) : error && !data ? (
        <div className="mt-3 rounded-2xl bg-icy p-4 text-center" role="alert">
          <div className="text-sm font-extrabold">Couldn&apos;t load {el.symbol}.</div>
          <div className="text-xs text-mutedink mt-1">Live standings are unreachable — nothing here can be bought right now.</div>
          <button className="mt-2 text-xs font-extrabold underline" onClick={() => mutate()}>Retry</button>
        </div>
      ) : rows.length === 0 ? (
        <>
          <div className="text-xs font-bold text-moneyink mt-1">BE THE FIRST · ${joinMin}</div>
          <div className="mt-3 bg-icy rounded-2xl p-3 text-sm">
            <span className="font-extrabold">?</span> No bids yet — plant your flag for ${joinMin}. Yours until someone outbids you.
          </div>
          <div className="mt-auto sticky bottom-0 bg-white pt-3">
            <ChunkyButton className="w-full text-sm px-5 h-12" onClick={() => onStake(el, joinMin)}>
              Be the first — from ${joinMin}
            </ChunkyButton>
            <div className="text-center text-[11px] text-mutedink mt-1">plant your flag · rank is your total stake</div>
          </div>
        </>
      ) : (
        <>
          {!expanded && (
            <div className="text-xs font-bold text-moneyink mt-1 whitespace-nowrap">
              {rows.length} bidding · #1 pays ${top.amount}
            </div>
          )}
          <div className={`flex-1 overflow-auto flex flex-col gap-1 pr-1 ${expanded ? "" : "mt-3"}`}>
            {rows.map((r, i) => {
              // Podium: top-3 rows carry gold/silver/bronze washes + medal
              // badges; hover deepens their OWN rank color (never a cool-gray
              // step that reads as "rows below are dimmed"). #4+ unchanged.
              const rankBg =
                i === 0
                  ? "bg-goldwash hover:bg-golddeep"
                  : i === 1
                    ? "bg-silverwash hover:bg-silverdeep"
                    : i === 2
                      ? "bg-bronzewash hover:bg-bronzedeep"
                      : "hover:bg-icy";
              const badgeBg = i === 0 ? "bg-medalgold" : i === 1 ? "bg-medalsilver" : i === 2 ? "bg-medalbronze" : "bg-sale";
              return (
              // Bidder actions are siblings, never nested (P2-10): the domain
              // opens the profile, Visit counts the click, Report moderates.
              // Preview is pure CSS (group-hover) + silent prefetch — no
              // setState on hover, so the list never re-renders under the mouse.
              <div
                key={r.domain}
                className={`group relative block px-3 py-2 rounded-2xl transition-colors ${rankBg}`}
                onMouseEnter={() => {
                  if (hoverTimer.current) clearTimeout(hoverTimer.current);
                  // Prefetch preview on row hover (debounce 150ms per spec).
                  hoverTimer.current = setTimeout(() => {
                    const src = previewFor({ previewImgUrl: r.preview, url: r.siteUrl, domain: r.domain });
                    const img = new Image();
                    img.src = src;
                  }, 150);
                }}
                onMouseLeave={() => {
                  if (hoverTimer.current) clearTimeout(hoverTimer.current);
                }}
              >
                <div className="flex items-center gap-2">
                  <span className={`grid h-7 min-w-[30px] shrink-0 place-items-center rounded-lg ${badgeBg} text-[11px] font-extrabold text-ink`}>#{i + 1}</span>
                  <Avatar src={r.logo} domain={r.domain} size={24} rounded="rounded-full" />
                  <a
                    href={`/s/${encodeURIComponent(r.domain)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-bold text-ink truncate hover:underline"
                  >
                    {r.domain}
                  </a>
                  <span className="ml-auto text-sm font-extrabold text-moneyink whitespace-nowrap">${r.amount}</span>
                </div>
                <div className="text-xs text-mutedink truncate pl-[38px]">{r.pitch}</div>
                <div className="pl-[38px] mt-0.5 flex items-center gap-2">
                  <span className="text-[11px] text-liveink font-bold">🟢 {r.clicks} clicks delivered</span>
                  <a
                    href={r.stakeId ? `/go/${r.stakeId}` : `/s/${encodeURIComponent(r.domain)}`}
                    target="_blank"
                    rel="sponsored nofollow noopener"
                    onClick={() => track("go_click", { element: el.symbol, domain: r.domain })}
                    className="text-[11px] font-bold text-moneyink hover:underline"
                  >
                    Visit →
                  </a>
                  <button
                    aria-label={`Report ${r.domain}`}
                    title="Report listing"
                    disabled={report?.domain === r.domain && report.state === "pending"}
                    onClick={() => sendReport(r.stakeId, r.domain)}
                    className="text-[11px] text-mutedink hover:text-ink underline disabled:no-underline"
                  >
                    {report?.domain === r.domain
                      ? report.state === "pending"
                        ? "reporting…"
                        : report.state === "done"
                          ? "reported ✓"
                          : "failed — retry?"
                      : "report"}
                  </button>
                </div>
                <div
                  className="absolute left-0 -translate-x-[108%] top-0 w-64 bg-white rounded-card shadow-card p-3 z-[var(--z-preview)] hidden md:block opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
                  aria-hidden="true"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewFor({ previewImgUrl: r.preview, url: r.siteUrl, domain: r.domain })}
                    alt=""
                    loading="lazy"
                    sizes="256px"
                    onError={(e) => {
                      const t = e.currentTarget;
                      if (!t.src.includes("s2/favicons")) t.src = faviconFor(r.domain, 128);
                    }}
                    className="rounded-xl h-24 w-full object-cover bg-icy"
                  />
                  <div className="mt-2 text-sm font-bold">{r.domain}</div>
                  <div className="text-xs text-mutedink">{r.pitch}</div>
                  <div className="text-xs mt-1">🔗 <span className="text-moneyink font-bold">{r.domain}</span></div>
                  <div className="text-xs text-liveink font-bold">🟢 {r.clicks} clicks delivered</div>
                  <a href={`/s/${encodeURIComponent(r.domain)}`} target="_blank" rel="noopener noreferrer" className="text-xs font-bold text-moneyink hover:underline">
                    View profile →
                  </a>
                </div>
              </div>
              );
            })}
            {error && (
              <div className="rounded-2xl bg-icy p-3 text-sm font-bold text-mutedink">
                Showing cached standings —{" "}
                <button className="underline font-extrabold" onClick={() => mutate()}>retry</button>
              </div>
            )}
          </div>
          <div className="sticky bottom-0 bg-white pt-2">
            <ChunkyButton className="w-full text-sm px-5 h-12" onClick={() => onStake(el, takeLead)}>
              Claim a spot — for ${takeLead}
            </ChunkyButton>
            <div className="text-center text-[11px] text-mutedink mt-1">rank is your total stake · top up to climb</div>
          </div>
        </>
      )}
      <div className="mt-2 text-[11px] text-mutedink">IUPAC Standard</div>
    </div>
  );
}
