"use client";
import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher, type Claim, type ActivityRow } from "../lib/api";
import { PeriodicGrid } from "../components/PeriodicGrid";
import { TableCamera } from "../components/TableCamera";
import { ELEMENTS, ElementNode } from "../lib/elements";
import { HeroCard } from "../components/HeroCard";
import { SearchPill, SearchPick } from "../components/SearchPill";
import { StatsCard } from "../components/StatsCard";
import { ActivityCard } from "../components/ActivityCard";
import { WorldOrder, RailShell } from "../components/WorldOrder";
import { TerritoryView } from "../components/TerritoryView";
import { HowItWorks, CheckoutMock, BoardMock } from "../components/Modals";
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
  const [expandOpen, setExpandOpen] = useState(false);

  // live table data (30s poll)
  const { data: tiles, mutate: mutateTiles } = useSWR<Tile[]>("/api/elements", fetcher, { refreshInterval: 30000 });
  const { data: statsData, mutate: mutateStats } = useSWR<{ elementsLive: number; totalBids: number; onSale: number }>(
    "/api/stats",
    fetcher,
    { refreshInterval: 30000 }
  );
  const { data: activity, mutate: mutateActivity } = useSWR<ActivityRow[]>("/api/activity?limit=6", fetcher, {
    refreshInterval: 30000,
  });

  const claims: Record<string, Claim> = {};
  for (const t of tiles ?? []) {
    if (t.leader) {
      claims[t.symbol] = {
        price: t.leader.amount,
        contested: t.count > 1,
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

  const claimedCount = statsData?.onSale ?? 0;
  const totalBids = statsData?.totalBids ?? 0;

  const openStake = useCallback((el: ElementNode, amount: number) => {
    setCheckoutEl(el);
    setCheckoutAmt(amount);
  }, []);

  const openSymbol = useCallback((symbol: string) => {
    const el = ELEMENTS.find((e) => e.symbol === symbol);
    if (el) setSelected(el);
  }, []);

  const onSelectTile = useCallback((el: ElementNode) => {
    track("tile_click", { element: el.symbol });
    setSelected(el);
    track("drawer_open", { element: el.symbol });
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (expandOpen) setExpandOpen(false);
      else if (searchOpen) setSearchOpen(false);
      else if (checkoutEl) setCheckoutEl(null);
      else if (selected) setSelected(null);
      else if (mobileRailOpen) setMobileRailOpen(false);
      else if (mobileActivityOpen) setMobileActivityOpen(false);
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [searchOpen, checkoutEl, selected, mobileRailOpen, mobileActivityOpen, expandOpen]);

  const onPick = (p: SearchPick) => {
    track("search_submit", { element: p.symbol });
    openSymbol(p.symbol);
    setSearchOpen(false);
    track("drawer_open", { element: p.symbol });
  };

  return (
    <div className="stage-shell relative h-screen overflow-hidden text-ink">
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
        <StatsCard totalBids={totalBids} claimedCount={claimedCount} elementsLive={statsData?.elementsLive ?? 122} />
      </div>

      {/* activity — desktop */}
      <div className="absolute bottom-[18px] left-[18px] z-[var(--z-cards)] hidden md:block">
        <ActivityCard rows={activity} onOpen={openSymbol} />
      </div>

      {/* activity — mobile/tablet FAB + popover */}
      <div className="md:hidden">
        <button
          aria-label="Live activity"
          aria-expanded={mobileActivityOpen}
          onClick={() => setMobileActivityOpen((v) => !v)}
          className="absolute bottom-[18px] left-[18px] z-[var(--z-cards)] h-11 w-11 rounded-full bg-white shadow-float grid place-items-center"
        >
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
          </span>
        </button>
        {mobileActivityOpen && (
          <div className="absolute bottom-[74px] left-[18px] z-[var(--z-cards)]">
            <ActivityCard
              rows={activity}
              onOpen={(s) => {
                openSymbol(s);
                setMobileActivityOpen(false);
              }}
            />
          </div>
        )}
      </div>

      {/* rail — desktop, always on */}
      <div className="absolute bottom-[18px] right-[18px] z-[var(--z-rail)] hidden w-[385px] max-h-[calc(100vh-36px)] lg:block">
        <RailShell>
          {selected ? (
            <TerritoryView el={selected} onClose={() => setSelected(null)} onStake={openStake} onExpand={() => setExpandOpen(true)} />
          ) : (
            <WorldOrder onExpand={() => setExpandOpen(true)} />
          )}
        </RailShell>
      </div>

      {/* rail — mobile/tablet FAB + bottom sheet */}
      <div className="lg:hidden">
        {!selected && (
          <button
            aria-label="Table order"
            aria-expanded={mobileRailOpen}
            onClick={() => setMobileRailOpen((v) => !v)}
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
                  onClose={() => setSelected(null)}
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
      <BoardMock open={boardOpen} onClose={() => setBoardOpen(false)} />
      <Modal
        open={expandOpen}
        onClose={() => setExpandOpen(false)}
        label={selected ? `${selected.name} — expanded view` : "Table Order — expanded view"}
        size="lg"
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
          <WorldOrder expanded />
        )}
      </Modal>
      <CheckoutMock
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
