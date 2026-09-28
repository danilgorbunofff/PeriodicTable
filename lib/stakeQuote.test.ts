import { describe, it, expect } from "vitest";
import { stakeQuote, crownCopy } from "./stakeQuote";
import { classifyAndValidate, takeLeadPrice, reclaimFor } from "./pricing";

/* Review 04 (doc/review/04-element-detail-and-pricing.md) — the checkout form's
   money claims, tested without a browser: the figure the app wrote into the
   amount field (R04-1), the price the copy may state (R04-2, R09-6), and the
   neutral wording (no prior-holder personalization, no holds). */

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
  });

  it("reprices a stale outbid figure to the live reclaim delta", () => {
    // Outbid mail priced $2 off a $20 board that has since grown to $21.
    const q = quote({ leaderTotal: 21, takeLead: 22, domainKnown: true, priorTotal: 20, amount: 2 });
    expect(q.priorHere).toBe(true);
    expect(q.need).toBe(reclaimFor(21, 20));
    expect(q.reconciledAmount).toBe(2);
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
  });
});

describe("stakeQuote — what the copy may promise (R04-2)", () => {
  it("withholds a restated newcomer figure on a board with concealed rows", () => {
    const q = quote({ boardComplete: false, leaderTotal: 20, takeLead: 21, amount: 21 });
    expect(q.need).toBe(21);
    expect(q.reconciledAmount).toBeNull();
  });

  it("still reconciles a holder whose own row the board shows", () => {
    const q = quote({ boardComplete: false, leaderTotal: 21, takeLead: 22, domainKnown: true, priorTotal: 20, amount: 2 });
    expect(q.reconciledAmount).toBe(2);
  });
});

describe("stakeQuote — agrees with the server's classification", () => {
  const amounts = [1, 4, 5, 6, 9, 10, 20, 21, 22, 50, 89];

  it("quotes the price the server would charge: take price or reclaim gap", () => {
    for (const leaderTotal of [undefined, 20, 88]) {
      for (const priorTotal of [0, 12, 20, 30]) {
        const q = quote({
          boardComplete: true,
          leaderTotal,
          takeLead: takeLeadPrice(leaderTotal),
          domainKnown: priorTotal > 0,
          priorTotal,
          amount: 1,
        });
        if (leaderTotal == null) {
          expect(q.need).toBe(5);
          continue;
        }
        if (priorTotal === 0) {
          expect(q.need).toBe(takeLeadPrice(leaderTotal));
          continue;
        }
        expect(q.need).toBe(Math.max(1, leaderTotal + 1 - priorTotal));
        expect(q.alreadyLead).toBe(priorTotal >= leaderTotal);
      }
    }
  });

  it("never accepts a newcomer amount the server would refuse on a claimed element", () => {
    let takes = 0;
    for (const leaderTotal of [5, 20, 88]) {
      for (const amount of amounts) {
        const q = quote({
          boardComplete: true,
          leaderTotal,
          takeLead: takeLeadPrice(leaderTotal),
          domainKnown: false,
          priorTotal: 0,
          amount,
        });
        const verdict = classifyAndValidate({
          amount,
          leaderTotal,
          isNewHere: true,
          myPriorTotal: 0,
          existingTotals: [leaderTotal],
        });
        // The price the copy states is the smallest amount the server accepts.
        expect(verdict.ok).toBe(q.need != null && amount >= q.need);
        if (verdict.ok && verdict.path === "TAKE") takes++;
      }
    }
    // Guard against a vacuous pass: the matrix must contain real takes.
    expect(takes).toBeGreaterThan(0);
  });
});

describe("crownCopy states the price without addressing the buyer (R09-6)", () => {
  const crown = (over: Partial<Parameters<typeof crownCopy>[0]> = {}) =>
    crownCopy({ elementName: "Carbon", boardComplete: true, alreadyLead: false, need: 11, priorTotal: 0, ...over });

  it("aims at #1 and names the tie rule", () => {
    expect(crown().lead).toBe("👑 $11 aims at #1 in Carbon!");
    expect(crown().joins).toBe(
      "A $11 bid beats the current #1. Exact ties are rejected — if an equal amount settles first, $1 more takes #1."
    );
  });

  it("softens the promise on a board it cannot see whole (R04-2)", () => {
    const partial = crown({ boardComplete: false });
    expect(partial.joins).toContain("may be concealed");
    expect(partial.joins).not.toContain("beats the current #1");
  });

  it("states the held total when the reader already leads", () => {
    const leader = crown({ alreadyLead: true, priorTotal: 10, need: 1 });
    expect(leader.lead).toBe("👑 Carbon's #1 holds $10.");
    expect(leader.joins).toBe("Top-ups are $1+ — exact ties are rejected.");
  });

  it("contains no prior-holder personalization", () => {
    for (const over of [{}, { alreadyLead: true, priorTotal: 10, need: 1 }, { boardComplete: false }]) {
      const copy = crown(over);
      expect(`${copy.lead} ${copy.joins}`).not.toMatch(/You're|your|reclaims|puts you|tops up your/i);
    }
  });
});
