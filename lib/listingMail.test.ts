/* R10-3 (the subject states the rank the stake actually got) and R10-9's
 * listing half (every field these templates print is escaped).
 *
 * Template-level facts, so no database and no route: `report`/`waitlist`
 * escaping is covered beside its senders in intakeMail.test.ts, and this is
 * the other three templates. Nothing here is a hostile-input story about the
 * current product — the symbol comes from the element table — the point is
 * that no layer between a field and a customer's mail client removes markup,
 * so the template is where it has to happen.
 */
import { describe, it, expect } from "vitest";
import { receiptHtml, receiptSubject } from "@/emails/receipt";
import { outbidHtml } from "@/emails/outbid";
import { refundHtml } from "@/emails/refund";

const HOSTILE = "<img src=x onerror=alert(1)>";
const ESCAPED = "&lt;img src=x onerror=alert(1)&gt;";
const VIEW = "https://periodictable.lol/s/x";
const UNSUB = "https://periodictable.lol/api/unsubscribe?token=x";

describe("the receipt subject states the rank the stake got (R10-3)", () => {
  it("congratulates #1 and only #1", () => {
    expect(receiptSubject({ elementSymbol: "C", elementName: "Carbon", rank: 1 })).toBe("You're #1 in C (Carbon) 🎉");
    // An omitted rank is the pre-R10-3 call shape, which promised the crown.
    expect(receiptSubject({ elementSymbol: "C", elementName: "Carbon" })).toBe("You're #1 in C (Carbon) 🎉");
    expect(receiptSubject({ elementSymbol: "C", elementName: "Carbon", rank: 2 })).toBe("You're #2 in C (Carbon)");
    expect(receiptSubject({ elementSymbol: "C", elementName: "Carbon", rank: 3 })).toBe("You're #3 in C (Carbon)");
  });

  it("does not congratulate in the body what the subject has denied", () => {
    const base = {
      elementSymbol: "Er",
      elementName: "Erbium",
      amountUsd: 6,
      domain: "d9-e.dev",
      viewUrl: VIEW,
      unsubUrl: UNSUB,
    };
    // The headline is the subject, escaped for markup (so the apostrophe is an
    // entity); the rank below it is the same rank the settlement produced.
    const second = receiptHtml({ ...base, rank: 2 });
    expect(second).toContain("You&#39;re #2 in Er (Erbium)");
    expect(second).not.toContain("🎉");
    expect(second).toContain("<strong>#2</strong>");

    const first = receiptHtml({ ...base, rank: 1 });
    expect(first).toContain("You&#39;re #1 in Er (Erbium) 🎉");
  });
});

describe("the listing templates escape what they print (R10-9)", () => {
  it("prints no tag from a symbol, name, domain or provider reference", () => {
    // The `href` slots are deliberately left benign: those values are built by
    // lib/links.ts and lib/email.ts and encoded at construction (links.test.ts),
    // which is the layer that can do it correctly — an entity-escaped query
    // string would break the link instead.
    const receipt = receiptHtml({
      elementSymbol: HOSTILE,
      elementName: HOSTILE,
      amountUsd: 5,
      rank: 2,
      domain: HOSTILE,
      viewUrl: VIEW,
      unsubUrl: UNSUB,
    });
    const outbid = outbidHtml({
      elementSymbol: HOSTILE,
      winnerDomain: HOSTILE,
      winnerAmount: 21,
      reclaim: 2,
      reentryFloor: 3,
      reclaimUrl: VIEW,
      unsubUrl: UNSUB,
    });
    const refund = refundHtml({
      elementSymbol: HOSTILE,
      elementName: HOSTILE,
      amountUsd: 5,
      domain: HOSTILE,
      providerRef: HOSTILE,
      unsubUrl: UNSUB,
    });

    for (const html of [receipt, outbid, refund]) {
      expect(html).not.toContain("<img");
      expect(html).toContain(ESCAPED);
    }
    // The reference is the buyer's quote to their bank, printed as text.
    expect(refund).toContain(`reference ${ESCAPED}`);
  });
});
