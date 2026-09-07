"use client";
import { useCallback, useEffect, useState } from "react";
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
import { ToastHost, useToast } from "../components/Toast";
import { MOCK_STAKES } from "../mocks/startups";

function HomeInner() {
  const toast = useToast();
  const [selected, setSelected] = useState<ElementNode | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [checkoutEl, setCheckoutEl] = useState<ElementNode | null>(null);
  const [checkoutAmt, setCheckoutAmt] = useState(5);

  const openStake = useCallback((el: ElementNode, amount: number) => {
    setCheckoutEl(el);
    setCheckoutAmt(amount);
  }, []);

  const openSymbol = useCallback((symbol: string) => {
    const el = ELEMENTS.find((e) => e.symbol === symbol);
    if (el) setSelected(el);
  }, []);

  const openDomain = useCallback((domain: string) => {
    const s = MOCK_STAKES.find((x) => x.domain === domain);
    if (s) openSymbol(s.symbol);
  }, [openSymbol]);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (searchOpen) setSearchOpen(false);
      else if (checkoutEl) setCheckoutEl(null);
      else if (selected) setSelected(null);
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [searchOpen, checkoutEl, selected]);

  const onPick = (p: SearchPick) => {
    openSymbol(p.symbol);
    setSearchOpen(false);
  };

  const claims: Record<string, { price: number; contested?: boolean; logoUrl?: string }> = {};
  for (const s of MOCK_STAKES) {
    const cur = claims[s.symbol];
    if (!cur || s.amount > cur.price) claims[s.symbol] = { price: s.amount, logoUrl: s.logo };
  }
  claims["C"] = { price: 50, contested: true, logoUrl: MOCK_STAKES.find((s) => s.symbol === "C")?.logo };
  claims["Au"] = { price: 88, contested: true, logoUrl: MOCK_STAKES.find((s) => s.symbol === "Au")?.logo };

  const claimedCount = Object.keys(claims).length;
  const totalBids = MOCK_STAKES.reduce((sum, stake) => sum + stake.amount, 0);

  return (
    <div className="stage-shell relative h-screen overflow-hidden text-ink">
      <TableCamera focusId={selected?.id ?? null}>
        <div className="periodic-object p-2">
          <PeriodicGrid
            claims={claims}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
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
        <StatsCard totalBids={totalBids} claimedCount={claimedCount} />
      </div>

      {/* activity */}
      <div className="absolute bottom-[18px] left-[18px] z-[var(--z-cards)] hidden md:block">
        <ActivityCard onOpen={openSymbol} />
      </div>

      {/* rail */}
      <div className="absolute bottom-[18px] right-[18px] z-[var(--z-rail)] hidden w-[385px] max-h-[calc(100vh-36px)] lg:block">
        <RailShell>
          {selected ? (
            <TerritoryView el={selected} onClose={() => setSelected(null)} onStake={openStake} />
          ) : (
            <WorldOrder onOpen={openDomain} />
          )}
        </RailShell>
      </div>

      {/* mobile territory */}
      {selected && (
        <div className="absolute inset-x-3 bottom-3 z-[var(--z-rail)] lg:hidden max-h-[70vh] overflow-auto">
          <RailShell>
            <TerritoryView el={selected} onClose={() => setSelected(null)} onStake={openStake} />
          </RailShell>
        </div>
      )}

      <HowItWorks open={howOpen} onClose={() => setHowOpen(false)} />
      <BoardMock open={boardOpen} onClose={() => setBoardOpen(false)} onOpen={openSymbol} />
      <CheckoutMock
        el={checkoutEl}
        open={!!checkoutEl}
        amount={checkoutAmt}
        onAmount={setCheckoutAmt}
        onClose={() => setCheckoutEl(null)}
        onDone={(m) => toast(m)}
      />
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
