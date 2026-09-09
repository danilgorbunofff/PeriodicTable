import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ELEMENTS, ElementNode } from "../lib/elements";
import { cellMap, stepCell, rowEnd } from "../lib/gridNav";
import { Tile, TileClaim } from "./Tile";

const TILE_WIDTH = 48;
const TILE_HEIGHT = 52;
const GRID_GAP = 6;
const EXOTIC_POD = {
  left: 7 * (TILE_WIDTH + GRID_GAP) - 14,
  top: TILE_HEIGHT + GRID_GAP - 14,
  width: 4 * TILE_WIDTH + 3 * GRID_GAP + 28,
  height: TILE_HEIGHT + 28,
} as const;

type PodStar = {
  x: number;
  y: number;
  size: number;
  opacity: number;
  drift: number;
  delay: number;
  twinkle: number;
  twinkleDelay: number;
  depth: "far" | "near";
  cross?: boolean;
};

/** Deterministic two-plane starfield; placement favors the visible rim and tile gaps. */
const POD_STARS = [
  { x: 4, y: 18, size: 1, opacity: 0.45, drift: 24, delay: -8, twinkle: 3.1, twinkleDelay: -1.2, depth: "far" },
  { x: 13, y: 88, size: 1, opacity: 0.4, drift: 27, delay: -19, twinkle: 2.7, twinkleDelay: -0.5, depth: "far" },
  { x: 25, y: 8, size: 1.5, opacity: 0.52, drift: 25, delay: -12, twinkle: 3.5, twinkleDelay: -2.1, depth: "far" },
  { x: 35, y: 76, size: 1, opacity: 0.46, drift: 29, delay: -4, twinkle: 2.9, twinkleDelay: -1.5, depth: "far" },
  { x: 47, y: 20, size: 1, opacity: 0.38, drift: 26, delay: -22, twinkle: 3.8, twinkleDelay: -0.8, depth: "far" },
  { x: 57, y: 90, size: 1.5, opacity: 0.5, drift: 28, delay: -15, twinkle: 3.2, twinkleDelay: -2.4, depth: "far" },
  { x: 68, y: 12, size: 1, opacity: 0.43, drift: 30, delay: -6, twinkle: 2.6, twinkleDelay: -1.1, depth: "far" },
  { x: 79, y: 80, size: 1, opacity: 0.48, drift: 25, delay: -18, twinkle: 3.6, twinkleDelay: -0.2, depth: "far" },
  { x: 91, y: 25, size: 1.5, opacity: 0.4, drift: 27, delay: -10, twinkle: 3, twinkleDelay: -1.9, depth: "far" },
  { x: 8, y: 62, size: 2, opacity: 0.75, drift: 17, delay: -5, twinkle: 2.1, twinkleDelay: -0.7, depth: "near" },
  { x: 24, y: 42, size: 4, opacity: 0.82, drift: 19, delay: -14, twinkle: 2.5, twinkleDelay: -1.8, depth: "near", cross: true },
  { x: 39, y: 92, size: 2, opacity: 0.68, drift: 16, delay: -9, twinkle: 1.9, twinkleDelay: -0.3, depth: "near" },
  { x: 53, y: 7, size: 2, opacity: 0.72, drift: 20, delay: -17, twinkle: 2.3, twinkleDelay: -1.4, depth: "near" },
  { x: 68, y: 55, size: 4, opacity: 0.78, drift: 18, delay: -3, twinkle: 2.7, twinkleDelay: -0.9, depth: "near", cross: true },
  { x: 84, y: 90, size: 2, opacity: 0.7, drift: 21, delay: -12, twinkle: 2, twinkleDelay: -1.6, depth: "near" },
  { x: 95, y: 48, size: 2, opacity: 0.74, drift: 17, delay: -7, twinkle: 2.4, twinkleDelay: -0.4, depth: "near" },
] satisfies readonly PodStar[];

