import { describe, it, expect } from "vitest";
import {
  MIN_STAKE,
  takeLeadPrice,
  joinMin,
  reclaimFor,
  validateTopUp,
  validateFirstJoin,
  validateJoin,
  validateTopUpAmount,
  validateTake,
  classifyAndValidate,
  rankStakes,
} from "./pricing";

describe("takeLeadPrice", () => {
  it("is $5 on an empty tile", () => {
    expect(takeLeadPrice(undefined)).toBe(5);
    expect(takeLeadPrice(undefined)).toBe(MIN_STAKE);
  });
  it("is leader total + 1 on a claimed tile", () => {
    expect(takeLeadPrice(20)).toBe(21);
    expect(takeLeadPrice(88)).toBe(89);
  });
});

describe("joinMin", () => {
  it("is always $5", () => {
    expect(joinMin()).toBe(5);
  });
});

describe("reclaimFor", () => {
  it("canonical: A $20, B $21 → A reclaims for $2", () => {
    expect(reclaimFor(21, 20)).toBe(2);
  });
  it("empty tile: reclaim quote is $5", () => {
    expect(reclaimFor(undefined, undefined)).toBe(5);
    expect(reclaimFor(undefined, 0)).toBe(5);
  });
  it("never below $1", () => {
    expect(reclaimFor(21, 25)).toBe(1);
  });
  it("no prior stake on claimed tile: pay full take-lead price", () => {
    expect(reclaimFor(21, undefined)).toBe(22);
  });
});

describe("validateTopUp (legacy client hint)", () => {
  it("rejects non-integers and zero/negative", () => {
    expect(validateTopUp(0, 20, false)).toMatch(/Whole dollars/);
    expect(validateTopUp(-3, 20, false)).toMatch(/Whole dollars/);
    expect(validateTopUp(2.5, 20, false)).toMatch(/Whole dollars/);
  });
  it("new joiner below $5 on empty tile rejected", () => {
    expect(validateTopUp(3, undefined, true)).toMatch(/First stake/);
  });
  it("new joiner $5 on empty tile ok", () => {
    expect(validateTopUp(5, undefined, true)).toBeNull();
  });
});

describe("validateFirstJoin", () => {
  it("empty tile first join at $5 succeeds, below fails", () => {
    expect(validateFirstJoin(5)).toBeNull();
    expect(validateFirstJoin(4)).toMatch(/\$5/);
  });
});

describe("validateJoin (P0-04: contested $5 joins)", () => {
  it("new $5 join on a claimed tile lands below the leader", () => {
    expect(validateJoin(5, [50, 24])).toBeNull();
  });
  it("join amount equal to an existing total is a tie → rejected", () => {
    expect(validateJoin(24, [50, 24])).toMatch(/taken/);
  });
  it("below floor still rejected", () => {
    expect(validateJoin(3, [50])).toMatch(/\$5/);
  });
});

describe("validateTopUpAmount (P1-02: no ties)", () => {
  it("existing $1 top-up succeeds when it creates no tie", () => {
    expect(validateTopUpAmount(20, 1, [50])).toBeNull();
  });
  it("top-up that ties another startup fails", () => {
    expect(validateTopUpAmount(20, 30, [50, 24])).toMatch(/tie/);
  });
});

describe("validateTake", () => {
  it("requires exactly the reserved winning total or more", () => {
    expect(validateTake(51, 51)).toBeNull();
    expect(validateTake(60, 51)).toBeNull();
    expect(validateTake(50, 51)).toMatch(/\$1 more/);
  });
});

describe("classifyAndValidate", () => {
  it("empty tile newcomer → JOIN", () => {
    expect(
      classifyAndValidate({ amount: 5, leaderTotal: undefined, isNewHere: true, myPriorTotal: 0, existingTotals: [] })
    ).toEqual({ ok: true, path: "JOIN" });
  });
  it("contested newcomer below take → JOIN (P0-04)", () => {
    expect(
      classifyAndValidate({ amount: 5, leaderTotal: 50, isNewHere: true, myPriorTotal: 0, existingTotals: [50, 24] })
    ).toEqual({ ok: true, path: "JOIN" });
  });
  it("contested newcomer at take price → TAKE", () => {
    expect(
      classifyAndValidate({ amount: 51, leaderTotal: 50, isNewHere: true, myPriorTotal: 0, existingTotals: [50] })
    ).toEqual({ ok: true, path: "TAKE" });
  });
  it("dethroned holder retaking → RECLAIM with canonical delta", () => {
    expect(
      classifyAndValidate({ amount: 2, leaderTotal: 21, isNewHere: false, myPriorTotal: 20, existingTotals: [21, 20] })
    ).toEqual({ ok: true, path: "RECLAIM" });
    expect(reclaimFor(21, 20)).toBe(2);
  });
  it("holder top-up below the lead → STAKE", () => {
    expect(
      classifyAndValidate({ amount: 1, leaderTotal: 50, isNewHere: false, myPriorTotal: 20, existingTotals: [50, 20] })
    ).toEqual({ ok: true, path: "STAKE" });
  });
  it("tie results are rejected with TIE code", () => {
    const r = classifyAndValidate({
      amount: 24,
      leaderTotal: 50,
      isNewHere: true,
      myPriorTotal: 0,
      existingTotals: [50, 24],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TIE");
  });
});

describe("rankStakes", () => {
  it("orders desc, rank 1 = leader", () => {
    const ranked = rankStakes([
      { id: "a", amountUsd: 18 },
      { id: "b", amountUsd: 50 },
      { id: "c", amountUsd: 31 },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[0].isLeader).toBe(true);
    expect(ranked[1].isLeader).toBe(false);
  });
  it("tie breaks by earliest created, then id (total order)", () => {
    const ranked = rankStakes([
      { id: "y", amountUsd: 10, createdAt: new Date("2024-02-01") },
      { id: "x", amountUsd: 10, createdAt: new Date("2024-01-01") },
    ]);
    expect(ranked[0].id).toBe("x");
    expect(ranked[1].id).toBe("y");
    expect(ranked[1].rank).toBe(2);
  });
  // A refund empties a stake but never deletes its row (ClickEvent.stakeId is
  // required), so "amount 0 and still rank 1" is a reachable state. It must
  // hold no crown: otherwise a charged-back bid keeps the tile face — and,
  // because takeLeadPrice(0) is 1, prices the takeover at $1 instead of $5.
  it("a zero-amount stake sorts last and never leads", () => {
    const ranked = rankStakes([
      { id: "refunded", amountUsd: 0, createdAt: new Date("2024-01-01") },
      { id: "live", amountUsd: 12, createdAt: new Date("2024-03-01") },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["live", "refunded"]);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[0].isLeader).toBe(true);
    expect(ranked[1].rank).toBe(2);
    expect(ranked[1].isLeader).toBe(false);
  });
  it("an all-refunded element has no leader at all", () => {
    const ranked = rankStakes([
      { id: "a", amountUsd: 0, createdAt: new Date("2024-01-01") },
      { id: "b", amountUsd: 0, createdAt: new Date("2024-02-01") },
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
    expect(ranked.some((r) => r.isLeader)).toBe(false);
    // The reader rule shared by every leader face (checkout, element detail,
    // tile): first live bid, else no leader — which prices a $5 takeover, not $1.
    expect(ranked.find((r) => r.amountUsd > 0)).toBeUndefined();
    expect(takeLeadPrice(ranked.find((r) => r.amountUsd > 0)?.amountUsd)).toBe(MIN_STAKE);
  });
});
