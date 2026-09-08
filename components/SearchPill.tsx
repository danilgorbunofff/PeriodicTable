"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { fetchJson, isSearchHits, type SearchHit } from "../lib/api";
import { Avatar } from "./Avatar";

export type SearchPick = { symbol: string; elementName: string; domain?: string };

/**
 * Search pill (Phase 4, P1-06): server rows carry every rendered field.
 * Loading / error / empty states are explicit; stale results are never
 * retained across queries (no keepPreviousData).
 */
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

  const searching = open && debounced.length >= 2;
  const {
    data: hits,
    error,
    isLoading,
  } = useSWR<SearchHit[]>(
    searching ? `/api/search?q=${encodeURIComponent(debounced)}` : null,
    (url: string) => fetchJson(url, isSearchHits)
  );

  const results = useMemo<SearchPick[]>(() => {
    if (!hits) return [];
    return hits.map((h) =>
      h.type === "startup"
        ? { symbol: h.symbol, elementName: h.elementName, domain: h.domain }
        : { symbol: h.symbol, elementName: h.elementName }
    );
  }, [hits]);

  const startupHits = useMemo(() => (hits ?? []).filter((h) => h.type === "startup"), [hits]);
  const elementHits = useMemo(() => (hits ?? []).filter((h) => h.type === "element"), [hits]);

  useEffect(() => {
    setActive(0);
  }, [debounced]);

  useEffect(() => {
    if (active >= results.length) setActive(0);
  }, [active, results.length]);

  if (!open) return null;
  const showList = q.trim().length > 0;

  return (
    <div className="w-[360px] max-w-[calc(100vw-3rem)] bg-icy rounded-full shadow-float pl-5 pr-2 py-2 flex items-center gap-2">
      <span className="text-mutedink text-sm">🔍</span>
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
        className="flex-1 bg-transparent outline-none text-sm placeholder:text-mutedink"
      />
      <button
        aria-label="Search"
        onClick={() => {
          const pick = results[active] ?? results[0];
          if (pick) onPick(pick);
        }}
        className="w-9 h-9 rounded-full bg-visit text-white grid place-items-center text-sm [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px]"
      >
        →
      </button>
      {showList && (
        <div id="search-results" role="listbox" className="absolute top-full mt-2 left-0 w-[360px] max-w-[calc(100vw-3rem)] bg-white rounded-card shadow-card p-2 max-h-72 overflow-auto z-[var(--z-preview)]">
          {isLoading && (
            <div className="px-3 py-2 text-sm text-mutedink animate-pulse" role="status">Searching…</div>
          )}
          {!isLoading && error && (
            <div className="px-3 py-2 text-sm text-mutedink" role="alert">Search failed — check your connection and retry.</div>
          )}
          {!isLoading &&
            !error &&
            startupHits.map((s, i) => {
              if (s.type !== "startup") return null;
              return (
                <button
                  id={`search-hit-${i}`}
                  key={s.domain}
                  role="option"
                  aria-selected={active === i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => onPick({ symbol: s.symbol, elementName: s.elementName, domain: s.domain })}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-2xl text-left ${active === i ? "bg-icy" : ""}`}
                >
                  <Avatar src={s.logoUrl ?? undefined} domain={s.domain} size={20} rounded="rounded-full" />
                  <span className="text-sm font-bold">{s.domain}</span>
                  <span className="text-xs text-mutedink ml-auto">{s.symbol} {s.elementName}</span>
                  <span className="text-xs font-extrabold text-moneyink">${s.amount}</span>
                </button>
              );
            })}
          {!isLoading &&
            !error &&
            elementHits.map((e, i) => {
              if (e.type !== "element") return null;
              const idx = startupHits.length + i;
              return (
                <button
                  id={`search-hit-${idx}`}
                  key={e.symbol}
                  role="option"
                  aria-selected={active === idx}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => onPick({ symbol: e.symbol, elementName: e.elementName })}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-2xl text-left ${active === idx ? "bg-icy" : ""}`}
                >
                  <span className="text-sm font-extrabold w-8">{e.symbol}</span>
                  <span className="text-xs text-mutedink">{e.elementName}</span>
                  <span className="text-xs text-mutedink ml-auto">from $5</span>
                </button>
              );
            })}
          {!isLoading && !error && searching && (hits ?? []).length === 0 && (
            <div className="px-3 py-2 text-sm text-mutedink">
              No startup found — try a different name or symbol.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