function ExoticPod() {
  return (
    <div
      aria-hidden="true"
      className="exotic-pod"
      style={{
        left: EXOTIC_POD.left,
        top: EXOTIC_POD.top,
        width: EXOTIC_POD.width,
        height: EXOTIC_POD.height,
      }}
    >
      <div className="exotic-pod__shell">
        <div className="exotic-pod__nebula" />
        <div className="exotic-pod__stars">
          {POD_STARS.map((star, i) => (
            <span
              key={i}
              className={`exotic-star exotic-star--${star.depth}${star.cross ? " exotic-star--cross" : ""}`}
              style={
                {
                  left: `${star.x}%`,
                  top: `${star.y}%`,
                  width: star.size + (star.depth === "near" ? 0.75 : 0.5),
                  height: star.size + (star.depth === "near" ? 0.75 : 0.5),
                  "--star-opacity": Math.min(
                    1,
                    star.opacity + (star.depth === "near" ? 0.16 : 0.22)
                  ),
                  "--star-min-opacity": Math.max(
                    0.25,
                    star.opacity * (star.depth === "near" ? 0.64 : 0.5)
                  ),
                  "--star-drift": `${star.drift * (star.depth === "near" ? 0.48 : 0.54)}s`,
                  "--star-delay": `${star.delay}s`,
                  "--star-twinkle": `${star.twinkle * 0.68}s`,
                  "--star-twinkle-delay": `${star.twinkleDelay}s`,
                } as CSSProperties
              }
            />
          ))}
        </div>
        <div className="exotic-pod__sweep" />
        <div className="exotic-pod__vignette" />
      </div>
      <svg
        className="exotic-pod__rim"
        viewBox={`0 0 ${EXOTIC_POD.width} ${EXOTIC_POD.height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="exotic-rim-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#d8f2ff" stopOpacity="0.82" />
            <stop offset="0.36" stopColor="#7f8cff" stopOpacity="0.68" />
            <stop offset="0.72" stopColor="#54d8ff" stopOpacity="0.54" />
            <stop offset="1" stopColor="#e8f8ff" stopOpacity="0.36" />
          </linearGradient>
        </defs>
        <rect
          x="0.75"
          y="0.75"
          width={EXOTIC_POD.width - 1.5}
          height={EXOTIC_POD.height - 1.5}
          rx="17"
          fill="none"
          stroke="url(#exotic-rim-gradient)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <svg
        className="exotic-pod__tab"
        width="100"
        height="25"
        viewBox="0 0 100 25"
        textRendering="geometricPrecision"
        shapeRendering="geometricPrecision"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="exotic-tab-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#263f80" />
            <stop offset="1" stopColor="#0d183d" />
          </linearGradient>
          <linearGradient id="exotic-tab-stroke" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#cdeeff" stopOpacity="0.82" />
            <stop offset="0.48" stopColor="#7d91ff" stopOpacity="0.72" />
            <stop offset="1" stopColor="#62d8ff" stopOpacity="0.58" />
          </linearGradient>
        </defs>
        <rect
          x="0.75"
          y="0.75"
          width="98.5"
          height="23.5"
          rx="9"
          fill="url(#exotic-tab-fill)"
          stroke="url(#exotic-tab-stroke)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        <g transform="translate(9 6.74) scale(.72)">
          <path
            fill="#f0fbff"
            d="M8 0c.44 4.76 3.24 7.56 8 8-4.76.44-7.56 3.24-8 8-.44-4.76-3.24-7.56-8-8 4.76-.44 7.56-3.24 8-8Z"
          />
        </g>
        <g transform="translate(79.5 6.74) scale(.72)">
          <path
            fill="#f0fbff"
            d="M8 0c.44 4.76 3.24 7.56 8 8-4.76.44-7.56 3.24-8 8-.44-4.76-3.24-7.56-8-8 4.76-.44 7.56-3.24 8-8Z"
          />
        </g>
        <text
          x="27"
          y="16.8"
          fill="#e4f6ff"
          fontFamily="var(--font-display), Fredoka, system-ui, sans-serif"
          fontSize="11"
          fontWeight="800"
          letterSpacing="1.25"
        >
          EXOTIC
        </text>
      </svg>
    </div>
  );
}

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
    // preventScroll: native focus scrolling would pan the overflow:hidden
    // camera viewport and desync it from the transform-based camera.
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-el-id="${id}"] button`)
      ?.focus({ preventScroll: true });
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
  const fBlockRows = [];
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
    const rowDiv = (
      <div
        key={r}
        role="row"
        className="relative z-[1] grid gap-1.5"
        style={{ gridTemplateColumns: "repeat(18, 48px)" }}
      >
        {row}
      </div>
    );
    // Lanthanides + actinides render as one grouped block: single mt-3 to the
    // main table, standard 6px gap between the two rows (no extra separation).
    if (r >= 9) fBlockRows.push(rowDiv);
    else rows.push(rowDiv);
  }
  rows.push(
    <div key="f-block" role="rowgroup" className="flex flex-col gap-1.5 mt-3">
      {fBlockRows}
    </div>
  );
  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label="Periodic table of startups. Arrow keys move, Enter opens an element, Escape returns to search."
      onKeyDown={onKeyDown}
      className="relative isolate flex flex-col gap-1.5"
    >
      <ExoticPod />
      {rows}
    </div>
  );
}
