/* R16-11: the receipt's legal block, and the blanks it refuses to invent.

   Doc 16 §5.8 found zero occurrences of the operator's identity anywhere in the
   product, and §5.6 found a receipt with no seller, no tax line, no descriptor
   and no reference. `receiptLegal()` is the fix: one function that assembles
   those facts from deployment configuration, and that omits an unset value
   instead of printing a placeholder a payer cannot act on.

   What is locked here:
     - the descriptor predicate's bounds, because a wrong bound is invisible
       until Stripe refuses a charge (that is the failure it exists to catch);
     - the difference between the two audiences: the About page prints explicit
       blanks (`operatorLines`), the receipt prints nothing (`receiptLegal`);
     - the advisories, which are what make a missing identity visible to the
       operator rather than to a disputing customer. */
import { describe, it, expect } from "vitest";
import { OPERATOR_ENV, OPERATOR_LABELS, OPERATOR_UNPUBLISHED, descriptorIsValid } from "./operator";
import * as operator from "./operator";
import { CONSENT_VERSION, RECEIPT_TAX_LINE, SUPPORT } from "./legal";

/* `NodeJS.ProcessEnv` demands `NODE_ENV` (`next-env.d.ts` augments the global to
   `"development" | "production" | "test"`), while every case below is a partial
   snapshot of one deployment. The cast happens once, in these adapters, instead
   of at each call site — the same reason `lib/env.test.ts` has `fakeEnv`. */
type Env = Record<string, string | undefined>;
const penv = (env: Env = {}): NodeJS.ProcessEnv => env as unknown as NodeJS.ProcessEnv;
const operatorInfo = (env: Env = {}) => operator.operatorInfo(penv(env));
const operatorLines = (env: Env = {}) => operator.operatorLines(penv(env));
const operatorAdvisories = (env: Env = {}) => operator.operatorAdvisories(penv(env));
const receiptLegal = (args: Omit<Parameters<typeof operator.receiptLegal>[0], "env"> & { env?: Env }) =>
  operator.receiptLegal({ ...args, env: penv(args.env) });

const FULL: Env = {
  OPERATOR_NAME: "Example Labs Ltd",
  OPERATOR_ADDRESS: "1 Example Street, Testville",
  OPERATOR_COUNTRY: "Testland",
  OPERATOR_LAW: "the courts of Testland",
  OPERATOR_TAX_ID: "TEST-12345",
  OPERATOR_DESCRIPTOR: "PERIODICTABLE.LOL",
};

