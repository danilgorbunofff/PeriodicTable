/* Review 04 / R04-1…R04-4 — the element detail and pricing face.

   The finding set: a deep-link figure that stopped tracking the board (R04-1),
   a take quote promised on a board the client cannot see whole (R04-2), a
   settlement validator no code path called (R04-3), and one element reachable
   under many spellings of its symbol (R04-4). Each fix leaves exactly one place
   that decides — lib/stakeQuote.ts, prices.boardComplete, validateTake, and
   findElementBySymbol — and these tests hold those places to it. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { classifyAndValidate, validateTake } from "./pricing";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const count = (haystack: string, needle: RegExp) => (haystack.match(needle) ?? []).length;

const MODALS = "components/Modals.tsx";
const PAGE = "app/page.tsx";
const DETAIL_API = "app/api/elements/[sym]/route.ts";
const DETAIL_PAGE = "app/elements/[sym]/page.tsx";
const OG = "app/og/[sym]/route.tsx";
const CHECKOUT = "app/api/checkout/route.ts";

describe("R04-1 an app-minted amount keeps tracking the board", () => {
  it("lets the buyer's own hand end the tracking, and nothing else", () => {
    const page = src(PAGE);
    // Typing, the chips and "Use $N" all route through onAmount; the app's own
    // paths (the tile CTA, a `?stake=` link) write the amount directly and leave
    // the latch set, so `onAmount` is the only place that can hand it over.
    expect(page).toMatch(/const onCheckoutAmount = useCallback\(\(v: number\) => \{\s*setCheckoutAmtMinted\(false\);/);
    expect(page).toMatch(/onAmount=\{onCheckoutAmount\}/);
    expect(page).toMatch(/onReconcile=\{setCheckoutAmt\}/);
  });

  it("mints the amount on both app paths that write one", () => {
    const page = src(PAGE);
    expect(count(page, /setCheckoutAmtMinted\(true\)/g)).toBe(2);
    expect(page).toMatch(/const openStake = useCallback\(\(el: ElementNode, amount: number\) => \{[\s\S]{0,400}setCheckoutAmtMinted\(true\)/);
    expect(page).toMatch(/if \(knownAmt\) \{\s*setCheckoutAmt\(reclaimAmt\);\s*setCheckoutAmtMinted\(true\);/);
  });

  it("rewrites the field only against a board it can see whole", () => {
    const modals = src(MODALS);
    expect(modals).toMatch(/import \{ stakeQuote, crownCopy \} from "\.\.\/lib\/stakeQuote"/);
    expect(modals).toMatch(/amountMinted\?: boolean;/);
    expect(modals).toMatch(/onReconcile: \(n: number\) => void;/);
    expect(modals).toMatch(/const liveAmount = quote\.reconciledAmount;/);
    // The effect settles: it compares before writing, so a re-run is a no-op.
    expect(modals).toMatch(/if \(!open \|\| !amountMinted \|\| liveAmount == null\) return;/);
    expect(modals).toMatch(/if \(Math\.round\(amount\) === liveAmount\) return;\s*onReconcile\(liveAmount\);/);
  });

  it("renders the crown sentence from the live board, not a fixed '$5+' claim (R09-6)", () => {
    const modals = src(MODALS);
    // The hold the server names in its rejection is the same hold the modal
    // quotes, and the hold is read from the payload rather than re-derived.
    expect(modals).toMatch(/takeQuote: data\?\.takeHold \?\? null/);
    expect(modals).toMatch(/const crown =\s*need == null\s*\?\s*null\s*:\s*crownCopy\(\{\s*elementName: elSafe\.name,/);
    expect(modals).toMatch(/boardComplete: data\?\.prices\.boardComplete === true,/);
    expect(modals).toMatch(/heldUntil: heldByOtherUntil,\s*heldTotal: heldByOtherTotal,/);
    expect(modals).toMatch(/\{crown\.lead\}/);
    expect(modals).toMatch(/\{crown\.joins\}/);
    // The three static sentences this replaced cannot come back: the only
    // remaining copy site is the function in lib/stakeQuote.ts.
    expect(modals).not.toMatch(/Any \$5\+ amount joins the ladder/);
    expect(modals).not.toMatch(/takes #1 in \$\{el\.name\}/);
    expect(modals).not.toMatch(/reclaims #1 in \$\{el\.name\}/);
  });

  it("drops the stale price from the reclaim toast but keeps the event", () => {
    const page = src(PAGE);
    expect(page).toMatch(/toast\(`Reclaim \$\{found\.symbol\} below — your quote follows the live board\.`\)/);
    expect(page).not.toMatch(/Reclaim \$\{found\.symbol\} for \$/);
    // The click is still the conversion signal for the outbid mail (Phase 5).
    expect(page).toMatch(/track\("reclaim_click", \{ element: found\.symbol, amount: reclaimAmt \}\)/);
  });
});

describe("R04-2 a concealed listing is never promised", () => {
  it("counts concealed rows so the payload can say the board is partial", () => {
    const route = src(DETAIL_API);
    expect(route).toMatch(
      /prisma\.stake\.count\(\{ where: \{ element: \{ symbol \}, startup: \{ moderationState: "HIDDEN" \} \} \}\)/
    );
    expect(route).toMatch(/boardComplete: hiddenStakes === 0/);
    // The count may only answer "is this board whole": if it were also read per
    // visitor the flag would become a moderation oracle on a cached route.
    expect(count(route, /hiddenStakes/g)).toBe(2);
    expect(route).not.toMatch(/myPriorTotal|priorTotal/);
  });

  it("keeps ?me= priced off visible rows only", () => {
    const route = src(DETAIL_API);
    expect(route).toMatch(/const mine = element\.stakes\.find\(\(s\) => s\.startup\.domain === meParam\)/);
    expect(route).toMatch(/reclaimFor\(leaderTotal, mine\?\.amountUsd\)/);
    // A concealed row must never reach a priced field.
    expect(route).not.toMatch(/moderationState: "HIDDEN"[\s\S]{0,400}(reclaim|prices:)/);
  });

  it("withholds the hold sentence unless the take quote is real", () => {
    const modals = src(MODALS);
    expect(modals).toMatch(/boardLoaded: !!data,/);
    expect(modals).toMatch(/boardComplete: data\?\.prices\.boardComplete === true,/);
    expect(modals).toMatch(/takeQuoted \? " Your take quote is held for 15 min once you continue\." : ""/);
    expect(modals).not.toMatch(/priorHere \? " Your take quote/);
  });

  it("types the flag as optional, because old payloads lack it", () => {
    expect(src("lib/api.ts")).toMatch(/boardComplete\?: boolean;/);
  });
});

describe("R04-3 the take hold is checked before it is created", () => {
  it("is a guard the locked take path cannot pass without", () => {
    const route = src(CHECKOUT);
    expect(route).toMatch(/import \{[^}]*validateTake[^}]*\} from "@\/lib\/pricing"/);
    const guard = route.indexOf("validateTake(amountUsd, reservedTotal)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(route.indexOf("claimReservation.create"));
    expect(route).toMatch(/code: "BELOW_FLOOR", takeLead: reservedTotal/);
  });

  it("cannot reject what the classifier has already accepted as a take", () => {
    let takes = 0;
    for (const leaderTotal of [5, 20, 88]) {
      for (const amount of [1, 4, 5, 6, 20, 21, 22, 89, 500]) {
        const classified = classifyAndValidate({
          amount,
          leaderTotal,
          isNewHere: true,
          myPriorTotal: 0,
          existingTotals: [leaderTotal],
        });
        if (!classified.ok || classified.path !== "TAKE") continue;
        takes++;
        // The reservation quotes leader + 1 (app/api/checkout/route.ts).
        expect(validateTake(amount, leaderTotal + 1)).toBeNull();
        expect(amount).toBeGreaterThanOrEqual(leaderTotal + 1);
      }
    }
    expect(takes).toBeGreaterThan(0);
  });
});

describe("R04-4 one symbol names one element everywhere", () => {
  it("sends a non-canonical detail URL to the canonical one", () => {
    const page = src(DETAIL_PAGE);
    expect(page).toMatch(/import \{ notFound, redirect \} from "next\/navigation"/);
    expect(page).toMatch(/if \(el && el\.symbol !== symbol\) redirect\(`\/elements\/\$\{encodeURIComponent\(el\.symbol\)\}`\)/);
    // The row it reads is the canonical element, and the heading is too. `el` is
    // non-null by this point (`notFound()` when the symbol has no row — R15-10),
    // so the query can no longer fall back to the raw URL segment.
    expect(page).toMatch(/if \(!el\) notFound\(\)/);
    expect(page).toMatch(/where: \{ symbol: el\.symbol \}/);
  });

  it("canonicalises on every server surface that takes a symbol", () => {
    for (const p of [DETAIL_API, DETAIL_PAGE, OG, CHECKOUT]) {
      const file = src(p);
      expect(file).toMatch(/findElementBySymbol/);
      expect(file).not.toMatch(/\.toUpperCase\(\)/);
    }
    expect(src(DETAIL_API)).toMatch(/const symbol = findElementBySymbol\(raw\)\?\.symbol \?\? raw;/);
    expect(src(OG)).toMatch(/const symbol = findElementBySymbol\(raw\)\?\.symbol \?\? raw;/);
    expect(src(CHECKOUT)).toMatch(/const elementSymbol = findElementBySymbol\(elementSym\)\?\.symbol \?\? elementSym;/);
  });

  it("canonicalises the two client entry points too", () => {
    const page = src(PAGE);
    expect(page).toMatch(/import \{ ElementNode, findElementBySymbol \} from "\.\.\/lib\/elements"/);
    expect(page).toMatch(/const found = findElementBySymbol\(elParam\)/);
    expect(page).toMatch(/const el = findElementBySymbol\(symbol\)/);
    expect(page).not.toMatch(/\.toUpperCase\(\)/);
    // The modal asks for the symbol it was handed, and it is canonical by then.
    expect(src(MODALS)).toMatch(/useSWR<ElementDetail>\(open && el \? `\/api\/elements\/\$\{el\.symbol\}` : null/);
  });

  it("resolves through one inventory lookup", () => {
    const elements = src("lib/elements.ts");
    expect(count(elements, /export function findElementBySymbol/g)).toBe(1);
    // No surface may hand-roll the comparison and drift from the inventory.
    for (const p of [DETAIL_API, DETAIL_PAGE, OG, CHECKOUT, PAGE, MODALS]) {
      expect(src(p)).not.toMatch(/symbol\.toLowerCase\(\) === /);
    }
  });
});
