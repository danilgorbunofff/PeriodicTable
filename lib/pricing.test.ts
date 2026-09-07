import { describe, it, expect } from "vitest";
import {
  MIN_STAKE,
  takeLeadPrice,
  joinMin,
  reclaimFor,
  validateTopUp,
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

describe("validateTopUp", () => {
  it("rejects non-integers and zero/negative", () => {
    expect(validateTopUp(0, 20, false)).toMatch(/Whole dollars/);
    expect(validateTopUp(-3, 20, false)).toMatch(/Whole dollars/);
    expect(validateTopUp(2.5, 20, false)).toMatch(/Whole dollars/);
  });
  it("tie rejected: staking exactly the leader total fails", () => {
    // B tries $21 == A's $21 → tie, rejected with "Add $1 more"
    expect(validateTopUp(21, 21, true)).toMatch(/Add \$1 more/);
    // a top-up (not new) itself is allowed — rank math decides
    expect(validateTopUp(21, 21, false)).toBeNull();
  });
  it("new joiner below $5 on empty tile rejected", () => {
    expect(validateTopUp(3, undefined, true)).toMatch(/First join/);
  });
  it("new joiner $5 on empty tile ok", () => {
    expect(validateTopUp(5, undefined, true)).toBeNull();
  });
  it("existing staker may top up $1+", () => {
    expect(validateTopUp(1, 21, false)).toBeNull();
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
  it("tie keeps deterministic first-seen order (rejected upstream)", () => {
    const ranked = rankStakes([
      { id: "x", amountUsd: 10 },
      { id: "y", amountUsd: 10 },
    ]);
    expect(ranked[0].id).toBe("x");
    expect(ranked[1].id).toBe("y");
    expect(ranked[1].rank).toBe(2);
  });
});
