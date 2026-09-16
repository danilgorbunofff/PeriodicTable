"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Modal } from "./Modal";
import { TurnstileWidget } from "./TurnstileWidget";
import { ChunkyButton } from "./ChunkyButton";
import { IcyInput } from "./IcyInput";
import { Avatar } from "./Avatar";
import { fetchJson, isBoardRows, isElementDetail, type BoardRow, type ElementDetail } from "../lib/api";
import { CONSENT_LINK_HREF, CONSENT_LINK_TEXT, CONSENT_STATEMENT, CONSENT_VERSION } from "../lib/legal";
import { DEMO_LABEL, DEMO_NOTE } from "../lib/demoLabels";
import { classifyAndValidate } from "../lib/pricing";
import { stakeQuote, crownCopy } from "../lib/stakeQuote";
import { domainFromUrl, domainFromSocial, isEmail } from "../lib/validate";
import {
  CHECKOUT_MSG,
  checkoutRefusal,
  emailShapeBad,
  fieldHasRenderer,
  pitchShapeBad,
  submitBlocked,
  titleShapeBad,
  urlMessage,
  urlShapeBad,
} from "../lib/checkoutFace";
import { paymentsLiveClient } from "../lib/flags";
import { track } from "../lib/analytics";
import type { ElementNode } from "../lib/elements";

