import { describe, it, expect } from "vitest";
import { stakeQuote, joinSpace, crownCopy } from "./stakeQuote";
import { classifyAndValidate, takeLeadPrice, reclaimFor, smallestFreeAmount } from "./pricing";

/* Review 04 (doc/review/04-element-detail-and-pricing.md) — the checkout form's
   two money claims, tested without a browser: the figure the app wrote into the
   amount field (R04-1) and the 15-minute hold the copy promises (R04-2). */

const board = {
  boardLoaded: true,
  boardComplete: true,
  takeLead: undefined as number | undefined,
  leaderTotal: undefined as number | undefined,
  domainKnown: false,
  priorTotal: 0,
  amount: 0,
};

const quote = (over: Partial<typeof board> = {}) => stakeQuote({ ...board, ...over });

describe("stakeQuote — what the field may hold (R04-1)", () => {
  it("stays silent until the element payload lands", () => {
    const q = quote({ boardLoaded: false, leaderTotal: 20, takeLead: 21, amount: 21 });
    expect(q.need).toBeNull();
    expect(q.reconciledAmount).toBeNull();
    expect(q.takeQuoted).toBe(false);
  });

  it("reprices a stale outbid figure to the live reclaim delta", () => {
    // Outbid mail priced $2 off a $20 board that has since grown to $21.
    const q = quote({ leaderTotal: 21, takeLead: 22, domainKnown: true, priorTotal: 20, amount: 2 });
    expect(q.priorHere).toBe(true);
    expect(q.need).toBe(reclaimFor(21, 20));
    expect(q.reconciledAmount).toBe(2);
    expect(q.belowNeed).toBe(false);
    // A grown board: the delta the mail quoted is now too small.
    const grown = quote({ leaderTotal: 30, takeLead: 31, domainKnown: true, priorTotal: 20, amount: 2 });
    expect(grown.reconciledAmount).toBe(11);
  });

  it("does not read the current field value into the rewrite it orders", () => {
    // No oscillation: whatever the field holds, the reconcile target is one
    // number, so the effect that writes it can run twice and settle.
    const inputs = { leaderTotal: 21, takeLead: 22, domainKnown: true, priorTotal: 20 } as const;
    const a = quote({ ...inputs, amount: 2 }).reconciledAmount;
    const b = quote({ ...inputs, amount: 999 }).reconciledAmount;
    expect(a).toBe(b);
    expect(a).toBe(2);
  });

  it("mirrors the take price for a newcomer", () => {
    const q = quote({ leaderTotal: 20, takeLead: takeLeadPrice(20), amount: 5 });
    expect(q.priorHere).toBe(false);
    expect(q.need).toBe(21);
    expect(q.reconciledAmount).toBe(21);
  });

  it("leaves a first bid on an empty tile alone", () => {
    const q = quote({ amount: 5 });
    expect(q.need).toBe(5);
    expect(q.reconciledAmount).toBe(5);
    expect(q.alreadyLead).toBe(false);
  });

  it("floors an overdue reclaim at $1", () => {
    const q = quote({ leaderTotal: 5, takeLead: 6, domainKnown: true, priorTotal: 30, amount: 1 });
    expect(q.need).toBe(1);
    expect(q.alreadyLead).toBe(true);
    expect(q.belowNeed).toBe(false);
  });
});

describe("stakeQuote — what the copy may promise (R04-2)", () => {
  it("withholds a hold on a board with concealed rows", () => {
    const q = quote({ boardComplete: false, leaderTotal: 20, takeLead: 21, amount: 21 });
    expect(q.takeQuoted).toBe(false);
    // ...and it must not restate a newcomer figure it cannot price either.
    expect(q.need).toBe(21);
    expect(q.reconciledAmount).toBeNull();
  });

  it("still reconciles a holder whose own row the board shows", () => {
    const q = quote({ boardComplete: false, leaderTotal: 21, takeLead: 22, domainKnown: true, priorTotal: 20, amount: 2 });
    expect(q.reconciledAmount).toBe(2);
  });

  it("promises the hold for a newcomer reaching the visible take price", () => {
    const short = quote({ leaderTotal: 20, takeLead: 21, amount: 20 });
    const reached = quote({ leaderTotal: 20, takeLead: 21, amount: 21 });
    expect(short.takeQuoted).toBe(false);
    expect(reached.takeQuoted).toBe(true);
  });

  it("never promises a hold to a returning holder or a leader", () => {
    expect(quote({ leaderTotal: 20, takeLead: 21, domainKnown: true, priorTotal: 12, amount: 9 }).takeQuoted).toBe(false);
    expect(quote({ leaderTotal: 20, takeLead: 21, domainKnown: true, priorTotal: 25, amount: 1 }).takeQuoted).toBe(false);
  });

  it("does not call the first bid on an empty tile a held take", () => {
    // No reservation exists for an empty tile: the server classifies it JOIN.
    const q = quote({ amount: 5 });
    expect(q.takeQuoted).toBe(false);
  });
});

