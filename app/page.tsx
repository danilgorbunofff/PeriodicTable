"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { fetchJson, isStatsResponse, isActivityRows, type Claim, type ActivityRow, type StatsResponse } from "../lib/api";
import { PeriodicGrid } from "../components/PeriodicGrid";
import { TableCamera } from "../components/TableCamera";
import { BackgroundSymbols } from "../components/BackgroundSymbols";
import { ElementNode, findElementBySymbol } from "../lib/elements";
import { HeroCard } from "../components/HeroCard";
import { SearchPill, SearchPick } from "../components/SearchPill";
import { StatsCard } from "../components/StatsCard";
import { LiveDataNotice } from "../components/LiveDataNotice";
import { liveState } from "../lib/liveState";
import { activityFace } from "../lib/activityFace";
import { ActivityCard } from "../components/ActivityCard";
import { WorldOrder, RailShell } from "../components/WorldOrder";
import { TerritoryView } from "../components/TerritoryView";
import { HowItWorks, CheckoutPreview, BoardPreview } from "../components/Modals";
import { Modal } from "../components/Modal";
import { ToastHost, useToast } from "../components/Toast";
import { FooterBar } from "../components/FooterBar";
import { track } from "../lib/analytics";

type Tile = {
  symbol: string;
  name: string;
  gridRow: number;
  gridCol: number;
  family: string;
  tier: string;
  pool: number;
  count: number;
  leader: { domain: string; logoUrl: string; amount: number } | null;
};

/** The FAB pulse makes the same claim as the activity footer, so it may beat
 *  only while the feed is proven live (R02-6). */
