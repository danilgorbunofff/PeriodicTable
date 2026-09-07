"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { ELEMENTS } from "../lib/elements";
import { fetcher } from "../lib/api";
import { Avatar } from "./Avatar";

export type SearchPick = { symbol: string; elementName: string; domain?: string };

type ApiHit = { type: "startup" | "element"; symbol: string; elementName: string; domain: string | null; title: string | null; logo: string | null; amount: number };

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
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data: apiHits } = useSWR<ApiHit[]>(
    open && debounced.length >= 2 ? `/api/search?q=${encodeURIComponent(debounced)}` : null,
    fetcher,
    { keepPreviousData: true }
  );

  const query = q.trim().toLowerCase();
  const stakeHits = useMemo(() => apiHits?.filter((h) => h.type === "startup" && h.domain) ?? [], [apiHits]);

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

  const results = useMemo<SearchPick[]>(
    () => [
      ...stakeHits.map((s) => ({ symbol: s.symbol, elementName: s.elementName, domain: s.domain ?? undefined })),
      ...elHits
        .filter((e) => !stakeHits.some((s) => s.symbol === e.symbol))
        .map((e) => ({ symbol: e.symbol, elementName: e.name })),
    ],
    [stakeHits, elHits]
  );

  useEffect(() => {
    setActive(0);
  }, [q]);

  if (!open) return null;

  return (
    <div className="w-[360px] max-w-[calc(100vw-3rem)] bg-icy rounded-full shadow-float pl-5 pr-2 py-2 flex items-center gap-2">
      <span className="text-muted text-sm">🔍</span>
      <input
        ref={inputRef}
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        role="combobox"
        aria-expanded="true"
        aria-controls="search-results"
        aria-activedescendant={results[active] ? `search-hit-${active}` : undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onClose();
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => (results.length ? (i + 1) % results.length : 0));
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
            return;
          }
          if (e.key === "Enter") {
            const pick = results[active] ?? results[0];
            if (pick) onPick(pick);
          }
        }}
        placeholder="find your startup..."
        className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted"
      />
      <button
        aria-label="Search"
        onClick={() => {
          const pick = results[active] ?? results[0];
          if (pick) onPick(pick);
        }}
        className="w-9 h-9 rounded-full bg-visit text-white grid place-items-center text-sm"
      >
        →
      </button>
      {query || stakeHits.length > 0 ? (
        <div id="search-results" role="listbox" className="absolute top-full mt-2 left-0 w-[360px] max-w-[calc(100vw-3rem)] bg-white rounded-card shadow-card p-2 max-h-72 overflow-auto z-[var(--z-preview)]">
          {stakeHits.map((s, i) => (
            <button
              id={`search-hit-${i}`}
              key={s.domain}
              role="option"
              aria-selected={active === i}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick({ symbol: s.symbol, elementName: s.elementName, domain: s.domain ?? undefined })}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-2xl text-left ${active === i ? "bg-icy" : ""}`}
            >
              <Avatar src={s.logo ?? undefined} domain={s.domain ?? ""} size={20} rounded="rounded-full" />
              <span className="text-sm font-bold">{s.domain}</span>
              <span className="text-xs text-muted ml-auto">{s.symbol} {s.elementName}</span>
              <span className="text-xs font-extrabold text-money">${s.amount}</span>
            </button>
          ))}
          {elHits.map((e, i) => {
            const idx = stakeHits.length + i;
            return (
              <button
                id={`search-hit-${idx}`}
                key={e.id}
                role="option"
                aria-selected={active === idx}
                onMouseEnter={() => setActive(idx)}
                onClick={() => onPick({ symbol: e.symbol, elementName: e.name })}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-2xl text-left ${active === idx ? "bg-icy" : ""}`}
              >
                <span className="text-sm font-extrabold w-8">{e.symbol}</span>
                <span className="text-xs text-muted">{e.name}</span>
                <span className="text-xs text-muted ml-auto">from $5</span>
              </button>
            );
          })}
          {query && stakeHits.length === 0 && elHits.length === 0 && debounced.length >= 2 && apiHits?.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted">
              No startup found — try a different name or symbol.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
