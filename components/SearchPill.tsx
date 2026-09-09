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
  // Appear/disappear animation: keep the pill mounted ~one animation frame
  // after `open` flips false so the exit keyframe can play.
  const [render, setRender] = useState(open);
  const [leaving, setLeaving] = useState(false);

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

  useEffect(() => {
    if (open) {
      setRender(true);
      setLeaving(false);
      return;
    }
    if (!render) return;
    setLeaving(true);
    const t = setTimeout(() => setRender(false), 180);
    return () => clearTimeout(t);
  }, [open, render]);

  if (!render) return null;
  // The dropdown needs 2+ chars to have content (the API is only queried
  // then) — never render an empty box on a single character.
  const showList = q.trim().length >= 2;

  return (
    <div className={`w-full sm:w-[360px] sm:max-w-[calc(100vw-3rem)] bg-icy rounded-full shadow-float pl-5 pr-2 py-2 flex items-center gap-2 ${leaving ? "animate-search-out" : "animate-search-in"}`}>
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
        <div id="search-results" role="listbox" className="absolute top-full mt-2 left-0 right-0 w-full sm:left-0 sm:right-auto sm:w-[360px] sm:max-w-[calc(100vw-3rem)] bg-white rounded-card shadow-card p-2 max-h-72 overflow-auto z-[var(--z-preview)]">
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
              const extra = s.elementCount - s.elements.length;
              return (
                <div
                  id={`search-hit-${i}`}
                  key={s.domain}
                  role="option"
                  aria-selected={active === i}
                  onMouseEnter={() => setActive(i)}
                  className={`w-full px-3 py-2 rounded-2xl ${active === i ? "bg-icy/60 outline outline-1 outline-cta/60" : ""}`}
                >
                  <button
                    onClick={() => onPick({ symbol: s.symbol, elementName: s.elementName, domain: s.domain })}
                    className="w-full flex items-center gap-2 text-left"
                  >
                    <Avatar src={s.logoUrl ?? undefined} domain={s.domain} size={20} rounded="rounded-full" />
                    <span className="text-sm font-bold">{s.domain}</span>
                    <span className="text-xs font-extrabold text-moneyink ml-auto">${s.amount}</span>
                  </button>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-7">
                    {s.elements.map((owned) => (
                      <button
                        key={owned.symbol}
                        title={`${owned.symbol} ${owned.elementName}`}
                        onClick={() => onPick({ symbol: owned.symbol, elementName: owned.elementName, domain: s.domain })}
                        className="rounded-full bg-icy px-2 py-0.5 text-[11px] font-extrabold text-ink hover:ring-1 hover:ring-cta"
                      >
                        {owned.symbol} · ${owned.amount}
                      </button>
                    ))}
                    {extra > 0 && (
                      <span className="text-[11px] font-bold text-mutedink">+{extra} more</span>
                    )}
                  </div>
                </div>
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
