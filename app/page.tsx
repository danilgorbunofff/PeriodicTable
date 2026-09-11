"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { fetchJson, isStatsResponse, isActivityRows, type Claim, type ActivityRow, type StatsResponse } from "../lib/api";
import { PeriodicGrid } from "../components/PeriodicGrid";
import { TableCamera } from "../components/TableCamera";
import { BackgroundSymbols } from "../components/BackgroundSymbols";
import { ELEMENTS, ElementNode } from "../lib/elements";
import { HeroCard } from "../components/HeroCard";
import { SearchPill, SearchPick } from "../components/SearchPill";
import { StatsCard } from "../components/StatsCard";
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

function HomeInner() {
  const toast = useToast();
  const [selected, setSelected] = useState<ElementNode | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [checkoutEl, setCheckoutEl] = useState<ElementNode | null>(null);
  const [checkoutAmt, setCheckoutAmt] = useState(5);
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
  const { data: tiles, mutate: mutateTiles } = useSWR<Tile[]>("/api/elements", fetchJson, { refreshInterval: 30000 });
  const { data: statsData, mutate: mutateStats } = useSWR<StatsResponse>("/api/stats", (url: string) => fetchJson(url, isStatsResponse), {
    refreshInterval: 30000,
  });
  const { data: activity, mutate: mutateActivity } = useSWR<ActivityRow[]>("/api/activity?limit=6", (url: string) => fetchJson(url, isActivityRows), {
    refreshInterval: 30000,
  });

  const claims: Record<string, Claim> = {};
  for (const t of tiles ?? []) {
    if (t.leader) {
      claims[t.symbol] = {
        price: t.leader.amount,
        logoUrl: t.leader.logoUrl,
      };
    }
  }

  // Deep links: /?paid=SYM (post-checkout success), /?unsub=done|unknown,
  // /?el=SYM&stake=N&email=E (outbid reclaim prefill from email).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paid = params.get("paid");
    const unsub = params.get("unsub");
    const elParam = params.get("el");
    const stakeParam = params.get("stake");
    if (paid) {
      if (paid !== "1") openSymbol(paid);
      toast("Payment confirmed — you're live! 🎉");
      track("checkout_paid", { element: paid });
      // Refresh every cached endpoint so tiles/ranks reflect the new stake.
      mutateTiles();
      mutateStats();
      mutateActivity();
    }
    if (elParam) {
      const found = ELEMENTS.find((e) => e.symbol === elParam);
      if (found) {
        setSelected(found);
        const reclaimAmt = stakeParam ? parseInt(stakeParam, 10) : NaN;
        if (Number.isInteger(reclaimAmt) && reclaimAmt >= 1) {
          setCheckoutEl(found);
          setCheckoutAmt(reclaimAmt);
          toast(`Reclaim ${elParam} for $${reclaimAmt} — past stake still counts.`);
          track("reclaim_click", { element: elParam, amount: reclaimAmt });
        }
      }
    }
    if (unsub === "done") toast("You're unsubscribed. Past stake still counts.");
    if (unsub === "unknown") toast("Already unsubscribed or unknown link.");
    if (paid || unsub || elParam) window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const claimedCount = statsData?.claimedElements ?? 0;
  const totalStakedUsd = statsData?.totalStakedUsd ?? 0;

  const openStake = useCallback((el: ElementNode, amount: number) => {
    setCheckoutEl(el);
    setCheckoutAmt(amount);
  }, []);

  const openSymbol = useCallback((symbol: string) => {
    const el = ELEMENTS.find((e) => e.symbol === symbol);
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
          <PeriodicGrid
            claims={claims}
            selectedId={selected?.id ?? null}
            onSelect={onSelectTile}
          />
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
        <StatsCard totalStakedUsd={totalStakedUsd} claimedCount={claimedCount} elementsLive={statsData?.elementsTotal ?? 122} />
      </div>

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
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
            </span>
          </button>
        ) : (
          <ActivityCard rows={activity} onMinimize={() => setActMin(true)} />
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
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
          </span>
        </button>
        {mobileActivityOpen && (
          <div className="absolute inset-x-3 bottom-3 z-[var(--z-rail)] max-h-[70vh] overflow-auto">
            <ActivityCard rows={activity} fluid onClose={() => setMobileActivityOpen(false)} />
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
        onAmount={setCheckoutAmt}
        onClose={() => setCheckoutEl(null)}
        onDone={(m) => toast(m)}
      />
      <FooterBar />
    </div>
  );
}

export default function Home() {
  return (
    <ToastHost>
      <HomeInner />
    </ToastHost>
  );
}
