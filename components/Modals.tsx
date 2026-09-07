"use client";
import { useState } from "react";
import { Modal } from "./Modal";
import { ChunkyButton } from "./ChunkyButton";
import { IcyInput } from "./IcyInput";
import { MOCK_STAKES } from "../mocks/startups";
import type { ElementNode } from "../lib/elements";

export function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  const steps = [
    { icon: "🚩", bg: "#FFEFC1", t: "1 Claim", d: "Pick an open element and stake from $5. Your logo goes on the table instantly." },
    { icon: "📈", bg: "#E0F2FE", t: "2 Stake to climb", d: "Rank is your total stake. Top up anytime — past stake still counts." },
    { icon: "♻️", bg: "#DCFCE7", t: "3 Reclaim anytime", d: "Outbid? Pay only the difference back to #1. Never start over." },
  ];
  return (
    <Modal open={open} onClose={onClose} label="How claiming works">
      <h2 className="text-xl font-extrabold">How <span className="text-money">claiming</span> works 🧪</h2>
      <p className="text-sm text-muted mt-1">Every element is an open leaderboard, ranked by total stake.</p>
      <div className="mt-4 flex flex-col gap-2">
        {steps.map((s) => (
          <div key={s.t} className="bg-icy rounded-2xl p-3 flex gap-3 items-start">
            <div className="w-10 h-10 rounded-xl grid place-items-center text-lg shrink-0" style={{ background: s.bg }}>{s.icon}</div>
            <div>
              <div className="font-extrabold text-sm">{s.t}</div>
              <div className="text-sm text-muted">{s.d}</div>
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted mt-3">Periodic data: IUPAC Standard. Classifications are illustrative, not a chemical statement.</p>
      <ChunkyButton className="w-full mt-3 text-sm px-5 h-12" onClick={onClose}>Got it</ChunkyButton>
      <div className="text-center text-xs text-muted mt-2">About &amp; disclaimer · Rules &amp; payments</div>
    </Modal>
  );
}

export function CheckoutMock({
  el,
  open,
  amount,
  onAmount,
  onClose,
  onDone,
}: {
  el: ElementNode | null;
  open: boolean;
  amount: number;
  onAmount: (n: number) => void;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [tab, setTab] = useState<"url" | "social">("url");
  if (!el) return null;
  const top = MOCK_STAKES.filter((s) => s.symbol === el.symbol).sort((a, b) => b.amount - a.amount)[0];
  const need = top ? top.amount + 1 : 5;
  const badUrl = url.length > 0 && !/^https?:\/\/.+\..+/.test(url);
  return (
    <Modal open={open} onClose={onClose} label={`Stake on ${el.name}`}>
      <h2 className="text-xl font-extrabold">Stake on <span className="text-money">{el.name}</span> 🚩</h2>
      <p className="text-sm text-muted mt-1">Rank is your total stake. Past stake still counts — top up to climb.</p>
      <div className="mt-3 bg-icy rounded-full p-1 grid grid-cols-2 text-sm font-bold">
        {(["url", "social"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-full py-2 ${tab === t ? "bg-white shadow" : "text-muted"}`}>
            {t === "url" ? "🌐 Product URL" : "@ Social"}
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <IcyInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder={tab === "url" ? "https://yourstartup.com" : "@yourhandle"} />
        {badUrl && <div className="text-xs text-red-500">Enter a full URL starting with https://</div>}
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-muted">$</span>
          <IcyInput type="number" min={5} value={amount} onChange={(e) => onAmount(Number(e.target.value))} className="pl-8" />
        </div>
      </div>
      <div className="mt-2 text-sm font-extrabold">👑 ${need} takes #1 in {el.name}!</div>
      <ChunkyButton
        className="w-full mt-2 text-sm px-5 h-12"
        onClick={() => {
          if (badUrl) return;
          onDone(`Staked! You're #1 in ${el.symbol} 🎉`);
          onClose();
        }}
      >
        Continue to checkout →
      </ChunkyButton>
      <div className="text-xs text-muted mt-2 text-center">🔒 Secure payment via Whop · it&apos;s an ad buy, not a bet · <span className="text-money font-bold">rules &amp; terms</span></div>
      <button onClick={onClose} className="block mx-auto text-xs text-muted mt-2">maybe later</button>
    </Modal>
  );
}

export function BoardMock({ open, onClose, onOpen }: { open: boolean; onClose: () => void; onOpen: (symbol: string) => void }) {
  const [tab, setTab] = useState<"el" | "crowns" | "early">("el");
  const topBySymbol: Record<string, (typeof MOCK_STAKES)[number]> = {};
  for (const s of MOCK_STAKES) {
    const cur = topBySymbol[s.symbol];
    if (!cur || s.amount > cur.amount) topBySymbol[s.symbol] = s;
  }
  const byEl = Object.values(topBySymbol).sort((a, b) => b.amount - a.amount);
  const crowns: Record<string, { count: number; total: number }> = {};
  for (const s of Object.values(topBySymbol)) {
    const c = crowns[s.domain] ?? { count: 0, total: 0 };
    c.count += 1;
    c.total += s.amount;
    crowns[s.domain] = c;
  }
  const crownRows = Object.entries(crowns).sort((a, b) => b[1].count - a[1].count || b[1].total - a[1].total);
  const earlyRows = MOCK_STAKES.filter((s) => s.firstClaim);
  return (
    <Modal open={open} onClose={onClose} label="The board">
      <h2 className="text-xl font-extrabold">The <span className="text-money">board</span> 🏆</h2>
      <p className="text-sm text-muted mt-1">
        {tab === "el" && "Each startup's biggest stake — and the element it holds."}
        {tab === "crowns" && "Who holds the most #1 crowns across the table."}
        {tab === "early" && "First to plant a flag on each element."}
      </p>
      <div className="mt-3 bg-icy rounded-full p-1 grid grid-cols-3 text-xs font-bold">
        {([["el", "🧪 By Element"], ["crowns", "#1 Crowns"], ["early", "🏅 Early"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-full py-2 ${tab === k ? "bg-white shadow" : "text-muted"}`}>{label}</button>
        ))}
      </div>
      <div className="mt-3 flex flex-col gap-1 max-h-72 overflow-auto">
        {tab === "el" && byEl.map((s, i) => (
          <button key={s.domain + s.symbol} onClick={() => { onOpen(s.symbol); onClose(); }} className="flex items-center gap-2 px-3 py-2 rounded-2xl hover:bg-icy text-left">
            <span className="w-6 text-sm">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.logo} alt="" className="w-6 h-6 rounded-full" />
            <span className="text-sm font-bold">{s.domain}</span>
            <span className="text-xs text-muted">{s.symbol} {s.elementName}</span>
            <span className="ml-auto text-sm font-extrabold text-money whitespace-nowrap">${s.amount}</span>
          </button>
        ))}
        {tab === "crowns" && crownRows.map(([domain, c], i) => {
          const logo = MOCK_STAKES.find((s) => s.domain === domain)?.logo;
          return (
            <button key={domain} onClick={() => { onOpen(topBySymbol[Object.keys(topBySymbol).find((k) => topBySymbol[k].domain === domain)!].symbol); onClose(); }} className="flex items-center gap-2 px-3 py-2 rounded-2xl hover:bg-icy text-left">
              <span className="w-6 text-sm">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}</span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {logo && <img src={logo} alt="" className="w-6 h-6 rounded-full" />}
              <span className="text-sm font-bold">{domain}</span>
              <span className="text-xs text-muted whitespace-nowrap">👑 {c.count} {c.count === 1 ? "crown" : "crowns"} · ${c.total}</span>
              <span className="ml-auto text-sm font-extrabold text-money whitespace-nowrap">👑 {c.count}</span>
            </button>
          );
        })}
        {tab === "early" && earlyRows.map((s, i) => (
          <button key={s.domain + s.symbol} onClick={() => { onOpen(s.symbol); onClose(); }} className="flex items-center gap-2 px-3 py-2 rounded-2xl hover:bg-icy text-left">
            <span className="w-6 text-sm">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.logo} alt="" className="w-6 h-6 rounded-full" />
            <span className="text-sm font-bold">{s.domain}</span>
            <span className="text-xs text-muted">first on {s.symbol} {s.elementName}</span>
            <span className="ml-auto text-sm">🏅</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
