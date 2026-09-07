"use client";
import { useState } from "react";
import useSWR from "swr";
import { Modal } from "./Modal";
import { ChunkyButton } from "./ChunkyButton";
import { IcyInput } from "./IcyInput";
import { Avatar } from "./Avatar";
import { fetcher, type BoardRow, type ElementDetail } from "../lib/api";
import { validateTopUp } from "../lib/pricing";
import { domainFromUrl, domainFromSocial } from "../lib/validate";
import type { ElementNode } from "../lib/elements";

export function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  const steps = [
    { icon: "🚩", bg: "#FFEFC1", t: "1 Claim", d: "Pick an open element and stake from $5. Your logo goes on the table instantly." },
    { icon: "📈", bg: "#E0F2FE", t: "2 Stake to climb", d: "Rank is your total stake. Top up anytime — past stake still counts." },
    { icon: "♻️", bg: "#DCFCE7", t: "3 Reclaim anytime", d: "Outbid? Pay only the difference back to #1. Never start over." },
  ];
  return (
    <Modal open={open} onClose={onClose} label="How claiming works">
      <h2 className="font-display text-xl font-bold">How <span className="text-money">claiming</span> works 🧪</h2>
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
  const [email, setEmail] = useState("");
  const [tab, setTab] = useState<"url" | "social">("url");
  const [submitting, setSubmitting] = useState(false);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const { data } = useSWR<ElementDetail>(open && el ? `/api/elements/${el.symbol}` : null, fetcher);
  const elSafe = el;
  if (!elSafe) return null;
  const elSymbol = elSafe.symbol;
  const leaderTotal = data?.stakes[0]?.amount;
  const need = data?.prices.takeLead ?? amount;
  const badUrl = url.length > 0 && !/^https?:\/\/.+\..+/.test(url);
  const badEmail = email.length > 0 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const domain = tab === "url" && url.includes("://") ? domainFromUrl(url) : tab === "social" && url.startsWith("@") ? domainFromSocial(url) : null;
  const isNewHere = !domain || !data?.stakes.some((s) => s.domain === domain);
  const clientErr = validateTopUp(amount, isNewHere ? undefined : leaderTotal, isNewHere);

  async function submit() {
    if (badUrl || badEmail || !domain || clientErr || submitting) return;
    setSubmitting(true);
    setServerErr(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elementSym: elSymbol,
          amountUsd: Math.round(amount),
          email: email || undefined,
          path: isNewHere ? "join" : "stake",
          idempotencyKey: `ck-${elSymbol}-${domain}-${Date.now()}`,
          startup: {
            url: tab === "url" ? url : `https://${domain}`,
            linkType: tab,
            domain,
            title: domain,
            pitch: "",
          },
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.checkoutUrl) {
        setServerErr(json.error ?? "Something went wrong. Try again.");
        setSubmitting(false);
        return;
      }
      window.location.href = json.checkoutUrl as string;
    } catch {
      setServerErr("Network error. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} label={`Stake on ${el.name}`}>
      <h2 className="font-display text-xl font-bold">Stake on <span className="text-money">{el.name}</span> 🚩</h2>
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
        <IcyInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@startup.com (for your receipt + outbid alerts)" />
        {badEmail && <div className="text-xs text-red-500">That email doesn&apos;t look right.</div>}
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-muted">$</span>
          <IcyInput type="number" min={1} value={amount} onChange={(e) => onAmount(Number(e.target.value))} className="pl-8" />
        </div>
      </div>
      <div className="mt-2 text-sm font-extrabold">👑 ${need} takes #1 in {el.name}!</div>
      <div className="mt-1 text-xs text-muted">Any amount $5+ works — ${need} is just the minimum to grab #1 right now.</div>
      <div className="mt-1.5 flex gap-1.5">
        {[10, 25, 50].map((p) => (
          <button
            key={p}
            onClick={() => onAmount(Math.max(p, need))}
            className="flex-1 rounded-xl bg-icy py-1.5 text-xs font-extrabold text-ink hover:bg-goldwash"
          >
            ${Math.max(p, need)}
          </button>
        ))}
      </div>
      {clientErr && <div className="mt-2 text-xs text-red-500 font-bold">{clientErr}</div>}
      {serverErr && <div className="mt-2 text-xs text-red-500 font-bold">{serverErr}</div>}
      <ChunkyButton
        className="w-full mt-2 text-sm px-5 h-12"
        disabled={submitting}
        onClick={submit}
      >
        {submitting ? "Starting checkout…" : "Continue to checkout →"}
      </ChunkyButton>
      <div className="text-xs text-muted mt-2 text-center">🔒 Secure payment via Whop · it&apos;s an ad buy, not a bet · <span className="text-money font-bold">rules &amp; terms</span></div>
      <button onClick={onClose} className="block mx-auto text-xs text-muted mt-2">maybe later</button>
    </Modal>
  );
}

export function BoardMock({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"el" | "crowns" | "early">("el");
  const apiTab = tab === "el" ? "by-element" : tab;
  const { data: rows, error } = useSWR<BoardRow[]>(open ? `/api/board?tab=${apiTab}` : null, fetcher);
  return (
    <Modal open={open} onClose={onClose} label="The board">
      <h2 className="font-display text-xl font-bold">The <span className="text-money">board</span> 🏆</h2>
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
        {error && (
          <div className="rounded-2xl bg-icy p-3 text-sm font-bold text-muted">Couldn&apos;t load the board.</div>
        )}
        {!rows && !error
          ? [0, 1, 2, 3, 4].map((i) => <div key={i} className="h-[44px] rounded-2xl bg-icy animate-pulse" />)
          : null}
        {tab === "el" && rows?.map((row, i) => (
          <a key={row.domain + row.elementSym} href={`/s/${encodeURIComponent(row.domain)}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 rounded-2xl hover:bg-icy text-left no-underline">
            <span className="w-6 text-sm">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}</span>
            <Avatar src={row.logoUrl} domain={row.domain} size={24} rounded="rounded-full" />
            <span className="text-sm font-bold text-ink">{row.domain}</span>
            <span className="text-xs text-muted">{row.elementSym} {row.elementName}</span>
            <span className="ml-auto text-sm font-extrabold text-money whitespace-nowrap">${row.total}</span>
          </a>
        ))}
        {tab === "crowns" && rows?.map((row, i) => (
          <a key={row.domain} href={`/s/${encodeURIComponent(row.domain)}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 rounded-2xl hover:bg-icy text-left no-underline">
            <span className="w-6 text-sm">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}</span>
            <Avatar src={row.logoUrl} domain={row.domain} size={24} rounded="rounded-full" />
            <span className="text-sm font-bold text-ink">{row.domain}</span>
            <span className="text-xs text-muted whitespace-nowrap">👑 {row.total} {row.total === 1 ? "crown" : "crowns"} · ${row.totalSpent ?? 0}</span>
            <span className="ml-auto text-sm font-extrabold text-money whitespace-nowrap">👑 {row.total}</span>
          </a>
        ))}
        {tab === "early" && rows?.map((row, i) => (
          <a key={row.domain + row.elementSym} href={`/s/${encodeURIComponent(row.domain)}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 rounded-2xl hover:bg-icy text-left no-underline">
            <span className="w-6 text-sm">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}</span>
            <Avatar src={row.logoUrl} domain={row.domain} size={24} rounded="rounded-full" />
            <span className="text-sm font-bold text-ink">{row.domain}</span>
            <span className="text-xs text-muted">first on {row.elementSym} {row.elementName}</span>
            <span className="ml-auto text-sm">🏅</span>
          </a>
        ))}
      </div>
    </Modal>
  );
}