describe("operatorInfo", () => {
  it("reads every configured value", () => {
    expect(operatorInfo(FULL)).toEqual({
      name: "Example Labs Ltd",
      address: "1 Example Street, Testville",
      country: "Testland",
      law: "the courts of Testland",
      taxId: "TEST-12345",
      descriptor: "PERIODICTABLE.LOL",
    });
  });

  it("treats an empty or whitespace value as unset, not as a blank fact", () => {
    const info = operatorInfo({ OPERATOR_NAME: "   ", OPERATOR_ADDRESS: "\t\n", OPERATOR_COUNTRY: "" });
    expect(info.name).toBeNull();
    expect(info.address).toBeNull();
    expect(info.country).toBeNull();
  });

  it("trims what it does read, so a padded value cannot break the descriptor", () => {
    expect(operatorInfo({ OPERATOR_DESCRIPTOR: "  PERIODICTABLE.LOL  " }).descriptor).toBe("PERIODICTABLE.LOL");
  });

  it("reads nothing from an environment that has none of it", () => {
    expect(Object.values(operatorInfo({}))).toEqual([null, null, null, null, null, null]);
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

describe("operatorLines", () => {
  it("has a labelled line for every field, configured or not", () => {
    const lines = operatorLines(FULL);
    expect(lines.map((l) => l.label)).toEqual(Object.values(OPERATOR_LABELS));
    expect(lines.every((l) => l.configured)).toBe(true);
    expect(lines.find((l) => l.label === OPERATOR_LABELS.name)?.text).toBe("Operator: Example Labs Ltd");
  });

  it("prints an explicit blank rather than a guess when nothing is configured", () => {
    const lines = operatorLines({});
    expect(lines.length).toBe(6);
    expect(lines.every((l) => l.value === OPERATOR_UNPUBLISHED)).toBe(true);
    expect(lines.every((l) => l.configured === false)).toBe(true);
  });
});

describe("receiptLegal", () => {
  it("carries the tax position, the rules revision and the billing address (R16-4, R16-7)", () => {
    const legal = receiptLegal({ rulesUrl: "https://www.periodictable.lol/legal/rules", env: FULL });
    expect(legal.taxLine).toBe(RECEIPT_TAX_LINE);
    expect(legal.rulesVersion).toBe(CONSENT_VERSION);
    expect(legal.rulesUrl).toBe("https://www.periodictable.lol/legal/rules");
    expect(legal.billing).toBe(SUPPORT.billing);
    expect(legal.reference).toBeNull();
    expect(legal.rulesAcceptedAt).toBeNull();
  });

  it("names the seller and the descriptor from the same configuration the pages print (R16-5)", () => {
    const legal = receiptLegal({ rulesUrl: "/legal/rules", env: FULL, reference: "pi_123" });
    expect(legal.seller).toBe("Example Labs Ltd, established in Testland");
    expect(legal.descriptor).toBe("PERIODICTABLE.LOL");
    expect(legal.taxId).toBe("TEST-12345");
    expect(legal.reference).toBe("pi_123");
  });

  it("omits an unset identity instead of printing a placeholder to a payer", () => {
    const legal = receiptLegal({ rulesUrl: "/legal/rules", env: {} });
    expect(legal.seller).toBeNull();
    expect(legal.descriptor).toBeNull();
    expect(legal.taxId).toBeNull();
    // The one thing that is always stated, because it is always true.
    expect(legal.taxLine).toBe(RECEIPT_TAX_LINE);
    expect(JSON.stringify(legal)).not.toContain(OPERATOR_UNPUBLISHED);
  });

  it("drops a descriptor Stripe would rewrite, rather than publishing one nobody will see", () => {
    const legal = receiptLegal({ rulesUrl: "/legal/rules", env: { ...FULL, OPERATOR_DESCRIPTOR: "periodictable" } });
    expect(legal.descriptor).toBeNull();
  });

  it("names the seller without a country when only the name is set", () => {
    const legal = receiptLegal({ rulesUrl: "/legal/rules", env: { OPERATOR_NAME: "Example Labs Ltd" } });
    expect(legal.seller).toBe("Example Labs Ltd");
  });

  it("records the day consent was given, at day precision", () => {
    const legal = receiptLegal({
      rulesUrl: "/legal/rules",
      consentAt: new Date("2026-09-16T23:59:59.000Z"),
      env: FULL,
    });
    expect(legal.rulesAcceptedAt).toBe("2026-09-16");
  });
});

describe("operatorAdvisories", () => {
  it("lists every buyer-facing gap when nothing is configured", () => {
    const advisories = operatorAdvisories({});
    expect(advisories.map((a) => a.key)).toEqual([
      OPERATOR_ENV.name,
      OPERATOR_ENV.address,
      OPERATOR_ENV.country,
      OPERATOR_ENV.law,
      OPERATOR_ENV.descriptor,
    ]);
    for (const a of advisories) expect(a.reason.length).toBeGreaterThan(20);
  });

  it("says nothing when the identity is complete", () => {
    expect(operatorAdvisories(FULL)).toEqual([]);
  });

  it("flags a descriptor Stripe will refuse, and explains what it accepts", () => {
    const advisories = operatorAdvisories({ ...FULL, OPERATOR_DESCRIPTOR: "ptl" });
    expect(advisories.length).toBe(1);
    expect(advisories[0].key).toBe(OPERATOR_ENV.descriptor);
    expect(advisories[0].reason).toContain('"ptl"');
    expect(advisories[0].reason).toContain("5–22 characters");
  });

  it("does not advise on the tax id — it is optional, not required", () => {
    const advisories = operatorAdvisories({ ...FULL, OPERATOR_TAX_ID: undefined });
    expect(advisories).toEqual([]);
  });
});
