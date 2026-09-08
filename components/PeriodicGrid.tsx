import { useCallback, useEffect, useRef, useState } from "react";
import { ELEMENTS, ElementNode } from "../lib/elements";
import { cellMap, stepCell, rowEnd } from "../lib/gridNav";
import { Tile, TileClaim } from "./Tile";

/**
 * Roving-tabindex periodic grid (Phase 5, P2-08).
 *
 * The 122-tile table contributes ONE tab stop: arrows move between tiles,
 * Home/End jump to row ends, Enter/Space activates natively, Escape returns
 * focus to chrome (search toggle). role=grid semantics announce structure;
 * custom pan/zoom is untouched and browser zoom keeps working.
 */
export function PeriodicGrid({
  claims = {},
  selectedId,
  onSelect,
}: {
  claims?: Record<string, TileClaim>;
  selectedId?: number | null;
  onSelect?: (el: ElementNode) => void;
}) {
  // Rows 1–10 (7 table + exotic pod in row 2 + f-block rows 9–10)
  const cells = cellMap(ELEMENTS);

  const gridRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<number>(() => selectedId ?? ELEMENTS[0].id);

  // Mouse/touch selection also moves the roving stop.
  useEffect(() => {
    if (selectedId != null) setActiveId(selectedId);
  }, [selectedId]);

  const focusTile = useCallback((id: number) => {
    setActiveId(id);
    gridRef.current?.querySelector<HTMLElement>(`[data-el-id="${id}"] button`)?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const wrap = (e.target as HTMLElement).closest("[data-el-id]");
    const id = wrap ? Number(wrap.getAttribute("data-el-id")) : null;
    const from = ELEMENTS.find((el) => el.id === id);
    if (!from) return;
    let next: ElementNode | null = null;
    if (e.key === "ArrowRight") next = stepCell(cells, from, 0, 1);
    else if (e.key === "ArrowLeft") next = stepCell(cells, from, 0, -1);
    else if (e.key === "ArrowDown") next = stepCell(cells, from, 1, 0);
    else if (e.key === "ArrowUp") next = stepCell(cells, from, -1, 0);
    else if (e.key === "Home") next = rowEnd(cells, from.gridRow, true);
    else if (e.key === "End") next = rowEnd(cells, from.gridRow, false);
    else if (e.key === "Escape") {
      // Documented way back to chrome: focus the search toggle.
      e.stopPropagation();
      document.getElementById("chrome-search-toggle")?.focus();
      return;
    } else return;
    if (next) {
      e.preventDefault();
      e.stopPropagation(); // keep camera pan from also firing (P2-11)
      focusTile(next.id);
    }
  };

  const rows = [];
  for (let r = 1; r <= 10; r++) {
    if (r === 8) continue; // spacer row between table and f-block — never rendered
    const row = [];
    for (let c = 1; c <= 18; c++) {
      const el = cells[`${r}-${c}`];
      if (!el) {
        row.push(<div key={`${r}-${c}`} />);
        continue;
      }
      row.push(
        <div
          key={`${r}-${c}`}
          data-el-id={el.id}
          role="gridcell"
          className={
            selectedId === el.id ? "ring-2 ring-cta rounded-lg" : ""
          }
        >
          <Tile el={el} claim={claims[el.symbol]} onSelect={onSelect} tabIndex={el.id === activeId ? 0 : -1} />
        </div>
      );
    }
    rows.push(
      <div key={r} role="row" className={`grid gap-1.5 ${r >= 9 ? "mt-3" : ""}`} style={{ gridTemplateColumns: "repeat(18, 48px)" }}>
        {row}
      </div>
    );
  }
  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label="Periodic table of startup territories. Arrow keys move, Enter opens a territory, Escape returns to search."
      onKeyDown={onKeyDown}
      className="flex flex-col gap-1.5"
    >
      {rows}
    </div>
  );
}