export function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  const steps = [
    { icon: "🚩", bg: "#FFEFC1", t: "1 Claim", d: "Pick an open element and stake from $5. Your logo goes up as soon as payment settles." },
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
  amountMinted,
  prefillDomain,
  canceled,
  onAmount,
  onReconcile,
  onClose,
  onDone,
}: {
  el: ElementNode | null;
  open: boolean;
  amount: number;
  /** The field still holds a figure the app minted (?stake=), not a buyer's. */
  amountMinted?: boolean;
  prefillDomain?: string | null;
  /** True when the buyer came back from the provider having cancelled (R06-8). */
  canceled?: boolean;
  onAmount: (n: number) => void;
  /** App-driven field update; never routed through `onAmount`'s latch. */
  onReconcile: (n: number) => void;
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
  // R06-6: the Turnstile script never arrived, so no checkbox is coming and no
  // token exists. A submit has to say which check is missing rather than hand
  // back the server's deliberately opaque "Bot check failed." (still opaque).
  const [humanCheckFailed, setHumanCheckFailed] = useState(false);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const [serverField, setServerField] = useState<{ field: string; message: string } | null>(null);
  const [priceMoved, setPriceMoved] = useState<number | null>(null);
  const [waitErr, setWaitErr] = useState<string | null>(null);
  const [waitBusy, setWaitBusy] = useState(false);
  // Token handed to us by the widget's callback. Preferred over scraping the
  // hidden field: the DOM can hold a stale or empty input from a previous render.
  const turnstileRef = useRef<string | null>(null);
  // The key naming this attempt, kept while the claim it was minted for is
  // unchanged: a retry after a provider failure has to replay the row the first
  // attempt wrote instead of forking a second PENDING payment (R06-7).
  const attempt = useRef<{ sig: string; key: string } | null>(null);
  const { data } = useSWR<ElementDetail>(open && el ? `/api/elements/${el.symbol}` : null, (url: string) =>
    fetchJson(url, isElementDetail)
  );

  // Reclaim deep link (?r=DOMAIN): we sent this address the outbid mail, so it
  // is by definition the previous leader here — fill their own listing back in
  // (URL, name, pitch) from the live payload instead of making them retype it.
  // Seeded on open, and retracted on close while the fields are still
  // untouched, so a prefill can never bleed into an unrelated purchase.
  const mine = prefillDomain ? data?.stakes.find((s) => s.domain === prefillDomain) : undefined;
  const prefilled = useRef<{ url: string; title: string; pitch: string; seeded: boolean } | null>(null);
  useEffect(() => {
    if (!open) {
      const meta = prefilled.current;
      if (!meta) return;
      prefilled.current = null;
      setUrl((v) => (v === meta.url ? "" : v));
      setTitle((v) => (v === meta.title ? "" : v));
      setPitch((v) => (v === meta.pitch ? "" : v));
      setTab("url");
      return;
    }
    if (!prefillDomain || prefilled.current?.seeded) return;
    if (!mine) {
      // Domain is the identity, so the field can already be right while prices load.
      const seed = { url: `https://${prefillDomain}`, title: "", pitch: "" };
      if (!prefilled.current) {
        setUrl((v) => v || seed.url);
        setTab("url");
      }
      prefilled.current = { ...seed, seeded: false };
      return;
    }
    const social = !!mine.siteUrl && mine.siteUrl.startsWith("@");
    const meta = {
      url: mine.siteUrl || `https://${prefillDomain}`,
      title: mine.title ?? "",
      pitch: mine.pitch ?? "",
    };
    prefilled.current = { ...meta, seeded: true };
    setUrl(meta.url);
    setTab(social ? "social" : "url");
    if (meta.title) setTitle(meta.title);
    if (meta.pitch) setPitch(meta.pitch);
  }, [open, prefillDomain, mine]);

  const elSafe = el;
  const elSymbol = elSafe?.symbol ?? "";
  // The API flags the top LIVE bid. Row 0 alone is not enough: a reversed $0
  // stake sorts last but is still row 0 on an element with nothing else, and
  // quoting it would advertise a $1 takeover the server refuses.
  const leaderTotal = data?.stakes.find((s) => s.isLeader)?.amount;
  const badUrl = urlShapeBad(tab, url);
  const badEmail = emailShapeBad(email);
  const badTitle = titleShapeBad(title);
  const badPitch = pitchShapeBad(pitch);
  const domain =
    tab === "url"
      ? url.includes("://")
        ? domainFromUrl(url)
        : null
      : url.startsWith("@")
        ? domainFromSocial(url)
        : null;
  const isNewHere = !domain || !data?.stakes.some((s) => s.domain === domain && s.amount > 0);
  // Client-side preview of the server rule (Phase 3 classifyAndValidate);
  // the server re-validates authoritatively under lock.
  const stakeTotals = (data?.stakes ?? []).map((s) => s.amount);
  // Zero-amount rows are reversed stakes: still listed, but not a prior holding
  // (mirrors app/api/checkout/route.ts — otherwise the preview would quote a
  // sub-$5 re-entry the server refuses).
  const myPriorTotal = !domain ? 0 : (data?.stakes.find((s) => s.domain === domain)?.amount ?? 0);
  // What this amount is worth on the board it can see — but only the board it
  // can see: whether the rows are every live listing and whether the figure in
  // the field is the buyer's own decide what may be claimed and rewritten
  // (R04-1, R04-2). One rule set, in lib/stakeQuote.ts.
  const quote = stakeQuote({
    boardLoaded: !!data,
    boardComplete: data?.prices.boardComplete === true,
    takeLead: data?.prices.takeLead,
    leaderTotal,
    domainKnown: !!domain,
    priorTotal: myPriorTotal,
    amount: Math.round(amount) || 0,
    // R09-1: a live take quote holds #1 for someone else, so the copy below has
    // to name it instead of promising a takeover.
    takeQuote: data?.takeHold ?? null,
  });
  const { priorHere, alreadyLead, need, belowNeed, takeQuoted, heldByOtherUntil, heldByOtherTotal } = quote;
  const classified = classifyAndValidate({
    amount: Math.round(amount) || 0,
    leaderTotal,
    isNewHere,
    myPriorTotal,
    existingTotals: stakeTotals,
  });
  const clientErr = classified.ok ? null : classified.error;
  const paused = !paymentsLiveClient();

  // R04-1: the app minted that amount (outbid mail `?stake=`, element-page CTA)
  // off the board as it stood when the link was written. The board moves, so
  // until the buyer's own hand edits the field the figure is ours and keeps
  // tracking the live quote; the first keystroke or chip hands it over for
  // good. Reconciled against a board the client cannot see in full? No —
  // lib/stakeQuote returns null rather than price a listing it was not shown.
  const liveAmount = quote.reconciledAmount;
  useEffect(() => {
    if (!open || !amountMinted || liveAmount == null) return;
    if (Math.round(amount) === liveAmount) return;
    onReconcile(liveAmount);
  }, [open, amountMinted, liveAmount, amount, onReconcile]);

  if (!elSafe) return null;
  const effectiveTitle = title.trim() || domain || "";
  const effectivePitch = pitch.trim() || `Staked on ${elSafe.name}`;
  // The two sentences over the amount field, derived from the quote (R09-6).
  // Only rendered inside the `need != null` guard below, where a quote exists.
  const crown =
    need == null
      ? null
      : crownCopy({
          elementName: elSafe.name,
          boardComplete: data?.prices.boardComplete === true,
          priorHere,
          alreadyLead,
          need,
          priorTotal: myPriorTotal,
          heldUntil: heldByOtherUntil,
          heldTotal: heldByOtherTotal,
          existingTotals: stakeTotals,
        });

  async function joinWaitlist() {
    if (waitBusy) return;
    if (!isEmail(email)) {
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
      setWaitBusy(false);
      onClose();
    } catch {
      setWaitErr("Network error. Try again.");
      setWaitBusy(false);
    }
  }

  async function submit() {
    // In flight: the button already says so. Every other gate owes the buyer a
    // sentence, because the old guard returned with nothing on screen — an
    // untouched form, or a handle typed without its `@` (which resolves no
    // domain), did nothing at all when clicked (R06-1). The sentences live in
    // lib/checkoutFace.ts so the client and server word the same rule the same
    // way, and the tab picks the right one (R06-5).
    if (submitting) return;
    const blocked = submitBlocked({
      tab,
      url,
      title,
      pitch,
      email,
      attest,
      domain,
      clientErr,
      humanCheckFailed,
    });
    if (blocked) {
      if (blocked.field && fieldHasRenderer(blocked.field)) {
        setServerField({ field: blocked.field, message: blocked.message });
        setServerErr(null);
      } else {
        setServerField(null);
        // `shown`: the failed widget already prints this exact sentence, so
        // printing it again under the button would say it twice (R06-6).
        setServerErr(blocked.shown ? null : blocked.message);
      }
      return;
    }
    track("checkout_start", { element: elSymbol, amount: Math.round(amount) });
    setSubmitting(true);
    setServerErr(null);
    setServerField(null);
    setPriceMoved(null);
    try {
      const domToken =
        typeof document !== "undefined"
          ? document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]')?.value || undefined
          : undefined;
      const turnstileToken = turnstileRef.current ?? domToken;
      // One attempt, one key: it is only replaced when the claim itself changes,
      // so a retry after a provider failure (502, network) asks the server for
      // the row it already wrote instead of writing a second pending payment
      // that the buyer's money would never reach (R06-7).
      const sig = `${elSymbol}|${domain}|${Math.round(amount)}|${email.trim()}`;
      if (attempt.current?.sig !== sig) {
        attempt.current = {
          sig,
          key:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `ck-${elSymbol}-${domain}-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
        };
      }
      const idempotencyKey = attempt.current.key;
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
          // The revision the checkbox's words belong to (R16-7). The server
          // refuses a mismatch, so a tab open across a rules change cannot buy
          // under a version it never displayed.
          consentVersion: CONSENT_VERSION,
          turnstileToken,
          idempotencyKey,
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
        // Every branch below is decided in lib/checkoutFace.checkoutRefusal:
        // only a board that actually moved may quote a new price (R06-3), and a
        // `field` the form has no node for lands on the shared line rather than
        // in state nobody renders (R06-4).
        const refusal = checkoutRefusal(res.status, json);
        setPriceMoved(refusal.priceMoved);
        setServerField(refusal.field);
        setServerErr(refusal.serverErr);
        onDone(json.error ?? "Checkout failed — retry when ready.");
        setSubmitting(false);
        return;
      }
      attempt.current = null; // the checkout started; the next one is a new claim
      window.location.href = json.checkoutUrl as string;
    } catch {
      // The key is deliberately kept: the fetch may have reached the server.
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
            {waitErr && <div id="wl-email-error" className="mt-2 text-xs text-red-700 font-bold">{waitErr}</div>}
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
      {/* R06-8: the provider's cancel_url lands back here. Nothing was charged,
          the claim is untouched, and the old page said so with a shrug. */}
      {canceled && (
        <div className="mt-2 rounded-2xl bg-goldwash p-3 text-xs font-bold">⚠️ {CHECKOUT_MSG.canceled}</div>
      )}
      {/* Polite announcements for async checkout states (Phase 5): submitting,
          price moves, and server errors — focus itself never moves. */}
      <div role="status" aria-live="polite" className="sr-only">
        {submitting ? "Starting checkout…" : serverErr ?? (serverField ? serverField.message : priceMoved != null ? `Price moved to $${priceMoved}.` : humanCheckFailed ? CHECKOUT_MSG.humanCheck : "")}
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
          {(badUrl || serverField?.field === "url") && (
            <div id="co-url-error" className="text-xs text-red-700">
              {serverField?.field === "url" ? <span className="font-bold">{serverField.message}</span> : urlMessage(tab)}
            </div>
          )}        </div>
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
          {(badTitle || serverField?.field === "title") && (
            <div id="co-title-error" className="text-xs text-red-700">
              {serverField?.field === "title" ? <span className="font-bold">{serverField.message}</span> : CHECKOUT_MSG.title}
            </div>
          )}        </div>
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
          {(badPitch || serverField?.field === "pitch") && (
            <div id="co-pitch-error" className="text-xs text-red-700">
              {serverField?.field === "pitch" ? <span className="font-bold">{serverField.message}</span> : CHECKOUT_MSG.pitch}
            </div>
          )}        </div>
        <div>
          <label htmlFor="co-email" className="mb-1 block text-[11px] font-extrabold text-mutedink">Email for receipt + outbid alerts (optional)</label>
          <IcyInput
            id="co-email" name="co-email" type="email" autoComplete="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setServerField(null); }}
            placeholder="you@startup.com"
            aria-invalid={badEmail || serverField?.field === "email"}
            aria-describedby={badEmail || serverField?.field === "email" ? "co-email-error" : undefined}
          />
          {(badEmail || serverField?.field === "email") && (
            <div id="co-email-error" className="text-xs text-red-700">
              {serverField?.field === "email" ? <span className="font-bold">{serverField.message}</span> : CHECKOUT_MSG.email}
            </div>
          )}
        </div>
        <div>
          <label htmlFor="co-amount" className="mb-1 block text-[11px] font-extrabold text-mutedink">Stake amount (whole dollars)</label>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-mutedink">$</span>
            <IcyInput id="co-amount" name="co-amount" type="number" min={1} required value={amount} onChange={(e) => onAmount(Number(e.target.value))} className="pl-8" />
          </div>
        </div>
      </div>
      {need != null && crown && (
        <>
          <div className="mt-2 text-sm font-extrabold">{crown.lead}</div>
          <div className="mt-1 text-xs text-mutedink">
            {crown.joins}
            {takeQuoted ? " Your take quote is held for 15 min once you continue." : ""}
          </div>
          {belowNeed && !clientErr && (
            <div className="mt-2 rounded-2xl bg-goldwash p-3 text-xs font-bold">
              💡 ${Math.round(amount)} tops up your stake — add ${need - Math.round(amount)} more to take #1.
            </div>
          )}
        </>
      )}
      {priceMoved != null && (
        <div className="mt-2 rounded-2xl bg-goldwash p-3 text-xs font-bold">
          Price moved to ${priceMoved} — continue?
          <button className="ml-2 underline" onClick={() => { onAmount(priceMoved); setPriceMoved(null); setServerErr(null); }}>
            Use ${priceMoved}
          </button>
        </div>
      )}
      <div className="mt-1.5 flex gap-1.5">
        {(need != null && need > 50 ? [need, need + 25, need + 100] : [10, 25, 50]).map((p) => {
          const chip = need != null ? Math.max(p, need) : p;
          return (
            <button
              key={p}
              onClick={() => onAmount(chip)}
              className="flex-1 rounded-xl bg-icy py-1.5 text-xs font-extrabold text-ink hover:bg-goldwash"
            >
              ${chip}
            </button>
          );
        })}
      </div>
      {clientErr && <div className="mt-2 text-xs text-red-700 font-bold">{clientErr}</div>}
      {serverErr && <div className="mt-2 text-xs text-red-700 font-bold">{serverErr}</div>}
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
        {/* The attested words are `CONSENT_STATEMENT`, rendered whole with the
            linked phrase spliced in — not a paraphrase. The server records a
            digest of that exact string (R16-6), so the evidence matches what was
            on screen, character for character. */}
        <span>
          {CONSENT_STATEMENT.split(CONSENT_LINK_TEXT).map((part, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <Link href={CONSENT_LINK_HREF} className="text-moneyink font-bold hover:underline">
                  {CONSENT_LINK_TEXT}
                </Link>
              )}
              {part}
            </Fragment>
          ))}
        </span>
      </label>
      {process.env.NEXT_PUBLIC_TURNSTILE_SITEKEY ? (
        <TurnstileWidget
          sitekey={process.env.NEXT_PUBLIC_TURNSTILE_SITEKEY}
          onToken={(t) => {
            turnstileRef.current = t;
            // A widget that rendered can hand out a token, so the earlier
            // failure is over (R06-6).
            if (t) setHumanCheckFailed(false);
          }}
          onLoadFail={() => setHumanCheckFailed(true)}
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
      {/* The agreement moved into the label above, where the checkbox that
          affirms it lives; printing "by continuing you agree to the rules" here
          as well would be a second, unversioned agreement (R16-6). What is left
          is the payment-security line and the version of the rules the box
          quotes (R16-7). */}
      <div className="text-xs text-mutedink mt-2 text-center">
        🔒 Secure payment via Stripe · it&apos;s an ad buy, not a bet · rules version {CONSENT_VERSION}
      </div>
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
  // Podium: top-3 rows carry gold/silver/bronze washes + medal badges; hover
  // deepens their OWN rank color. #4+ keep the plain look (hover:bg-icy).
  const rankClass = (i: number) =>
    i === 0
      ? "bg-goldwash hover:bg-golddeep"
      : i === 1
        ? "bg-silverwash hover:bg-silverdeep"
        : i === 2
          ? "bg-bronzewash hover:bg-bronzedeep"
          : "hover:bg-icy";
  const rankBadge = (i: number) =>
    i <= 2 ? (
      <span
        className={`grid h-6 min-w-[26px] shrink-0 place-items-center rounded-md ${
          i === 0 ? "bg-medalgold" : i === 1 ? "bg-medalsilver" : "bg-medalbronze"
        } text-[11px] font-extrabold text-ink`}
      >
        #{i + 1}
      </span>
    ) : (
      <span className="w-6 text-sm">#{i + 1}</span>
    );
  // R16-9: "the board" ranks money. Seeded placeholder rows appear in it with
  // amounts nobody paid, so they say so on every tab.
  const demoTag = (row: BoardRow) =>
    row.demo ? (
      <span
        title={DEMO_NOTE}
        className="shrink-0 rounded-[4px] bg-icy px-1 py-[1px] text-[10px] font-bold uppercase tracking-wide text-mutedink"
      >
        {DEMO_LABEL}
      </span>
    ) : null;

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
          <a key={row.domain + row.elementSym} href={`/s/${encodeURIComponent(row.domain)}`} target="_blank" rel="noopener noreferrer" className={`flex items-center gap-2 px-3 py-2 rounded-2xl transition-colors ${rankClass(i)} text-left no-underline`}>
            {rankBadge(i)}
            <Avatar src={row.logoUrl} domain={row.domain} size={24} rounded="rounded-full" />
            <span className="text-sm font-bold text-ink">{row.domain}</span>
            {demoTag(row)}
            <span className="text-xs text-mutedink">{row.elementSym} {row.elementName}</span>
            <span className="ml-auto text-sm font-extrabold text-moneyink whitespace-nowrap">${row.total}</span>
          </a>
        ))}
        {tab === "crowns" && rows?.map((row, i) => (
          <a key={row.domain} href={`/s/${encodeURIComponent(row.domain)}`} target="_blank" rel="noopener noreferrer" className={`flex items-center gap-2 px-3 py-2 rounded-2xl transition-colors ${rankClass(i)} text-left no-underline`}>
            {rankBadge(i)}
            <Avatar src={row.logoUrl} domain={row.domain} size={24} rounded="rounded-full" />
            <span className="text-sm font-bold text-ink">{row.domain}</span>
            {demoTag(row)}
            <span className="text-xs text-mutedink whitespace-nowrap">👑 {row.total} {row.total === 1 ? "crown" : "crowns"} · ${row.totalSpent ?? 0}</span>
            <span className="ml-auto text-sm font-extrabold text-moneyink whitespace-nowrap">👑 {row.total}</span>
          </a>
        ))}
        {tab === "early" && rows?.map((row, i) => (
          <a key={row.domain + row.elementSym} href={`/s/${encodeURIComponent(row.domain)}`} target="_blank" rel="noopener noreferrer" className={`flex items-center gap-2 px-3 py-2 rounded-2xl transition-colors ${rankClass(i)} text-left no-underline`}>
            {rankBadge(i)}
            <Avatar src={row.logoUrl} domain={row.domain} size={24} rounded="rounded-full" />
            <span className="text-sm font-bold text-ink">{row.domain}</span>
            {demoTag(row)}
            <span className="text-xs text-mutedink">first on {row.elementSym} {row.elementName}</span>
            <span className="ml-auto text-sm font-extrabold text-moneyink whitespace-nowrap">🏅 {row.total}</span>
          </a>
        ))}
      </div>
    </Modal>
  );
}
