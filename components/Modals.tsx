"use client";
import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Modal } from "./Modal";
import { ChunkyButton } from "./ChunkyButton";
import { IcyInput } from "./IcyInput";
import { Avatar } from "./Avatar";
import { fetchJson, isBoardRows, isElementDetail, type BoardRow, type ElementDetail } from "../lib/api";
import { classifyAndValidate } from "../lib/pricing";
import { domainFromUrl, domainFromSocial } from "../lib/validate";
import { paymentsLiveClient } from "../lib/flags";
import { track } from "../lib/analytics";
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
      <p className="text-sm text-mutedink mt-1">Every element is an open leaderboard, ranked by total stake.</p>
      <div className="mt-4 flex flex-col gap-2">
        {steps.map((s) => (
          <div key={s.t} className="bg-icy rounded-2xl p-3 flex gap-3 items-start">
            <div className="w-10 h-10 rounded-xl grid place-items-center text-lg shrink-0" style={{ background: s.bg }}>{s.icon}</div>
            <div>
              <div className="font-extrabold text-sm">{s.t}</div>
              <div className="text-sm text-mutedink">{s.d}</div>
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-mutedink mt-3">Periodic data: IUPAC Standard. Classifications are illustrative, not a chemical statement.</p>
      <ChunkyButton className="w-full mt-3 text-sm px-5 h-12" onClick={onClose}>Got it</ChunkyButton>
      <div className="text-center text-xs text-mutedink mt-2">About &amp; disclaimer · Rules &amp; payments</div>
    </Modal>
  );
}

export function CheckoutPreview({
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
  const [title, setTitle] = useState("");
  const [pitch, setPitch] = useState("");
  const [email, setEmail] = useState("");
  const [tab, setTab] = useState<"url" | "social">("url");
  const [attest, setAttest] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const [serverField, setServerField] = useState<{ field: string; message: string } | null>(null);
  const [priceMoved, setPriceMoved] = useState<number | null>(null);
  const [waitErr, setWaitErr] = useState<string | null>(null);
  const [waitBusy, setWaitBusy] = useState(false);
  const { data } = useSWR<ElementDetail>(open && el ? `/api/elements/${el.symbol}` : null, (url: string) =>
    fetchJson(url, isElementDetail)
  );
  const elSafe = el;
  if (!elSafe) return null;
  const elSymbol = elSafe.symbol;
  const leaderTotal = data?.stakes[0]?.amount;
  const need = data?.prices.takeLead ?? amount;
  const badUrl = url.length > 0 && !/^https?:\/\/.+\..+/.test(tab === "url" ? url : `https://x.com/${url.replace(/^@/, "")}`);
  const badEmail = email.length > 0 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const badTitle = title.length > 0 && (title.trim().length < 2 || title.trim().length > 32);
  const badPitch = pitch.length > 0 && (pitch.trim().length < 2 || pitch.trim().length > 140);
  const domain =
    tab === "url"
      ? url.includes("://")
        ? domainFromUrl(url)
        : null
      : url.startsWith("@")
        ? domainFromSocial(url)
        : null;
  const effectiveTitle = title.trim() || domain || "";
  const effectivePitch = pitch.trim() || `Staked on ${elSafe.name}`;
  const isNewHere = !domain || !data?.stakes.some((s) => s.domain === domain);
  // Client-side preview of the server rule (Phase 3 classifyAndValidate);
  // the server re-validates authoritatively under lock.
  const stakeTotals = (data?.stakes ?? []).map((s) => s.amount);
  const myPriorTotal = !domain ? 0 : (data?.stakes.find((s) => s.domain === domain)?.amount ?? 0);
  const classified = classifyAndValidate({
    amount: Math.round(amount) || 0,
    leaderTotal,
    isNewHere,
    myPriorTotal,
    existingTotals: stakeTotals,
  });
  const clientErr = classified.ok ? null : classified.error;
  const paused = !paymentsLiveClient();

  async function joinWaitlist() {
    if (waitBusy) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setWaitErr("Enter a valid email so we can reach you.");
      return;
    }
    setWaitBusy(true);
    setWaitErr(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, source: "checkout-paused" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setWaitErr((json as { error?: string }).error ?? "Something went wrong. Try again.");
        setWaitBusy(false);
        return;
      }
      onDone("You're on the waitlist — we'll be in touch.");
      onClose();
    } catch {
      setWaitErr("Network error. Try again.");
      setWaitBusy(false);
    }
  }

  async function submit() {
    if (badUrl || badEmail || badTitle || badPitch || !domain || !attest || clientErr || submitting) return;
    track("checkout_start", { element: elSymbol, amount: Math.round(amount) });
    setSubmitting(true);
    setServerErr(null);
    setServerField(null);
    setPriceMoved(null);
    try {
      const turnstileToken =
        (typeof document !== "undefined" &&
          (document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]')?.value || undefined)) ||
        undefined;
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elementSym: elSymbol,
          amountUsd: Math.round(amount),
          email: email || undefined,
          path: isNewHere ? "join" : "stake",
          honeypot: honeypot || undefined,
          attest,
          turnstileToken,
          idempotencyKey:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `ck-${elSymbol}-${domain}-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
          startup: {
            url: tab === "url" ? url : `https://${domain}`,
            linkType: tab === "url" ? "product" : "social",
            domain,
            title: effectiveTitle.slice(0, 32),
            pitch: effectivePitch.slice(0, 140),
          },
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.checkoutUrl) {
        // Stale quote: server returns live takeLead so we can offer "continue?" at the new price.
        if (res.status === 409 && typeof json.takeLead === "number") {
          setPriceMoved(json.takeLead);
          setServerErr(json.error ?? "Price moved. Review the new minimum.");
        } else if (json.code === "RESERVATION_CONFLICT" && json.expiresAt) {
          const heldUntil = new Date(json.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          setServerErr(`${json.error ?? "This element has a held take quote."} Held until ${heldUntil}.`);
        } else if (typeof json.field === "string" && typeof json.error === "string") {
          // Field-specific server feedback renders under its input (Phase 5).
          setServerField({ field: json.field, message: json.error });
          setServerErr(null);
        } else {
          setServerErr(json.error ?? "Something went wrong. Try again.");
        }
        onDone(json.error ?? "Checkout failed — retry when ready.");
        setSubmitting(false);
        return;
      }
      window.location.href = json.checkoutUrl as string;
    } catch {
      setServerErr("Network error. Try again.");
      onDone("Network error — retry checkout.");
      setSubmitting(false);
    }
  }

  if (paused) {
    // Payments paused: waitlist ONLY — no checkout controls (release gate 7).
    return (
      <Modal open={open} onClose={onClose} label={`Stake on ${el.name}`}>
        <h2 className="font-display text-xl font-bold">Stake on <span className="text-money">{el.name}</span> 🚩</h2>
        <div className="mt-3 rounded-2xl bg-icy p-4 text-center">
          <div className="text-sm font-extrabold">Payments are paused — join the waitlist.</div>
          <div className="text-xs text-mutedink mt-1">We&apos;ll email you when staking reopens. Your spot in line is kept.</div>
          <form
            className="mt-3 text-left"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              joinWaitlist();
            }}
          >
            <label htmlFor="wl-email" className="mb-1 block text-[11px] font-extrabold text-mutedink">Email</label>
            <IcyInput id="wl-email" name="wl-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@startup.com" aria-invalid={!!waitErr} aria-describedby={waitErr ? "wl-email-error" : undefined} />
            {waitErr && <div id="wl-email-error" className="mt-2 text-xs text-red-500 font-bold">{waitErr}</div>}
            <ChunkyButton type="submit" className="w-full mt-3 text-sm px-5 h-12" disabled={waitBusy}>
              {waitBusy ? "Joining…" : "Join waitlist"}
            </ChunkyButton>
          </form>
        </div>
        <button onClick={onClose} className="block mx-auto text-xs text-mutedink mt-2">maybe later</button>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} label={`Stake on ${el.name}`}>
      <h2 className="font-display text-xl font-bold">Stake on <span className="text-money">{el.name}</span> 🚩</h2>
      <p className="text-sm text-mutedink mt-1">Rank is your total stake. Past stake still counts — top up to climb.</p>
      {/* Polite announcements for async checkout states (Phase 5): submitting,
          price moves, and server errors — focus itself never moves. */}
      <div role="status" aria-live="polite" className="sr-only">
        {submitting ? "Starting checkout…" : serverErr ?? (serverField ? serverField.message : priceMoved != null ? `Price moved to $${priceMoved}.` : "")}
      </div>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
      <div className="mt-3 bg-icy rounded-full p-1 grid grid-cols-2 text-sm font-bold" role="group" aria-label="Link type">
        {(["url", "social"] as const).map((t) => (
          <button key={t} type="button" aria-pressed={tab === t} onClick={() => { setTab(t); setServerField(null); }} className={`rounded-full py-2 [@media(pointer:coarse)]:min-h-[44px] ${tab === t ? "bg-white shadow" : "text-mutedink"}`}>
            {t === "url" ? "🌐 Product URL" : "@ Social"}
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <div>
          <label htmlFor="co-url" className="mb-1 block text-[11px] font-extrabold text-mutedink">
            {tab === "url" ? "Product URL" : "Social handle"}
          </label>
          <IcyInput
            id="co-url" name="co-url" required
            value={url}
            onChange={(e) => { setUrl(e.target.value); setServerField(null); }}
            placeholder={tab === "url" ? "https://yourstartup.com" : "@yourhandle"}
            aria-invalid={badUrl || serverField?.field === "url"}
            aria-describedby={badUrl || serverField?.field === "url" ? "co-url-error" : undefined}
          />
          {badUrl && <div id="co-url-error" className="text-xs text-red-500">Enter a full URL starting with https://</div>}
          {serverField?.field === "url" && <div id="co-url-error" className="text-xs text-red-500 font-bold">{serverField.message}</div>}
        </div>
        <div>
          <label htmlFor="co-title" className="mb-1 block text-[11px] font-extrabold text-mutedink">Startup name</label>
          <IcyInput
            id="co-title" name="co-title" required
            value={title}
            onChange={(e) => { setTitle(e.target.value); setServerField(null); }}
            placeholder="Startup name (2–32 chars)"
            maxLength={32}
            aria-invalid={badTitle || serverField?.field === "title"}
            aria-describedby={badTitle || serverField?.field === "title" ? "co-title-error" : undefined}
          />
          {badTitle && <div id="co-title-error" className="text-xs text-red-500">Name must be 2–32 characters.</div>}
          {serverField?.field === "title" && <div id="co-title-error" className="text-xs text-red-500 font-bold">{serverField.message}</div>}
        </div>
        <div>
          <label htmlFor="co-pitch" className="mb-1 block text-[11px] font-extrabold text-mutedink">One-line pitch</label>
          <IcyInput
            id="co-pitch" name="co-pitch" required
            value={pitch}
            onChange={(e) => { setPitch(e.target.value); setServerField(null); }}
            placeholder="One-line pitch (2–140 chars)"
            maxLength={140}
            aria-invalid={badPitch || serverField?.field === "pitch"}
            aria-describedby={badPitch || serverField?.field === "pitch" ? "co-pitch-error" : undefined}
          />
          {badPitch && <div id="co-pitch-error" className="text-xs text-red-500">Pitch must be 2–140 characters.</div>}
          {serverField?.field === "pitch" && <div id="co-pitch-error" className="text-xs text-red-500 font-bold">{serverField.message}</div>}
        </div>
        <div>
          <label htmlFor="co-email" className="mb-1 block text-[11px] font-extrabold text-mutedink">Email for receipt + outbid alerts</label>
          <IcyInput
            id="co-email" name="co-email" type="email" autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@startup.com"
            aria-invalid={badEmail}
            aria-describedby={badEmail ? "co-email-error" : undefined}
          />
          {badEmail && <div id="co-email-error" className="text-xs text-red-500">That email doesn&apos;t look right.</div>}
        </div>
        <div>
          <label htmlFor="co-amount" className="mb-1 block text-[11px] font-extrabold text-mutedink">Stake amount (whole dollars)</label>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-mutedink">$</span>
            <IcyInput id="co-amount" name="co-amount" type="number" min={1} required value={amount} onChange={(e) => onAmount(Number(e.target.value))} className="pl-8" />
          </div>
        </div>
      </div>
      <div className="mt-2 text-sm font-extrabold">👑 ${need} takes #1 in {el.name}!</div>
      <div className="mt-1 text-xs text-mutedink">Any amount $5+ works — ${need} is just the minimum to grab #1 right now.{isNewHere && leaderTotal != null ? " Your take quote is held for 15 min once you continue." : ""}</div>
      {priceMoved != null && (
        <div className="mt-2 rounded-2xl bg-goldwash p-3 text-xs font-bold">
          Price moved to ${priceMoved} — continue?
          <button className="ml-2 underline" onClick={() => { onAmount(priceMoved); setPriceMoved(null); setServerErr(null); }}>
            Use ${priceMoved}
          </button>
        </div>
      )}
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
      <input
        type="text"
        value={honeypot}
        onChange={(e) => setHoneypot(e.target.value)}
        className="hidden"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        name="website"
      />
      <label className="mt-2 flex items-start gap-2 text-xs text-mutedink">
        <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} className="mt-0.5" />
        <span>I own or may promote this URL. No refunds/withdrawals — stake = ad inventory.</span>
      </label>
      {process.env.NEXT_PUBLIC_TURNSTILE_SITEKEY ? (
        <div
          className="cf-turnstile mt-2"
          data-sitekey={process.env.NEXT_PUBLIC_TURNSTILE_SITEKEY}
        />
      ) : null}
      <ChunkyButton
        type="submit"
        className="w-full mt-2 text-sm px-5 h-12"
        disabled={submitting || !attest}
      >
        {submitting ? "Starting checkout…" : "Continue to checkout →"}
      </ChunkyButton>
      </form>
      <div className="text-xs text-mutedink mt-2 text-center">🔒 Secure payment via Whop · it&apos;s an ad buy, not a bet · by continuing you agree to the <Link href="/legal/rules" className="text-moneyink font-bold hover:underline">rules &amp; terms</Link></div>
      <button onClick={onClose} className="block mx-auto text-xs text-mutedink mt-2">maybe later</button>
    </Modal>
  );
}

export function BoardPreview({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"el" | "crowns" | "early">("el");
  const apiTab = tab === "el" ? "by-element" : tab;
  const { data: rows, error } = useSWR<BoardRow[]>(open ? `/api/board?tab=${apiTab}` : null, (url: string) =>
    fetchJson(url, isBoardRows)
  );
  return (
    <Modal open={open} onClose={onClose} label="The board">
      <h2 className="font-display text-xl font-bold">The <span className="text-money">board</span> 🏆</h2>
      <p className="text-sm text-mutedink mt-1">
        {tab === "el" && "Each startup's biggest stake — and the element it holds."}
        {tab === "crowns" && "Who holds the most #1 crowns across the table."}
        {tab === "early" && "First to plant a flag on each element."}
      </p>
      <div className="mt-3 bg-icy rounded-full p-1 grid grid-cols-3 text-xs font-bold">
        {([["el", "🧪 By Element"], ["crowns", "#1 Crowns"], ["early", "🏅 Early"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-full py-2 [@media(pointer:coarse)]:min-h-[44px] ${tab === k ? "bg-white shadow" : "text-mutedink"}`}>{label}</button>
        ))}
      </div>
      <div className="mt-3 flex flex-col gap-1 max-h-72 overflow-auto">
        {error && (
          <div className="rounded-2xl bg-icy p-3 text-sm font-bold text-mutedink">Couldn&apos;t load the board.</div>
        )}
        {!rows && !error
          ? [0, 1, 2, 3, 4].map((i) => <div key={i} className="h-[44px] rounded-2xl bg-icy animate-pulse" />)
          : null}
        {tab === "el" && rows?.map((row, i) => (
          <a key={row.domain + row.elementSym} href={`/s/${encodeURIComponent(row.domain)}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 rounded-2xl hover:bg-icy text-left no-underline">
            <span className="w-6 text-sm">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}</span>
            <Avatar src={row.logoUrl} domain={row.domain} size={24} rounded="rounded-full" />
            <span className="text-sm font-bold text-ink">{row.domain}</span>
            <span className="text-xs text-mutedink">{row.elementSym} {row.elementName}</span>
            <span className="ml-auto text-sm font-extrabold text-moneyink whitespace-nowrap">${row.total}</span>
          </a>
        ))}
        {tab === "crowns" && rows?.map((row, i) => (
          <a key={row.domain} href={`/s/${encodeURIComponent(row.domain)}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 rounded-2xl hover:bg-icy text-left no-underline">
            <span className="w-6 text-sm">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}</span>
            <Avatar src={row.logoUrl} domain={row.domain} size={24} rounded="rounded-full" />
            <span className="text-sm font-bold text-ink">{row.domain}</span>
            <span className="text-xs text-mutedink whitespace-nowrap">👑 {row.total} {row.total === 1 ? "crown" : "crowns"} · ${row.totalSpent ?? 0}</span>
            <span className="ml-auto text-sm font-extrabold text-moneyink whitespace-nowrap">👑 {row.total}</span>
          </a>
        ))}
        {tab === "early" && rows?.map((row, i) => (
          <a key={row.domain + row.elementSym} href={`/s/${encodeURIComponent(row.domain)}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 rounded-2xl hover:bg-icy text-left no-underline">
            <span className="w-6 text-sm">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}</span>
            <Avatar src={row.logoUrl} domain={row.domain} size={24} rounded="rounded-full" />
            <span className="text-sm font-bold text-ink">{row.domain}</span>
            <span className="text-xs text-mutedink">first on {row.elementSym} {row.elementName}</span>
            <span className="ml-auto text-sm font-extrabold text-moneyink whitespace-nowrap">🏅 {row.total}</span>
          </a>
        ))}
      </div>
    </Modal>
  );
}