describe("stakeQuote — below-need notice", () => {
  it("flags a holder paying less than the reclaim, and only then", () => {
    const held = { leaderTotal: 21, takeLead: 22, domainKnown: true, priorTotal: 12 };
    expect(quote({ ...held, amount: 5 }).belowNeed).toBe(true);
    expect(quote({ ...held, amount: 9 }).belowNeed).toBe(true);
    expect(quote({ ...held, amount: 10 }).belowNeed).toBe(false);
    expect(quote({ ...held, amount: 0 }).belowNeed).toBe(false);
  });

  it("does not nag a newcomer or a board it cannot price", () => {
    expect(quote({ leaderTotal: 20, takeLead: 21, amount: 5 }).belowNeed).toBe(false);
    expect(quote({ boardLoaded: false, domainKnown: true, priorTotal: 12, amount: 5 }).belowNeed).toBe(false);
  });
});

describe("stakeQuote — agrees with the server's classification", () => {
  // The claim the client makes has to be the verdict the server will reach on
  // the same board, or the modal promises a hold `/api/checkout` never writes.
  const leaders = [undefined, 20, 88];
  const priors = [0, 12, 20, 30];
  const amounts = [1, 4, 5, 6, 9, 10, 20, 21, 22, 50, 89];

  it("calls a take exactly when /api/checkout classifies one", () => {
    let takes = 0;
    for (const leaderTotal of leaders) {
      for (const priorTotal of priors) {
        const isNewHere = priorTotal === 0;
        const existingTotals = [leaderTotal, ...(priorTotal > 0 ? [priorTotal] : [])].filter(
          (n): n is number => n != null
        );
        for (const amount of amounts) {
          const q = quote({
            boardComplete: true,
            leaderTotal,
            takeLead: takeLeadPrice(leaderTotal),
            domainKnown: priorTotal > 0,
            priorTotal,
            amount,
          });
          const verdict = classifyAndValidate({
            amount,
            leaderTotal,
            isNewHere,
            myPriorTotal: priorTotal,
            existingTotals,
          });
          const serverTake = verdict.ok && verdict.path === "TAKE";
          expect([leaderTotal, priorTotal, amount, q.takeQuoted]).toEqual([
            leaderTotal,
            priorTotal,
            amount,
            serverTake,
          ]);
          if (serverTake) takes++;
        }
      }
    }
    // Guard against a vacuous pass: the matrix must contain real takes.
    expect(takes).toBeGreaterThan(0);
  });

  it("quotes a holder the same delta the server would need", () => {
    for (const leaderTotal of [5, 20, 88]) {
      for (const priorTotal of [1, 12, 20, 30]) {
        const q = quote({ leaderTotal, takeLead: leaderTotal + 1, domainKnown: true, priorTotal, amount: 1 });
        expect(q.need).toBe(Math.max(1, leaderTotal + 1 - priorTotal));
        expect(q.alreadyLead).toBe(priorTotal >= leaderTotal);
      }
    }
  });
});

/* R09-1: the hold is named, never guessed at, and the sentence the buyer sees
   is derived from the same figures the validator will enforce. */
