/* R16-11: the operator identity the configuration report keeps track of.

   Doc 16 §5.8 found zero occurrences of the operator's identity anywhere in the
   product, and §5.6 found a receipt with no seller, no tax line, no descriptor
   and no reference. The receipt's legal block that once printed those facts was
   removed 2026-09-28 (the mail is a confirmation; the rules page carries the
   terms), so what is left to hold is the configuration itself: the descriptor
   bounds, the omission rule, and the advisories that make a missing identity
   visible to the operator rather than to a disputing customer. */
import { describe, it, expect } from "vitest";
import { OPERATOR_ENV, descriptorIsValid } from "./operator";
import * as operator from "./operator";

/* `NodeJS.ProcessEnv` demands `NODE_ENV` (`next-env.d.ts` augments the global to
   `"development" | "production" | "test"`), while every case below is a partial
   snapshot of one deployment. The cast happens once, in these adapters, instead
   of at each call site — the same reason `lib/env.test.ts` has `fakeEnv`. */
type Env = Record<string, string | undefined>;
const penv = (env: Env = {}): NodeJS.ProcessEnv => env as unknown as NodeJS.ProcessEnv;
const operatorInfo = (env: Env = {}) => operator.operatorInfo(penv(env));
const operatorAdvisories = (env: Env = {}) => operator.operatorAdvisories(penv(env));

const FULL: Env = {
  OPERATOR_NAME: "Example Labs Ltd",
  OPERATOR_COUNTRY: "Testland",
  OPERATOR_TAX_ID: "TEST-12345",
  OPERATOR_DESCRIPTOR: "PERIODICTABLE.LOL",
};

describe("operatorInfo", () => {
  it("reads the values a receipt needs, and nothing more", () => {
    expect(operatorInfo(FULL)).toEqual({
      name: "Example Labs Ltd",
      country: "Testland",
      taxId: "TEST-12345",
      descriptor: "PERIODICTABLE.LOL",
    });
  });

  it("does not read a postal address or a jurisdiction — nothing publishes them", () => {
    const info = operatorInfo({ OPERATOR_ADDRESS: "1 Example Street", OPERATOR_LAW: "the courts of Testland" });
    expect(Object.values(info)).toEqual([null, null, null, null]);
    expect(Object.keys(OPERATOR_ENV).sort()).toEqual(["country", "descriptor", "name", "taxId"]);
  });

  it("treats an empty or whitespace value as unset, not as a blank fact", () => {
    const info = operatorInfo({ OPERATOR_NAME: "   ", OPERATOR_COUNTRY: "\t\n" });
    expect(info.name).toBeNull();
    expect(info.country).toBeNull();
  });

  it("trims what it does read, so a padded value cannot break the descriptor", () => {
    expect(operatorInfo({ OPERATOR_DESCRIPTOR: "  PERIODICTABLE.LOL  " }).descriptor).toBe("PERIODICTABLE.LOL");
  });

  it("reads nothing from an environment that has none of it", () => {
    expect(Object.values(operatorInfo({}))).toEqual([null, null, null, null]);
  });
});

describe("descriptorIsValid", () => {
  it("accepts what Stripe accepts — 5 to 22 of A–Z, 0–9 and space . * -", () => {
    for (const ok of ["ABC 1", "PERIODICTABLE", "PERIODICTABLE.LOL", "A".repeat(22), "PTL*1 X"]) {
      expect(descriptorIsValid(ok), ok).toBe(true);
    }
  });

  it("rejects what Stripe rejects, at both bounds", () => {
    for (const bad of ["", "ABCD", "A".repeat(23), "periodictable", " PTL1", "-PTL1", "PTL@1", "PTL1#"]) {
      expect(descriptorIsValid(bad), bad || "(empty)").toBe(false);
    }
    expect(descriptorIsValid(null)).toBe(false);
  });
});

describe("operatorAdvisories", () => {
  it("lists the two configuration gaps that decide whether a charge is recognisable", () => {
    const advisories = operatorAdvisories({});
    expect(advisories.map((a) => a.key)).toEqual([OPERATOR_ENV.descriptor, OPERATOR_ENV.taxId]);
    for (const a of advisories) expect(a.reason.length).toBeGreaterThan(20);
  });

  it("says nothing when the descriptor and the registration number are set", () => {
    expect(operatorAdvisories(FULL)).toEqual([]);
  });

  it("flags a descriptor Stripe will refuse, and explains what it accepts", () => {
    const advisories = operatorAdvisories({ ...FULL, OPERATOR_DESCRIPTOR: "ptl" });
    expect(advisories.length).toBe(1);
    expect(advisories[0].key).toBe(OPERATOR_ENV.descriptor);
    expect(advisories[0].reason).toContain('"ptl"');
    expect(advisories[0].reason).toContain("5–22 characters");
  });

  it("flags a missing registration number as a gap that may not be one", () => {
    const advisories = operatorAdvisories({ ...FULL, OPERATOR_TAX_ID: undefined });
    expect(advisories.map((a) => a.key)).toEqual([OPERATOR_ENV.taxId]);
    // The reason has to carry both halves, or an operator with no registration
    // number reads a defect into a value that is simply absent.
    expect(advisories[0].reason).toMatch(/Nothing is wrong if none exists/);
  });
});
