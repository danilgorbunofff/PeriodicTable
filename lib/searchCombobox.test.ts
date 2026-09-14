/* Review 03 / R03-4 — the search field must not announce a popup it does not have.

   The finding: `aria-expanded="true"` was hardcoded while the listbox only
   renders at 2+ characters, and `aria-controls` pointed at an id that does not
   exist before then. Both now follow `showList`, the same expression that gates
   the list. The options already carried `aria-selected` when the finding was
   written (it named `li`s that are `div`/`button` here); the count check keeps
   it that way. Runtime behaviour (what a screen reader hears, and that the
   active option is the highlighted one) is browser QA, not this file. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const pill = src("components/SearchPill.tsx");

describe("R03-4 combobox state follows the popup", () => {
  it("expands only while the listbox is rendered", () => {
    expect(pill).toMatch(/const showList = q\.trim\(\)\.length >= 2;/);
    expect(pill).toMatch(/\{showList && \(/); // the listbox render gate
    expect(pill).toMatch(/aria-expanded=\{showList\}/);
    expect(pill).not.toMatch(/aria-expanded="true"/);
  });

  it("controls an id that exists exactly when it is set", () => {
    expect(pill).toMatch(/aria-controls=\{showList \? "search-results" : undefined\}/);
    expect(pill).toMatch(/id="search-results" role="listbox"/);
  });

  it("gives every option a selected state", () => {
    const options = pill.match(/role="option"/g) ?? [];
    const selected = pill.match(/aria-selected=\{/g) ?? [];
    expect(options).toHaveLength(2); // startup row + element row
    expect(selected).toHaveLength(options.length);
  });

  it("never points the active descendant at an unset id", () => {
    expect(pill).toMatch(/aria-activedescendant=\{results\[active\] \? `search-hit-\$\{active\}` : undefined\}/);
    expect(pill.match(/id=\{`search-hit-\$\{/g)).toHaveLength(2);
  });
});

describe("R03-4 the active index means the same row in both places", () => {
  it("keeps startups first in the payload", () => {
    // `search-hit-N` is an index into the rendered result list, so the pill's
    // option order and the API's row order must stay identical.
    expect(src("app/api/search/route.ts")).toMatch(/return apiJson\(\[\.\.\.startupHits, \.\.\.elementHits\]\.slice\(0, 8\)\)/);
  });

  it("numbers element options after the startup rows", () => {
    expect(pill).toMatch(/const startupHits = useMemo\(\(\) => \(hits \?\? \[\]\)\.filter\(\(h\) => h\.type === "startup"\), \[hits\]\)/);
    expect(pill).toMatch(/const elementHits = useMemo\(\(\) => \(hits \?\? \[\]\)\.filter\(\(h\) => h\.type === "element"\), \[hits\]\)/);
    expect(pill).toMatch(/const idx = startupHits\.length \+ i;/);
  });
});
