/* Review 03 / R03-2 — one predicate for "this tile is claimed".

   The finding: the tile face was filtered to directly-visible, non-zero stakes
   while `/api/stats.claimedElements` counted `Element.stakeCount`, which counts
   every stake including concealed ones. Hiding a listing therefore made the
   homepage report a claimed tile that `/api/elements` and the board drew empty.
   The money aggregates stay hidden-inclusive on purpose; the claim count now
   uses the same clause as the face. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ELEMENTS } from "./elements";
import { FACE_STAKE_WHERE, DIRECT_STATES, isDirectVisible } from "./moderation";

const src = (p: string) =>
  readFileSync(join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

type FakeStake = { amountUsd: number; startup: { moderationState: string } };

/** Interpreted from the clause, so a flipped filter fails the truth table. */
function ownsFace(stake: FakeStake): boolean {
  const states = FACE_STAKE_WHERE.startup.moderationState.in as readonly string[];
  const floor = FACE_STAKE_WHERE.amountUsd.gt;
  return states.includes(stake.startup.moderationState) && stake.amountUsd > floor;
}

const stake = (state: string, amountUsd: number): FakeStake => ({
  amountUsd,
  startup: { moderationState: state },
});

describe("R03-2 the face predicate", () => {
  it("is exactly the states the direct surfaces serve", () => {
    expect(DIRECT_STATES).toEqual(["VISIBLE", "UNLISTED"]);
    expect(FACE_STAKE_WHERE.startup.moderationState.in).toEqual(DIRECT_STATES);
    expect(FACE_STAKE_WHERE.amountUsd).toEqual({ gt: 0 });
  });

  it("agrees with the JS visibility helper for every state and amount", () => {
    for (const state of ["VISIBLE", "UNLISTED", "HIDDEN"]) {
      for (const amount of [0, 5]) {
        expect(ownsFace(stake(state, amount))).toBe(isDirectVisible(state as never) && amount > 0);
      }
    }
  });

  it("refuses the two stakes a tile must not show", () => {
    expect(ownsFace(stake("HIDDEN", 5000))).toBe(false); // concealed listing
    expect(ownsFace(stake("VISIBLE", 0))).toBe(false); // fully reversed charge
    expect(ownsFace(stake("UNLISTED", 5))).toBe(true); // direct link only, still owned
    expect(ownsFace(stake("VISIBLE", 5))).toBe(true);
  });
});

describe("R03-2 both readers use it", () => {
  it("filters the tile face with the shared clause", () => {
    const route = src("app/api/elements/route.ts");
    expect(route).toMatch(/import \{ FACE_STAKE_WHERE \} from "@\/lib\/moderation"/);
    expect(route).toMatch(/where: FACE_STAKE_WHERE,/);
    expect(route).not.toMatch(/moderationState: \{ in: DIRECT_STATES \}/);
  });

  it("counts claimed tiles with the same clause, not the denormalised counter", () => {
    const route = src("app/api/stats/route.ts");
    expect(route).toMatch(/import \{ FACE_STAKE_WHERE \} from "@\/lib\/moderation"/);
    expect(route).toMatch(/prisma\.element\.count\(\{ where: \{ stakes: \{ some: FACE_STAKE_WHERE \} \} \}\)/);
    expect(route).not.toMatch(/stakeCount: \{ gt: 0 \}/);
  });

  it("leaves no other surface counting claims from stakeCount", () => {
    for (const p of ["app/api/elements/route.ts", "app/api/stats/route.ts", "components/StatsCard.tsx"]) {
      expect(src(p)).not.toMatch(/stakeCount: \{ gt: 0 \}/);
    }
    // The element detail list stays on direct states too (HIDDEN excluded).
    expect(src("app/api/elements/[sym]/route.ts")).toMatch(/moderationState: \{ not: "HIDDEN" \}/);
  });

  it("says where it reads which number", () => {
    const api = src("lib/api.ts");
    expect(api).toMatch(/claimedElements`\/`unclaimedElements` count the tiles the board draws as\n \* claimed/);
    // R18-7 corrected this clause while adding `moneyScope` on the wire:
    // "concealed and reversed included" described neither reader (a refund
    // reduces the stake's `amountUsd`, so reversed money is not on the board at
    // all). The intent stands — the aggregates include concealed rows, say so,
    // and now name the ledger number they are *not*.
    expect(api).toMatch(/every stake row, concealed ones included/);
    expect(api).toMatch(/`money\.paidNetUsd`/);
    // The money aggregates are still hidden-inclusive, and say so.
    expect(src("app/api/elements/route.ts")).toMatch(/Deliberately hidden-inclusive/);
    expect(src("app/api/stats/route.ts")).toMatch(/remain hidden-inclusive board aggregates/);
    // R18-7 put the scope on the wire, so the reader of a 7-day chart cannot
    // compare it to the ledger number without the label disagreeing with them.
    expect(src("app/api/stats/route.ts")).toMatch(/moneyScope: "board"/);
  });

  it("counts every element exactly once, claimed or not", () => {
    // The served table is the denominator and the tiles are the whole truth:
    // every element not claimed here is a tile the board draws empty.
    const symbols = ELEMENTS.map((e) => e.symbol);
    expect(symbols).toHaveLength(122);
    expect(new Set(symbols).size).toBe(122);
  });
});
