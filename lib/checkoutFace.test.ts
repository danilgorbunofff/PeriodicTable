import { describe, it, expect } from "vitest";
import {
  CHECKOUT_MSG,
  FIELD_RENDERERS,
  checkoutRefusal,
  emailShapeBad,
  fieldHasRenderer,
  pitchShapeBad,
  submitBlocked,
  titleShapeBad,
  urlMessage,
  urlShapeBad,
  type CheckoutTab,
} from "./checkoutFace";
import { isEmail } from "./validate";

/* Review 06 (doc/review/06-checkout-before-payment.md) — the claim form's two
   refusals without a browser: the gate that stops a submit before a request is
   made, and the branch that turns a refused response into the sentence the
   buyer reads. The modal needs a DOM to render and this repo has no DOM suite
   (U06-1), so the decisions are pure functions and the live wiring is pinned in
   lib/checkoutIntake.test.ts. */

const form = {
  tab: "url" as CheckoutTab,
  url: "https://acme.dev",
  title: "Acme",
  pitch: "a pitch that clears the length rule",
  email: "",
  attest: true,
  domain: "acme.dev" as string | null,
  clientErr: null as string | null,
  humanCheckFailed: false,
};

const blocked = (over: Partial<typeof form> = {}) => submitBlocked({ ...form, ...over });

describe("submitBlocked — one sentence for every refusal (R06-1)", () => {
  it("never returns nothing for a form that reached it", () => {
    // The bug: an untouched form hit the modal's silent `return`, so the click
    // produced no request and no explanation.
    const b = blocked({ url: "", domain: null });
    expect(b).not.toBeNull();
    expect(b?.message).toBe(CHECKOUT_MSG.url);
    expect(b?.field).toBe("url");
  });

  it("lets a complete form through", () => {
    expect(blocked()).toBeNull();
  });

  it("asks for the URL when the handle resolved no domain", () => {
    // `@acme` typed on the social tab with no `@` stripped resolves nothing:
    // the server would 400 on the same field, so the client says it first.
    expect(blocked({ tab: "social", url: "acme", domain: null })?.message).toBe(CHECKOUT_MSG.handle);
    expect(blocked({ url: "acme.dev", domain: null })?.message).toBe(CHECKOUT_MSG.url);
  });

  it("names the field the server would have rejected", () => {
    expect(blocked({ email: "a@b" })).toEqual({ field: "email", message: CHECKOUT_MSG.email });
    expect(blocked({ title: "A" })?.field).toBe("title");
    expect(blocked({ pitch: "  " })?.field).toBe("pitch");
    expect(blocked({ attest: false })).toEqual({ field: "attest", message: CHECKOUT_MSG.attest });
  });

  it("announces a human check that never loaded, without printing it twice", () => {
    // The widget itself renders this sentence (R06-6), so the form must not
    // add a second copy under the button — it marks it as already shown.
    const b = blocked({ humanCheckFailed: true });
    expect(b).toEqual({ field: null, message: CHECKOUT_MSG.humanCheck, shown: true });
  });

  it("asks for the confirmation before it asks about the human check", () => {
    const b = blocked({ attest: false, humanCheckFailed: true });
    expect(b?.field).toBe("attest");
  });

  it("carries the pricing preview's refusal to the shared line", () => {
    const b = blocked({ clientErr: "$12 is taken — add $1 more." });
    expect(b).toEqual({ field: null, message: "$12 is taken — add $1 more." });
  });
});

describe("field shape — the same rules the server enforces (R06-10)", () => {
  it("stays quiet on an empty field but flags a mistyped one", () => {
    expect(urlShapeBad("url", "")).toBe(false);
    expect(emailShapeBad("")).toBe(false);
    expect(titleShapeBad("")).toBe(false);
    expect(pitchShapeBad("")).toBe(false);
    expect(emailShapeBad("a@b")).toBe(true);
  });

  it("checks a product URL for a scheme, and a handle for the domain it resolves", () => {
    expect(urlShapeBad("url", "https://acme.dev")).toBe(false);
    expect(urlShapeBad("url", "http://acme.dev")).toBe(false);
    expect(urlShapeBad("url", "acme.dev")).toBe(true);
    expect(urlShapeBad("social", "@acme")).toBe(false);
    expect(urlShapeBad("social", "acme")).toBe(false);
    // The handle rule itself is `domainFromSocial`'s (and the server's): this
    // shape check only proves a handle can be embedded as a URL at all, which
    // is why `submitBlocked` also refuses when no domain came back (R06-1).
    expect(urlShapeBad("social", "@a b")).toBe(false);
  });

  it("holds the lengths the server's schema holds", () => {
    expect(titleShapeBad("Ab")).toBe(false);
    expect(titleShapeBad(" A ")).toBe(true);
    expect(titleShapeBad("x".repeat(33))).toBe(true);
    expect(pitchShapeBad("Hi")).toBe(false);
    expect(pitchShapeBad("x".repeat(141))).toBe(true);
  });

  it("agrees with the validator the server now uses", () => {
    for (const value of ["a@b", "no-at-sign", "a@b.c", "buyer@acme.dev"]) {
      expect([value, emailShapeBad(value)]).toEqual([value, !isEmail(value)]);
    }
  });

  it("follows the tab the buyer is on (R06-5)", () => {
    // The server answers one `field:"url"` for two different rules.
    expect(urlMessage("url")).toBe(CHECKOUT_MSG.url);
    expect(urlMessage("social")).toBe(CHECKOUT_MSG.handle);
  });

  it("renders exactly the fields the modal has nodes for (R06-4)", () => {
    expect([...FIELD_RENDERERS]).toEqual(["url", "title", "pitch", "email"]);
    expect(fieldHasRenderer("email")).toBe(true);
    // `attest` is a checkbox, not an input with a `co-attest-error` node.
    expect(fieldHasRenderer("attest")).toBe(false);
    expect(fieldHasRenderer("startup.domain")).toBe(false);
  });
});

