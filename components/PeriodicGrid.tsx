import { ELEMENTS, ElementNode } from "../lib/elements";
import { Tile, TileClaim } from "./Tile";

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
  const cells: Record<string, ElementNode> = {};
  for (const el of ELEMENTS) cells[`${el.gridRow}-${el.gridCol}`] = el;

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
          className={
            selectedId === el.id ? "ring-2 ring-cta rounded-lg" : ""
          }
        >
          <Tile el={el} claim={claims[el.symbol]} onSelect={onSelect} />
        </div>
      );
    }
    rows.push(
      <div key={r} className={`grid gap-1.5 ${r >= 9 ? "mt-3" : ""}`} style={{ gridTemplateColumns: "repeat(18, 48px)" }}>
        {row}
      </div>
    );
  }
  return <div className="flex flex-col gap-1.5">{rows}</div>;
}