const FUTURE = new Date(Date.now() + 15 * 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

describe("joinSpace answers whether any amount is even available (R09-1)", () => {
  it("calls the board locked when the hold sits at the floor", () => {
    // A $5 tile held for #1: $5 is inside the quote, and every larger amount
    // aims at #1 too — nothing lands.
    expect(joinSpace([5], 6)).toEqual({ kind: "locked", free: 6 });
    expect(joinSpace([5], 5)).toEqual({ kind: "locked", free: 6 });
    expect(joinSpace([5], null)).toEqual({ kind: "free" });
    // A hold above a floor that is still free leaves room below it.
    expect(joinSpace([12, 7, 5000], 13)).toEqual({ kind: "room", amount: 5 });
    expect(joinSpace([5, 12], 13)).toEqual({ kind: "room", amount: 6 });
  });

  it("offers the smallest amount the validator itself would accept", () => {
    for (const [existingTotals, heldTotal] of [
      [[5, 12], 13],
      [[5, 5, 12], 20],
      [[5, 6, 7, 9], 10],
    ] as [number[], number][]) {
      const space = joinSpace(existingTotals, heldTotal);
      expect(space.kind).toBe("room");
      if (space.kind !== "room") continue;
      // The server's own rule, not a second opinion: the amount the client
      // offers back must survive `classifyAndValidate` *and* clear the hold.
      expect(space.amount).toBe(smallestFreeAmount(existingTotals));
      expect(space.amount).toBeLessThan(heldTotal);
      const verdict = classifyAndValidate({
        amount: space.amount,
        leaderTotal: Math.max(...existingTotals),
        isNewHere: true,
        myPriorTotal: 0,
        existingTotals,
      });
      expect(verdict.ok && verdict.path).toBe("JOIN");
    }
  });
});

describe("the quote carries the live hold, and dates it (R09-1)", () => {
  it("publishes the held total and its expiry for the client to render", () => {
    const q = stakeQuote({ ...board, leaderTotal: 5, takeLead: 6, amount: 5, takeQuote: { expiresAt: FUTURE, reservedTotal: 6 } });
    // The $5 bid itself is not a take — and while the hold runs it will be
    // refused — so the payload has to carry the hold for the copy to explain.
    expect(q.takeQuoted).toBe(false);
    expect(q.need).toBe(6);
    expect(q.heldByOtherUntil).toBe(FUTURE);
    expect(q.heldByOtherTotal).toBe(6);
  });

  it("drops a hold that has lapsed, and never invents one", () => {
    const lapsed = stakeQuote({ ...board, leaderTotal: 5, takeLead: 6, amount: 5, takeQuote: { expiresAt: PAST, reservedTotal: 6 } });
    expect(lapsed.heldByOtherUntil).toBeNull();
    expect(lapsed.heldByOtherTotal).toBeNull();
    const none = stakeQuote({ ...board, leaderTotal: 5, takeLead: 6, amount: 5 });
    expect([none.heldByOtherUntil, none.heldByOtherTotal]).toEqual([null, null]);
    const empty = stakeQuote({ ...board, leaderTotal: 5, takeLead: 6, amount: 5, takeQuote: null });
    expect(empty.heldByOtherUntil).toBeNull();
    // A hold on a board the client cannot price is still a hold: it blocks
    // amounts whatever the rest of the payload says.
    const partial = stakeQuote({ ...board, boardComplete: false, amount: 5, takeQuote: { expiresAt: FUTURE, reservedTotal: 6 } });
    expect(partial.heldByOtherTotal).toBe(6);
    expect(partial.takeQuoted).toBe(false);
  });
});

describe("the crown names the hold before it quotes a price (R09-1, R09-6)", () => {
  const crown = (over: Partial<Parameters<typeof crownCopy>[0]> = {}) =>
    crownCopy({
      elementName: "Carbon",
      boardComplete: true,
      priorHere: false,
      alreadyLead: false,
      need: 6,
      priorTotal: 0,
      heldUntil: FUTURE,
      heldTotal: 6,
      existingTotals: [5],
      ...over,
    });

  it("tells a newcomer the tile is a wall instead of naming an amount", () => {
    const held = crown();
    expect(held.lead).toContain("A take quote at $6 aims at #1 in Carbon until");
    expect(held.joins).toBe("The lowest amount still free is $6, and the quote covers it.");
  });

  it("offers the smallest free amount when the floor is still open", () => {
    const held = crown({ existingTotals: [5, 12], heldTotal: 13, need: 13 });
    expect(held.lead).toContain("$13"); // the hold, named first
    expect(held.joins).toBe("A first bid is $6+ while that quote runs — exact ties are refused, so stand $1 clear.");
  });

  it("keeps an incumbent's top-up honest while the hold runs", () => {
    const back = crown({ priorHere: true, priorTotal: 3, need: 3, existingTotals: [5, 3] });
    expect(back.joins).toBe("Top-ups are $1+ — $6 takes #1, but that total is inside the quote until " + new Date(FUTURE).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ".");
    // The hold owner's own $1 lands on the quote's total, so clearing it costs
    // one more dollar.
    const leader = crown({ priorHere: true, alreadyLead: true, priorTotal: 5, need: 1, existingTotals: [5] });
    expect(leader.lead).toBe("👑 You're #1 in Carbon — extend your lead!");
    expect(leader.joins).toBe("Top-ups are $1+ — add $2 to clear that quote while it runs.");
  });

  it("says nothing about a hold that has lapsed", () => {
    const lapsed = crown({ heldUntil: PAST, heldTotal: 6 });
    expect(lapsed.lead).not.toContain("quote");
    expect(lapsed.joins).not.toContain("quote");
    expect(lapsed.joins).toContain("A first bid is $6+");
  });
});

describe("crownCopy states the live price on a whole board (R09-6)", () => {
  const crown = (over: Partial<Parameters<typeof crownCopy>[0]> = {}) =>
    crownCopy({ elementName: "Carbon", boardComplete: true, priorHere: false, alreadyLead: false, need: 6, priorTotal: 0, existingTotals: [5], ...over });

  it("derives both amounts instead of claiming a fixed floor", () => {
    expect(crown().joins).toBe("A first bid is $6+ — $6 takes #1 right now. Exact ties are rejected, so stand $1 clear.");
    // The claim is arithmetic on the board it was handed.
    const busy = crown({ existingTotals: [9, 4, 5], need: 10 });
    expect(busy.joins).toContain("A first bid is $6+");
    expect(busy.joins).toContain("$10 takes #1 right now");
  });

  it("falls back to the plain invitation on a board it cannot see whole (R04-2)", () => {
    const partial = crown({ boardComplete: false, need: 1 });
    expect(partial.joins).toContain("Any $5+ amount joins the ladder");
    expect(partial.joins).not.toContain("takes #1 right now");
  });

  it("still tells a returning staker what one more dollar does", () => {
    const back = crown({ priorHere: true, priorTotal: 4, need: 1 });
    expect(back.joins).toBe("Top-ups are $1+ — $1 more puts you back on top. Exact ties are rejected, so stand $1 clear.");
    const leader = crown({ priorHere: true, alreadyLead: true, priorTotal: 9, need: 1 });
    expect(leader.lead).toBe("👑 You're #1 in Carbon — extend your lead!");
  });
});