describe("checkoutRefusal — what a refused response means (R06-3, R06-4)", () => {
  it("quotes a new price only when the board actually moved", () => {
    const moved = checkoutRefusal(409, { error: "$12 is taken — add $1 more.", code: "PRICE_MOVED", takeLead: 13 });
    expect(moved.priceMoved).toBe(13);
    expect(moved.serverErr).toBe("$12 is taken — add $1 more.");
    expect(moved.field).toBeNull();
  });

  it("states the rule, not a moved price, for a floor or a tie", () => {
    for (const code of ["MIN_STAKE", "TIE"]) {
      const r = checkoutRefusal(409, { error: "Add $1 more.", code, takeLead: 13 });
      expect([code, r.priceMoved]).toEqual([code, null]);
      expect([code, r.serverErr]).toEqual([code, "Add $1 more."]);
    }
  });

  it("says which time another buyer's hold runs out (R06-5)", () => {
    const expiresAt = new Date(Date.now() + 9 * 60_000).toISOString();
    const r = checkoutRefusal(409, {
      error: "This element has a held take quote at $13. Refresh for a new quote.",
      code: "RESERVATION_CONFLICT",
      reservedTotal: 13,
      expiresAt,
    });
    expect(r.field).toBeNull();
    expect(r.priceMoved).toBeNull();
    expect(r.serverErr).toContain("This element has a held take quote at $13.");
    expect(r.serverErr).toContain("Held until");
    expect(r.serverErr).toContain(new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  });

  it("offers the amount that still lands, or says none does (R09-1)", () => {
    const expiresAt = new Date(Date.now() + 9 * 60_000).toISOString();
    const held = (extra: Record<string, unknown>) =>
      checkoutRefusal(409, {
        error: "This element has a held take quote at $13. Refresh for a new quote.",
        code: "RESERVATION_CONFLICT",
        reservedTotal: 13,
        expiresAt,
        ...extra,
      });
    // A $6 tile under a $13 hold: the buyer is told the number that works.
    expect(held({ joinHint: 6 }).serverErr).toContain("A $6 bid still joins the ladder.");
    // A $5 tile held for #1: no amount lands, and the copy may not pretend one
    // does. The hold is still named first.
    const blocked = held({ joinBlocked: true }).serverErr;
    expect(blocked).toContain("This element has a held take quote at $13.");
    expect(blocked).toContain("Held until");
    expect(blocked).toContain("No amount lands until that hold ends.");
    expect(blocked).not.toContain("joins the ladder");
    // The hint wins when a server sends both: an amount that lands is better
    // news than a wall.
    const both = held({ joinHint: 6, joinBlocked: true }).serverErr;
    expect(both).toContain("A $6 bid still joins the ladder.");
    expect(both).not.toContain("No amount lands");
  });

  it("hands back the reference of the row a provider failure left behind (R06-7)", () => {
    const r = checkoutRefusal(502, {
      error: "Payment provider unavailable. Try again.",
      code: "PROVIDER_UNAVAILABLE",
      paymentId: "pay_123",
    });
    expect(r.serverErr).toBe("Payment provider unavailable. Try again. Your reference: pay_123.");
    expect(r.field).toBeNull();
  });

  it("shows a field message only where a node exists (R06-4)", () => {
    expect(checkoutRefusal(400, { error: "That email doesn't look right.", field: "email" })).toEqual({
      serverErr: null,
      field: { field: "email", message: "That email doesn't look right." },
      priceMoved: null,
    });
    // No `co-attest-error` node exists, so the sentence has to reach the line
    // under the button instead of vanishing into state.
    const attest = checkoutRefusal(400, { error: "Please confirm you own this URL.", field: "attest" });
    expect(attest.field).toBeNull();
    expect(attest.serverErr).toBe("Please confirm you own this URL.");
  });

  it("reads a replay of a checkout that already ended (R06-9)", () => {
    // `200` + `status` + no `checkoutUrl`: the page must say what happened
    // rather than open nothing.
    const r = checkoutRefusal(200, {
      paymentId: "pay_123",
      status: "canceled",
      error: "This checkout is already canceled — nothing was charged again.",
    });
    expect(r.serverErr).toBe("This checkout is already canceled — nothing was charged again.");
    expect(r.field).toBeNull();
    expect(r.priceMoved).toBeNull();
  });

  it("falls back to one sentence instead of an empty line", () => {
    expect(checkoutRefusal(500, undefined).serverErr).toBe("Something went wrong. Try again.");
    expect(checkoutRefusal(429, { error: "Too many checkout attempts. Try again later." }).serverErr).toBe(
      "Too many checkout attempts. Try again later."
    );
  });
});
