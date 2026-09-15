import { describe, it, expect } from "vitest";
import { stakeQuote } from "./stakeQuote";
import { classifyAndValidate, takeLeadPrice, reclaimFor } from "./pricing";

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
