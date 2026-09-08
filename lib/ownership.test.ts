/* Phase 1 ownership tests — pure unit tests (no DB required).
   Covers: server-side identity derivation, social URL tolerance, request
   fingerprinting, email normalization, profile validation, and the static
   contract that checkout never trusts a caller-provided domain. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { validateCheckoutInput, validateProfileInput } from "./validate";
import { fingerprintCheckout } from "./startups";
import { hashToken, normalizeEmail } from "./manage";

describe("canonical identity is server-derived", () => {
  it("product domain comes from the URL, not the caller", () => {
    const r = validateCheckoutInput({
      url: "https://Acme-Startup.COM/launch?x=1",
      linkType: "product",
      title: "Acme",
      pitch: "We put flags on tables",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.domain).toBe("acme-startup.com");
      expect(r.url.startsWith("https://")).toBe(true);
    }
  });
  it("social accepts a raw handle", () => {
    const r = validateCheckoutInput({
      url: "@foobar",
      linkType: "social",
      title: "Foo",
      pitch: "Social first",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.domain).toBe("foobar.social");
      expect(r.url).toBe("https://x.com/foobar");
    }
  });
  it("social accepts the client's https://handle.social URL form", () => {
    const r = validateCheckoutInput({
      url: "https://foobar.social",
      linkType: "social",
      title: "Foo",
      pitch: "Social first",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.domain).toBe("foobar.social");
  });
  it("social still rejects garbage", () => {
    expect(validateCheckoutInput({ url: "https://", linkType: "social", title: "F", pitch: "x" }).ok).toBe(false);
    expect(validateCheckoutInput({ url: "not a handle!!", linkType: "social", title: "Fo", pitch: "ok pitch" }).ok).toBe(false);
  });
  it("checkout route ignores body.startup.domain (static contract)", () => {
    const src = readFileSync(join(__dirname, "..", "app", "api", "checkout", "route.ts"), "utf8");
    expect(src).not.toMatch(/body\.startup\?\.domain/);
    expect(src).toMatch(/findOrCreateCheckoutStartup/);
  });
});

describe("fingerprintCheckout", () => {
  const base = { elementSym: "C", domain: "acme.dev", amountUsd: 21, email: "a@b.c" };
  it("is deterministic", () => {
    expect(fingerprintCheckout(base)).toBe(fingerprintCheckout({ ...base }));
  });
  it("changes when any canonical field changes", () => {
    const variants = [
      { ...base, amountUsd: 22 },
      { ...base, domain: "other.dev" },
      { ...base, email: null },
      { ...base, elementSym: "Au" },
    ];
    for (const v of variants) expect(fingerprintCheckout(v)).not.toBe(fingerprintCheckout(base));
  });
});

describe("normalizeEmail + hashToken", () => {
  it("lowercases/trims, rejects garbage", () => {
    expect(normalizeEmail("  Founder@Acme.DEV ")).toBe("founder@acme.dev");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
  });
  it("hashes deterministically and hides the raw token", () => {
    const h1 = hashToken("abc");
    expect(h1).toBe(hashToken("abc"));
    expect(h1).not.toContain("abc");
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("validateProfileInput", () => {
  it("accepts a full valid profile update", () => {
    const r = validateProfileInput({
      url: "https://newstartup.dev/page",
      linkType: "product",
      title: "New name",
      pitch: "New pitch that is long enough",
      email: "owner@newstartup.dev",
      logoUrl: "https://newstartup.dev/logo.png",
    });
    expect(r.ok).toBe(true);
  });
  it("rejects bad email and bad logo", () => {
    const badEmail = validateProfileInput({
      url: "https://newstartup.dev",
      title: "New name",
      pitch: "New pitch that is long enough",
      email: "nope",
    });
    expect(badEmail.ok).toBe(false);
    const badLogo = validateProfileInput({
      url: "https://newstartup.dev",
      title: "New name",
      pitch: "New pitch that is long enough",
      logoUrl: "notaurl",
    });
    expect(badLogo.ok).toBe(false);
  });
  it("existing profiles cannot be retargeted via checkout fields (static contract)", () => {
    const src = readFileSync(join(__dirname, "..", "app", "api", "checkout", "route.ts"), "utf8");
    // No startup.update/upsert path may remain in the checkout route.
    expect(src).not.toMatch(/prisma\.startup\.(update|upsert)/);
  });
});
