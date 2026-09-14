/**
 * Grid tile geometry (R03-1).
 *
 * The exotic pod used to be hand-positioned while the exotic columns were
 * hand-numbered, so when `03d8591` moved the tiles the pod box had to be edited
 * in the same commit — and the dataset/roadmap copies did not follow. Deriving
 * the box from `ELEMENTS` removes the second place to keep in sync: the pod is
 * drawn where the exotic tiles are, or it is not drawn at all.
 */
import { ELEMENTS, type ElementNode } from "./elements";

export const TILE_WIDTH = 48;
export const TILE_HEIGHT = 52;
export const GRID_GAP = 6;
/** The pod frame bleeds this far past the tiles it wraps, on every side. */
export const POD_BLEED = 14;

export type Box = { left: number; top: number; width: number; height: number };
export type Cell = { gridRow: number; gridCol: number };

/**
 * Layout position by symbol — the dataset's answer, for anyone publishing where
 * a tile sits.
 *
 * `Element.gridRow`/`gridCol` in the database are a seeded mirror, and a seed
 * that predates a reposition leaves them stale: on 2026-09-14 production
 * advertised `Hbar` at column 7 while the board drew it at 8 (R03-1). Nothing
 * reads those columns for layout, so the payload followed the stale value. The
 * route now publishes from here, which makes what it advertises identical to
 * what the board draws in every environment; a re-seed converges the mirror.
 */
export const ELEMENT_CELLS: ReadonlyMap<string, Cell> = new Map(
  ELEMENTS.map((el) => [el.symbol, { gridRow: el.gridRow, gridCol: el.gridCol }])
);

/** The dataset's position for a symbol, or `null` if it is not in the table. */
export function cellOf(symbol: string): Cell | null {
  return ELEMENT_CELLS.get(symbol) ?? null;
}

/** Left edge of a 1-based grid column, in the grid container's coordinates. */
export function cellLeft(gridCol: number): number {
  return (gridCol - 1) * (TILE_WIDTH + GRID_GAP);
}

/** Top edge of a 1-based rendered row (row 8 is the f-block spacer). */
export function cellTop(gridRow: number): number {
  return (gridRow - 1) * (TILE_HEIGHT + GRID_GAP);
}

/**
 * Bounding frame for the exotic pod: one contiguous row of EXOTIC tiles above
 * the f-block spacer, plus the standard bleed.
 *
 * `null` means the exotic tiles no longer sit in a layout this math describes
 * (scattered, split across rows, or in the f-block rows below the spacer, which
 * carry extra margin). The grid then draws no pod — and
 * `lib/datasetGeometry.test.ts` fails on the same data, so the move cannot
 * ship silently.
 */
export function exoticPodBox(elements: readonly ElementNode[] = ELEMENTS): Box | null {
  const exotics = elements.filter((el) => el.tier === "EXOTIC");
  if (exotics.length === 0) return null;
  const row = exotics[0].gridRow;
  if (row < 1 || row > 7) return null;
  if (exotics.some((el) => el.gridRow !== row)) return null;
  const cols = exotics.map((el) => el.gridCol).sort((a, b) => a - b);
  if (cols[cols.length - 1] - cols[0] + 1 !== cols.length) return null;
  const left = cellLeft(cols[0]) - POD_BLEED;
  return {
    left,
    top: cellTop(row) - POD_BLEED,
    // Right edge of the last exotic column, plus the right-hand bleed.
    width: cellLeft(cols[cols.length - 1]) + TILE_WIDTH - left + POD_BLEED,
    height: TILE_HEIGHT + POD_BLEED * 2,
  };
}
