/* The homepage's honesty gate, plus source pins that keep the retired fake
   defaults from being reintroduced.

   The truth table is the real test: it is the whole decision, so exhaustive
   coverage here is exhaustive coverage of the behaviour. The source pins below
   are weaker by nature — they read files and match text, the same idiom
   lib/a11y.test.ts uses for UI guarantees that have no renderer in CI — and they
   exist only to catch the specific regression of handing the board a confident
   zero. They cannot prove the page looks right; they can prove it stops lying
   that way. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { liveState, liveMessage } from "./liveState";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("liveState (homepage data honesty)", () => {
  it("no data + failure is 'unavailable', never a default face", () => {
    expect(liveState(false, new Error("HTTP_503"))).toBe("unavailable");
  });

  it("data + failure is 'stale' — real values that are no longer current", () => {
    expect(liveState(true, new Error("HTTP_503"))).toBe("stale");
  });

  it("data + no failure is 'ok'", () => {
    expect(liveState(true, undefined)).toBe("ok");
  });

  it("no data + no failure is 'loading', not 'unavailable'", () => {
    // The distinction matters: a slow first load must not be reported as an
    // outage, or every cold visit would claim the site is down.
    expect(liveState(false, undefined)).toBe("loading");
  });

  it("treats any truthy error as a failure, including SWR's bare throws", () => {
    for (const e of [new Error("x"), "boom", { status: 500 }, true]) {
      expect(liveState(false, e)).toBe("unavailable");
      expect(liveState(true, e)).toBe("stale");
    }
  });

  it("announces both untrustworthy states, and stays silent when healthy", () => {
    expect(liveMessage("stale")).toMatch(/last known/i);
    expect(liveMessage("unavailable")).toBeTruthy();
    // A healthy board says nothing; the initial load is allowed to draw the
    // table rather than a notice over it.
    expect(liveMessage("ok")).toBeNull();
    expect(liveMessage("loading")).toBeNull();
  });

  it("never promises real prices while unavailable", () => {
    // The board under this notice still draws its default $5 faces, so the copy
    // has to say so plainly instead of implying the outage is cosmetic.
    expect(liveMessage("unavailable")).toMatch(/not real/i);
  });
});

describe("the retired fake defaults stay retired", () => {
  it("page.tsx consults liveState for the tile board", () => {
    const s = src("app/page.tsx");
    expect(s).toMatch(/liveState\(/);
    // The grid is only drawn when the board is trustworthy: ok or stale.
    expect(s).toMatch(/tileState === "unavailable"/);
  });

  it("page.tsx never hands StatsCard a guessed number", () => {
    const s = src("app/page.tsx");
    const call = s.match(/<StatsCard[^>]*\/>/);
    expect(call).toBeTruthy();
    // The whole defect in one assertion: no `?? 0`, no `?? 122`, no arithmetic
    // fallback at the call site. Unknown is passed through as unknown.
    expect(call![0]).not.toMatch(/\?\?/);
  });

  it("StatsCard defaults to an em dash, not a number", () => {
    const s = src("components/StatsCard.tsx");
    // No numeric parameter defaults — `= 0` / `= 122` would silently reinstate
    // the exact "0 elements live / $0 in bids / 122 unclaimed" reading.
    expect(s).not.toMatch(/=\s*0\b/);
    expect(s).not.toMatch(/=\s*122\b/);
    expect(s).toMatch(/UNKNOWN\s*=\s*"—"/);
  });
});