function ActivityDot({ dot }: { dot: { className: string; ping: boolean } }) {
  return (
    <span className="relative flex h-2.5 w-2.5">
      {dot.ping ? (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75" />
      ) : null}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dot.className}`} />
    </span>
  );
}

function HomeInner() {
  const toast = useToast();
  const [selected, setSelected] = useState<ElementNode | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [checkoutEl, setCheckoutEl] = useState<ElementNode | null>(null);
  const [checkoutAmt, setCheckoutAmt] = useState(5);
  // R04-1: true while the amount in the form is a figure the app minted from a
  // link (?stake=) rather than one the buyer typed or picked. It stays true
  // only until the buyer touches the field, so an app figure can track the live
  // quote while the buyer's own never gets rewritten.
  const [checkoutAmtMinted, setCheckoutAmtMinted] = useState(false);
  // Reclaim deep link (?r=DOMAIN): the domain whose listing the modal prefills.
  const [checkoutDomain, setCheckoutDomain] = useState<string | null>(null);
  // True when the buyer arrived back from the provider having cancelled
  // (?canceled=SYM), so the form says nothing was charged (R06-8).
  const [checkoutCanceled, setCheckoutCanceled] = useState(false);
  const [mobileActivityOpen, setMobileActivityOpen] = useState(false);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const [actMin, setActMin] = useState(false);
  const [railMin, setRailMin] = useState(false);
  // Remembers a minimized rail across an element detour: opening an element
  // pops the rail open, closing it restores the minimized state.
  const railWasMin = useRef(false);

  const closeElement = useCallback(() => {
    setSelected(null);
    if (railWasMin.current) {
      railWasMin.current = false;
      setRailMin(true);
    }
  }, []);
  const [expandOpen, setExpandOpen] = useState(false);

  // live table data (30s poll)
  const {
    data: tiles,
    error: tilesError,
    mutate: mutateTiles,
  } = useSWR<Tile[]>("/api/elements", fetchJson, { refreshInterval: 30000 });
  const {
    data: statsData,
    error: statsError,
    mutate: mutateStats,
  } = useSWR<StatsResponse>("/api/stats", (url: string) => fetchJson(url, isStatsResponse), {
    refreshInterval: 30000,
  });
  const { data: activity, error: activityError, mutate: mutateActivity } = useSWR<ActivityRow[]>("/api/activity?limit=6", (url: string) => fetchJson(url, isActivityRows), {
    refreshInterval: 30000,
  });

  const claims: Record<string, Claim> = {};
  for (const t of tiles ?? []) {
    if (t.leader) {
      claims[t.symbol] = {
        price: t.leader.amount,
        logoUrl: t.leader.logoUrl,
        domain: t.leader.domain,
      };
    }
  }

  // Deep links: /?paid=SYM (post-checkout success), /?unsub=done|unknown,
  // /?el=SYM&stake=N&r=DOMAIN (outbid reclaim prefill from email),
  // /?canceled=SYM (the provider's cancel_url).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paid = params.get("paid");
    const unsub = params.get("unsub");
    const canceled = params.get("canceled");
    const elParam = params.get("el");
    const stakeParam = params.get("stake");
    const reclaimParam = params.get("r");
    if (paid) {
      if (paid !== "1") openSymbol(paid);
      toast("Payment confirmed — you're live! 🎉");
      track("checkout_paid", { element: paid });
      // Refresh every cached endpoint so tiles/ranks reflect the new stake.
      mutateTiles();
      mutateStats();
      mutateActivity();
    }
    if (canceled) {
      // The provider's cancel_url. Nothing was charged and the pending row
      // simply expires, but this used to land on a plain board with the
      // parameter silently rewritten away (R06-8). Re-open the form they left
      // and say the conservative half out loud: the amount is not in this URL,
      // so no figure may be named here.
      const found = findElementBySymbol(canceled);
      if (found) {
        setSelected(found);
        setCheckoutEl(found);
        setCheckoutCanceled(true);
      }
      toast("Not paid — nothing was charged. Your claim is still here.");
    }
    if (elParam) {
      // Casing is not identity (R04-4): mail clients and pasted links are
      // lowercase, and `Hbar`/`Ps`/`Uue` make blind uppercasing wrong.
      const found = findElementBySymbol(elParam);
      if (found) {
        setSelected(found);
        // `r` is the reclaiming holder's own domain (verified by construction:
        // only the previous leader's address gets an outbid mail), so the modal
        // can fill their listing from the live element payload instead of
        // making them retype it.
        if (reclaimParam) setCheckoutDomain(reclaimParam.trim().toLowerCase());
        const reclaimAmt = stakeParam ? parseInt(stakeParam, 10) : NaN;
        const knownAmt = Number.isInteger(reclaimAmt) && reclaimAmt >= 1;
        if (knownAmt || reclaimParam) {
          setCheckoutEl(found);
          // `?stake=` is an app figure: priced when the link was written, still
          // ours until the buyer edits it (lib/stakeQuote.ts).
          if (knownAmt) {
            setCheckoutAmt(reclaimAmt);
            setCheckoutAmtMinted(true);
          }
        }
        if (knownAmt && reclaimParam) {
          // No dollar figure here: the mail's amount was true when it was sent
          // and the board has been moving since (R04-1). The modal shows the
          // live quote and holds it until the buyer types.
          toast(`Reclaim ${found.symbol} below — your quote follows the live board.`);
          track("reclaim_click", { element: found.symbol, amount: reclaimAmt });
        }
      }
    }
    if (unsub === "done") toast("Mail to that address is off — receipts included. Your stake still counts.");
    if (unsub === "on") toast("Mail is on again: receipts and outbid notices will arrive.");
    if (unsub === "unknown") toast("Already unsubscribed or unknown link.");
    if (paid || unsub || canceled || elParam) window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The board may only draw its defaults when it is entitled to them; see
  // lib/liveState.ts. Tiles and stats fail independently, so they are tracked
  // separately: the table can be trustworthy while the totals are not.
  const tileState = liveState(!!tiles, tilesError);
  const statsState = liveState(!!statsData, statsError);
  // The activity card is a second document surface with its own footer claim,
  // so it gets its own state (R02-6). SWR keeps the last good rows when a
  // refresh fails, which is why the card cannot work this out from `rows`
  // alone: retained rows look exactly like fresh ones.
  const activityState = liveState(!!activity, activityError);

  // One derivation feeds both the FAB pulse and the panel footer, so they can
  // never disagree about whether the feed is live.
  const activityDot = activityFace(activityState, activity).dot;

  const retryLiveData = useCallback(() => {
    void mutateTiles();
    void mutateStats();
    void mutateActivity();
  }, [mutateTiles, mutateStats, mutateActivity]);

  const openStake = useCallback((el: ElementNode, amount: number) => {
    setCheckoutEl(el);
    setCheckoutAmt(amount);
    // The board's own figure is minted too: the tile quoted it a moment ago,
    // and the modal is what has the live payload, so let it price the take.
    setCheckoutAmtMinted(true);
    // A manual stake is a fresh purchase: never carry a reclaim prefill over.
    setCheckoutDomain(null);
    // Nor the "you cancelled" note from an earlier trip to the provider.
    setCheckoutCanceled(false);
  }, []);

  // The buyer's hands on the amount field (typing, chips, "Use $N"): the figure
  // becomes theirs, so nothing may rewrite it again.
  const onCheckoutAmount = useCallback((v: number) => {
    setCheckoutAmtMinted(false);
    setCheckoutAmt(v);
  }, []);

  const openSymbol = useCallback((symbol: string) => {
    const el = findElementBySymbol(symbol);
    if (el) {
      setSelected(el);
      setRailMin(false);
      setMobileActivityOpen(false);
    }
  }, []);

  const onSelectTile = useCallback((el: ElementNode) => {
    track("tile_click", { element: el.symbol });
    setSelected(el);
    setMobileActivityOpen(false);
    setRailMin(false); // a minimized rail must pop back open to show the bidding view
    track("drawer_open", { element: el.symbol });
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Phase 5: open modals own Escape (see Modal) — never double-handle.
      if (document.body.hasAttribute("data-modal-open")) return;
      if (expandOpen) setExpandOpen(false);
      else if (searchOpen) setSearchOpen(false);
      else if (checkoutEl) setCheckoutEl(null);
      else if (selected) closeElement();
      else if (mobileRailOpen) setMobileRailOpen(false);
      else if (mobileActivityOpen) setMobileActivityOpen(false);
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [searchOpen, checkoutEl, selected, mobileRailOpen, mobileActivityOpen, expandOpen, closeElement]);

  const onPick = (p: SearchPick) => {
    track("search_submit", { element: p.symbol });
    openSymbol(p.symbol);
    setSearchOpen(false);
    track("drawer_open", { element: p.symbol });
  };

  return (
    <div id="app-root" className="stage-shell relative h-screen overflow-hidden text-ink">
      <BackgroundSymbols />
      <TableCamera focusId={selected?.id ?? null}>
        <div className="periodic-object p-2">
          {tileState === "unavailable" ? (
            // There is nothing trustworthy to draw, and the table's default
            // face is "$5 · unclaimed" — so it is not drawn at all. Rendering
            // it and hoping the notice is read would advertise the whole
            // periodic table as free. TableCamera null-guards its tile lookup,
            // so an empty board is safe.
            <LiveDataNotice state={tileState} onRetry={retryLiveData} />
          ) : (
            <PeriodicGrid
              claims={claims}
              selectedId={selected?.id ?? null}
              onSelect={onSelectTile}
              // Only a table that has answered may price itself: before the
              // first /api/elements response the tiles draw symbol and name and
              // no price at all (R02-4).
              pricesKnown={tileState === "ok" || tileState === "stale"}
            />
          )}
        </div>
      </TableCamera>

      {/* wordmark + hero + search */}
      <div className="absolute left-[18px] top-[18px] z-[var(--z-cards)] flex max-w-[400px] flex-col gap-2.5">
          <div className="w-fit rounded-full bg-white px-[18px] py-2 font-display text-[22px] font-bold shadow-float">
            <span>periodictable<span className="text-money">.lol</span></span>
          </div>
        <HeroCard
          onBoard={() => setBoardOpen(true)}
          onHow={() => setHowOpen(true)}
          onSearchToggle={() => setSearchOpen((v) => !v)}
          searchOpen={searchOpen}
          onClaim={() => setHowOpen(true)}
        />
        <div className="relative">
          <SearchPill open={searchOpen} onPick={onPick} onClose={() => setSearchOpen(false)} />
        </div>
      </div>

      {/* stats */}
      <div className="absolute right-[18px] top-[18px] z-[var(--z-cards)] hidden sm:block">
        <StatsCard stats={statsData} stale={statsState === "stale"} />
      </div>

      {/* stale marker — the table is still drawing real values, but they are no
          longer current, and a stale tile reads exactly like a fresh one: a
          visitor would click through to a price this page never advertised.
          Lifted clear of the bottom edge on purpose: the bottom corners hold a
          44px FAB at every breakpoint, and bottom-centre is already taken by
          FooterBar at the same z-layer, so a pill placed at 18px would sit
          under the legal links and swallow their clicks. 72px clears both the
          FABs (62px on mobile) and the footer (51px on desktop). */}
      {tileState === "stale" && (
        <div className="absolute bottom-[72px] left-1/2 z-[var(--z-cards)] w-max max-w-[calc(100%-24px)] -translate-x-1/2">
          <LiveDataNotice state={tileState} onRetry={retryLiveData} />
        </div>
      )}

      {/* activity — desktop (minimize button collapses it to the same FAB as mobile) */}
      <div className="absolute bottom-[18px] left-[18px] z-[var(--z-cards)] hidden md:block">
        {actMin ? (
          <button
            aria-label="Live activity"
            aria-expanded={false}
            title="Show live activity"
            onClick={() => setActMin(false)}
            className="h-11 w-11 rounded-full bg-white shadow-float grid place-items-center animate-panel-in"
          >
            <ActivityDot dot={activityDot} />
          </button>
        ) : (
          <ActivityCard rows={activity} state={activityState} onRetry={retryLiveData} onMinimize={() => setActMin(true)} />
        )}
      </div>

      {/* activity — mobile/tablet FAB + popover */}
      <div className="md:hidden">
        <button
          aria-label="Live activity"
          aria-expanded={mobileActivityOpen}
          onClick={() => {
            if (!mobileActivityOpen) {
              setMobileRailOpen(false);
              setSelected(null);
            }
            setMobileActivityOpen(!mobileActivityOpen);
          }}
          className="absolute bottom-[18px] left-[18px] z-[var(--z-cards)] h-11 w-11 rounded-full bg-white shadow-float grid place-items-center"
        >
          <ActivityDot dot={activityDot} />
        </button>
        {mobileActivityOpen && (
          <div className="absolute inset-x-3 bottom-3 z-[var(--z-rail)] max-h-[70vh] overflow-auto">
            <ActivityCard rows={activity} state={activityState} onRetry={retryLiveData} fluid onClose={() => setMobileActivityOpen(false)} />
          </div>
        )}
      </div>

      {/* rail — desktop (minimize button collapses it to the same FAB as mobile) */}
      <div className="absolute bottom-[18px] right-[18px] z-[var(--z-rail)] hidden w-[385px] max-h-[calc(100vh-36px)] lg:block">
        {railMin ? (
          <div className="flex justify-end">
            <button
              aria-label="Table order"
              aria-expanded={false}
              title="Show table order"
              onClick={() => { railWasMin.current = false; setRailMin(false); }}
              className="h-11 w-11 rounded-full bg-cta text-ink shadow-float grid place-items-center text-lg font-display font-bold animate-panel-in"
            >
              ⚗️
            </button>
          </div>
        ) : (
          <RailShell>
            {selected ? (
              <TerritoryView el={selected} onClose={closeElement} onStake={openStake} onExpand={() => setExpandOpen(true)} />
            ) : (
              <WorldOrder onExpand={() => setExpandOpen(true)} onMinimize={() => { railWasMin.current = true; setRailMin(true); }} />
            )}
          </RailShell>
        )}
      </div>

      {/* rail — mobile/tablet FAB + bottom sheet */}
      <div className="lg:hidden">
        {!selected && !mobileActivityOpen && (
          <button
            aria-label="Table order"
            aria-expanded={mobileRailOpen}
            onClick={() => {
              if (!mobileRailOpen) setMobileActivityOpen(false);
              setMobileRailOpen(!mobileRailOpen);
            }}
            className="absolute bottom-[18px] right-[18px] z-[var(--z-rail)] h-11 w-11 rounded-full bg-cta text-ink shadow-float grid place-items-center text-lg font-display font-bold"
          >
            ⚗️
          </button>
        )}
        {(selected || mobileRailOpen) && (
          <div className="absolute inset-x-3 bottom-3 z-[var(--z-rail)] max-h-[70vh] overflow-auto">
            <RailShell>
              {selected ? (
                <TerritoryView
                  el={selected}
                  onClose={closeElement}
                  onStake={openStake}
                  onExpand={() => setExpandOpen(true)}
                />
              ) : (
                <WorldOrder onClose={() => setMobileRailOpen(false)} onExpand={() => setExpandOpen(true)} />
              )}
            </RailShell>
          </div>
        )}
      </div>

      <HowItWorks open={howOpen} onClose={() => setHowOpen(false)} />
      <BoardPreview open={boardOpen} onClose={() => setBoardOpen(false)} />
      <Modal
        open={expandOpen}
        onClose={() => setExpandOpen(false)}
        label={selected ? `${selected.name} — expanded view` : "Table Order — expanded view"}
        size="lg"
        hideClose
      >
        {selected ? (
          <TerritoryView
            el={selected}
            onClose={() => setExpandOpen(false)}
            onStake={(el, amount) => {
              setExpandOpen(false);
              openStake(el, amount);
            }}
            expanded
          />
        ) : (
          <WorldOrder expanded onClose={() => setExpandOpen(false)} />
        )}
      </Modal>
      <CheckoutPreview
        el={checkoutEl}
        open={!!checkoutEl}
        amount={checkoutAmt}
        amountMinted={checkoutAmtMinted}
        prefillDomain={checkoutDomain}
        canceled={checkoutCanceled}
        onAmount={onCheckoutAmount}
        onReconcile={setCheckoutAmt}
        onClose={() => {
          setCheckoutEl(null);
          setCheckoutCanceled(false);
        }}
        onDone={(m) => toast(m)}
      />
      <FooterBar />
    </div>
  );
}

export default function Home() {
  return (
    <ToastHost>
      <main id="main">
        <HomeInner />
      </main>
    </ToastHost>
  );
}
