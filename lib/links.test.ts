import { describe, expect, it } from "vitest";
import { outbidReclaimUrl } from "./links";

describe("outbidReclaimUrl", () => {
  it("carries the element, the reclaim amount and the victim's own domain", () => {
    expect(
      outbidReclaimUrl("https://www.periodictable.lol", {
        elementSymbol: "C",
        reclaim: 4,
        domain: "rehearse-first.dev",
      })
    ).toBe("https://www.periodictable.lol/?el=C&stake=4&r=rehearse-first.dev");
  });

  it("encodes handles and symbols so the homepage parses them back verbatim", () => {
    const url = outbidReclaimUrl("https://periodictable.lol", {
      elementSymbol: "C",
      reclaim: 12,
      domain: "acme.social",
    });
    expect(url).toBe("https://periodictable.lol/?el=C&stake=12&r=acme.social");
    expect(new URL(url).searchParams.get("r")).toBe("acme.social");
  });

  it("omits the domain param when it is unknown (older links keep working)", () => {
    expect(outbidReclaimUrl("https://periodictable.lol", { elementSymbol: "Li", reclaim: 2 })).toBe(
      "https://periodictable.lol/?el=Li&stake=2"
    );
  });
});
