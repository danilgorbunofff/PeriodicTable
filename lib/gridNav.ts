/**
 * Pure grid-navigation math (Phase 5, P2-08). Operates on tile coordinates so
 * arrow/Home/End behavior is unit-testable; PeriodicGrid wires it to focus.
 */
export type GridCell = { id: number; gridRow: number; gridCol: number };

export function cellMap<T extends GridCell>(cells: T[]): Record<string, T> {
  const map: Record<string, T> = {};
  for (const el of cells) map[`${el.gridRow}-${el.gridCol}`] = el;
  return map;
}

/** Step one cell along an axis, skipping gaps and the row-8 spacer. */
export function stepCell<T extends GridCell>(
  map: Record<string, T>,
  from: T,
  dr: number,
  dc: number
): T | null {
  let r = from.gridRow + dr;
  let c = from.gridCol + dc;
  while (r >= 1 && r <= 10 && c >= 1 && c <= 18) {
    if (r === 8) {
      r += dr;
      continue;
    }
    const el = map[`${r}-${c}`];
    if (el) return el;
    if (dr !== 0 && dc === 0) r += dr;
    else if (dc !== 0 && dr === 0) c += dc;
    else break;
  }
  return null;
}

/** First/last occupied cell of a row (Home/End). */
export function rowEnd<T extends GridCell>(map: Record<string, T>, row: number, toStart: boolean): T | null {
  const cols = Object.keys(map)
    .filter((k) => k.startsWith(`${row}-`))
    .map((k) => Number(k.split("-")[1]))
    .sort((a, b) => a - b);
  if (cols.length === 0) return null;
  return map[`${row}-${toStart ? cols[0] : cols[cols.length - 1]}`] ?? null;
}
