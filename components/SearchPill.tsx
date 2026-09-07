"use client";
import { useMemo, useRef, useState } from "react";
import { ELEMENTS } from "../lib/elements";
import { MOCK_STAKES } from "../mocks/startups";

export type SearchPick = { symbol: string; elementName: string; domain?: string };

export function SearchPill({
  open,
  onPick,
  onClose,
}: {
  open: boolean;
  onPick: (p: SearchPick) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const query = q.trim().toLowerCase();
  const stakeHits = (query
    ? MOCK_STAKES.filter(
        (s) =>
          s.domain.toLowerCase().includes(query) ||
          s.title.toLowerCase().includes(query) ||
          s.symbol.toLowerCase() === query ||
          s.elementName.toLowerCase().includes(query)
      )
    : MOCK_STAKES.slice(0, 5)
  ).slice(0, 8);

  const elHits = useMemo(
    () =>
      query
        ? ELEMENTS.filter(
            (e) =>
              e.symbol.toLowerCase().includes(query) ||
              e.name.toLowerCase().includes(query)
          ).slice(0, 4)
        : [],
    [query]
  );

  if (!open) return null;

  return (
    <div className="w-[360px] max-w-[calc(100vw-3rem)] bg-icy rounded-full shadow-float pl-5 pr-2 py-2 flex items-center gap-2">
      <span className="text-muted text-sm">🔍</span>
      <input
        ref={inputRef}
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") {
            const first = stakeHits[0];
            if (first) onPick({ symbol: first.symbol, elementName: first.elementName, domain: first.domain });
            else if (elHits[0]) onPick({ symbol: elHits[0].symbol, elementName: elHits[0].name });
          }
        }}
        placeholder="find your startup..."
        className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted"
      />
      <button
        aria-label="Search"
        onClick={() => {
          const first = stakeHits[0];
          if (first) onPick({ symbol: first.symbol, elementName: first.elementName, domain: first.domain });
        }}
        className="w-9 h-9 rounded-full bg-visit text-white grid place-items-center text-sm"
      >
        →
      </button>
      {query || stakeHits.length > 0 ? (
        <div className="absolute top-full mt-2 left-0 w-[360px] max-w-[calc(100vw-3rem)] bg-white rounded-card shadow-card p-2 max-h-72 overflow-auto z-[var(--z-preview)]">
          {stakeHits.map((s) => (
            <button
              key={s.domain + s.symbol}
              onClick={() => onPick({ symbol: s.symbol, elementName: s.elementName, domain: s.domain })}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-2xl hover:bg-icy text-left"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.logo} alt="" className="w-5 h-5 rounded-full" />
              <span className="text-sm font-bold">{s.domain}</span>
              <span className="text-xs text-muted ml-auto">{s.symbol} {s.elementName}</span>
              <span className="text-xs font-extrabold text-money">${s.amount}</span>
            </button>
          ))}
          {elHits.map((e) => (
            <button
              key={e.id}
              onClick={() => onPick({ symbol: e.symbol, elementName: e.name })}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-2xl hover:bg-icy text-left"
            >
              <span className="text-sm font-extrabold w-8">{e.symbol}</span>
              <span className="text-xs text-muted">{e.name}</span>
              <span className="text-xs text-muted ml-auto">from $5</span>
            </button>
          ))}
          {query && stakeHits.length === 0 && elHits.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted">
              No startup found — claim {q.trim()} on C?
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
