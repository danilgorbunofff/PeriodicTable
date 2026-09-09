"use client";
import { useState } from "react";
import useSWR from "swr";
import { ChunkyButton } from "./ChunkyButton";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";
import type { ElementNode } from "../lib/elements";
import { fetchJson, isElementDetail, type ElementDetail } from "../lib/api";
import { FAMILY_FILL } from "../lib/familyFill";
import { track } from "../lib/analytics";

type ReportState = { domain: string; state: "pending" | "done" | "error" } | null;

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
  // Confirm-before-report: the report button only arms this state; nothing
  // is sent until the user confirms in the modal (no accidental reports).
  const [confirm, setConfirm] = useState<{ stakeId: string; domain: string } | null>(null);
  const top = rows[0];
  const takeLead = data?.prices.takeLead ?? (top ? top.amount + 1 : 5);
  const joinMin = data?.prices.joinMin ?? 5;
  const totalStaked = data?.pool ?? 0;
  // Every element (standard + exotic) links to its Wikipedia article.
  // Titles are single capitalized words ("Carbon") except "Dark Matter" →
  // canonical article "Dark matter" (exact casing, no redirect hop).
  const WIKI_OVERRIDES: Record<string, string> = { DM: "Dark_matter" };
  const wikiUrl = `https://en.wikipedia.org/wiki/${WIKI_OVERRIDES[el.symbol] ?? el.name.replace(/ /g, "_")}`;

  async function sendReport(stakeId: string, domain: string) {    if (report?.domain === domain && report.state === "pending") return;
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
          className="-mx-6 -mt-6 mb-4 relative flex shrink-0 items-start gap-3 px-6 pt-6 pb-5"
          style={{ background: "linear-gradient(180deg,#FFEFC1,#FFCE4B)" }}
        >
          <div
            className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-xl font-display font-bold shadow-card"
            style={{ background: FAMILY_FILL[el.family] ?? "#fff" }}
          >
            {el.symbol}
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-[11px] tracking-widest font-extrabold uppercase text-ink/60">
              {rows.length ? "CLAIMED ELEMENT" : "OPEN ELEMENT"}
            </div>
            <h2 className="mt-0.5 font-display text-[27px] leading-none font-bold text-ink">
              {el.symbol} {el.name}
              <a
                href={wikiUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`About ${el.name} on Wikipedia`}
                title={`About ${el.name} on Wikipedia`}
                className="ml-2 inline-grid h-7 w-7 place-items-center rounded-full bg-icy align-middle font-serif text-[13px] font-bold text-mutedink hover:text-ink"
              >
                W
              </a>
            </h2>
            <div className="mt-1.5 text-xs font-extrabold text-ink/70 whitespace-nowrap">
              {rows.length ? `${rows.length} bidding · $${totalStaked} staked` : "no bids yet · $5 to be the first"}
            </div>
          </div>
          <button
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/85 text-mutedink hover:text-ink [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px]"
          >
            ✕
          </button>
        </div>
      ) : (
        <div className="flex items-start justify-between">
          <div className="text-[11px] tracking-widest text-mutedink font-bold">
            {rows.length ? "CLAIMED ELEMENT" : "OPEN ELEMENT"}
          </div>
          <div className="flex gap-1.5">
            {onExpand && (
              <button aria-label="Expand" title="Expand" onClick={onExpand} className="grid h-7 w-7 place-items-center rounded-full bg-icy text-mutedink hover:text-ink [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px]">⤢</button>
            )}
            <button aria-label="Close" title="Close" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-full bg-icy text-mutedink hover:text-ink [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px]">✕</button>
          </div>
        </div>
      )}
      {!expanded && (
        <h2 className="font-display text-[28px] font-bold leading-tight mt-1 flex items-center">
          <span
            className="mr-2 inline-grid h-9 w-9 shrink-0 place-items-center rounded-xl font-display text-base font-bold text-ink"
            style={{ background: FAMILY_FILL[el.family] ?? "#fff" }}
          >
            {el.symbol}
          </span>
          <span className="font-semibold">{el.name}</span>
          <a
            href={wikiUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`About ${el.name} on Wikipedia`}
            title={`About ${el.name} on Wikipedia`}
            className="ml-2 inline-flex h-7 items-center gap-1.5 rounded-full bg-icy pl-1.5 pr-2.5 align-middle text-[11px] font-bold text-mutedink hover:text-ink"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wikipedia-globe.png" alt="" aria-hidden="true" className="h-5 w-5 object-contain" />
            Wiki
          </a>
        </h2>
      )}

      {loading ? (
        <div className="flex-1 flex flex-col gap-1 mt-3" role="status" aria-label="Loading element">
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
            <span className="font-extrabold">?</span> No bids yet — ${joinMin} puts your logo here until someone outbids you.
          </div>
          <div className="mt-auto sticky bottom-0 bg-white pt-3">
            <ChunkyButton className="w-full text-sm px-5 h-12" onClick={() => onStake(el, joinMin)}>
              Be the first — from ${joinMin}
            </ChunkyButton>
            <div className="text-center text-[11px] text-mutedink mt-1">rank is your total stake</div>
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
              <div
                key={r.domain}
                className={`relative block px-3 py-2 rounded-2xl transition-colors ${rankBg}`}
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
                    onClick={() => {
                      if (report?.domain === r.domain && report.state === "pending") return;
                      setConfirm({ stakeId: r.stakeId, domain: r.domain });
                    }}
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
      <Modal open={confirm !== null} onClose={() => setConfirm(null)} label="Confirm report" size="md">
        <h2 className="font-display text-xl font-bold pr-10">Report {confirm?.domain}?</h2>
        <p className="text-sm text-mutedink mt-2">
          This flags the listing for operator review (phishing, trademark, malware).
          Stakes and payments are never touched — only visibility is reviewed.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={() => setConfirm(null)}
            className="h-11 px-5 rounded-full bg-icy text-sm font-bold text-ink hover:bg-hairline [@media(pointer:coarse)]:min-h-[44px]"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (confirm) sendReport(confirm.stakeId, confirm.domain);
              setConfirm(null);
            }}
            className="h-11 px-5 rounded-full bg-ink text-sm font-bold text-white [@media(pointer:coarse)]:min-h-[44px]"
          >
            Report listing
          </button>
        </div>
      </Modal>
    </div>
  );
}
