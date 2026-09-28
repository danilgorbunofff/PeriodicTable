/* Phase 1 ownership tests — pure unit tests (no DB required).
   Covers: server-side identity derivation, social URL tolerance, request
   fingerprinting, email normalization, profile validation, and the static
   contract that checkout never trusts a caller-provided domain. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { validateCheckoutInput, validateProfileInput, SOCIAL_IDENTITY_MAX } from "./validate";
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
  it("social identity is the account: host + path, scheme optional", () => {
    const r = validateCheckoutInput({
      url: "https://Instagram.com/FooBar/?hl=en#bio",
      linkType: "social",
      title: "Foo",
      pitch: "Social first",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Query and hash are not part of an account; case and the trailing slash
      // are folded the same way the product path folds a host.
      expect(r.domain).toBe("instagram.com/foobar");
      expect(r.url).toBe("https://instagram.com/FooBar/?hl=en#bio");
    }
    const bare = validateCheckoutInput({
      url: "youtube.com/@Foo",
      linkType: "social",
      title: "Foo",
      pitch: "Social first",
    });
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.domain).toBe("youtube.com/@foo");
  });
  it("two accounts on one platform are two listings", () => {
    const a = validateCheckoutInput({ url: "https://instagram.com/a", linkType: "social", title: "Acct A", pitch: "pitch one" });
    const b = validateCheckoutInput({ url: "https://instagram.com/b", linkType: "social", title: "Acct B", pitch: "pitch two" });
    expect(a.ok && a.domain).toBe("instagram.com/a");
    expect(b.ok && b.domain).toBe("instagram.com/b");
  });
  it("a social link with no path is the host alone, like a product URL", () => {
    const r = validateCheckoutInput({ url: "https://bsky.app", linkType: "social", title: "Bsky", pitch: "Social first" });
    expect(r.ok && r.domain).toBe("bsky.app");
  });
  it("social rejects garbage and blocked hosts", () => {
    expect(validateCheckoutInput({ url: "https://", linkType: "social", title: "F", pitch: "x" }).ok).toBe(false);
    expect(validateCheckoutInput({ url: "not a handle!!", linkType: "social", title: "Fo", pitch: "ok pitch" }).ok).toBe(false);
    // The same identity guard as the product path: this site is not a listing.
    expect(validateCheckoutInput({ url: "https://www.periodictable.lol/x", linkType: "social", title: "Fo", pitch: "ok pitch" }).ok).toBe(false);
  });
  it("refuses a social identity longer than the stored maximum", () => {
    const long = `https://instagram.com/${"a".repeat(SOCIAL_IDENTITY_MAX)}`;
    const r = validateCheckoutInput({ url: long, linkType: "social", title: "Long", pitch: "ok pitch" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too long/i);
    // One character shorter than the bound is a listing.
    const fits = validateCheckoutInput({
      url: `https://instagr.am/${"a".repeat(SOCIAL_IDENTITY_MAX - "instagr.am/".length)}`,
      linkType: "social",
      title: "Fits",
      pitch: "ok pitch",
    });
    expect(fits.ok).toBe(true);
    if (fits.ok) expect(fits.domain.length).toBe(SOCIAL_IDENTITY_MAX);
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
  it("returns the normalised logo URL so the caller stores the checked value (R14-5)", () => {
    const r = validateProfileInput({
      url: "https://newstartup.dev",
      title: "New name",
      pitch: "New pitch that is long enough",
      logoUrl: "  HTTPS://NewStartup.DEV/logo.png  ",
    });
    expect(r.ok && r.logoUrl).toBe("https://newstartup.dev/logo.png");

    // Absent and empty both mean "no logo was sent", never "a logo called ''".
    for (const logoUrl of [undefined, ""]) {
      const none = validateProfileInput({
        url: "https://newstartup.dev",
        title: "New name",
        pitch: "New pitch that is long enough",
        logoUrl,
      });
      expect(none.ok && none.logoUrl).toBeNull();
    }
  });
  it("refuses logo URLs that cannot be stored as one (R14-5)", () => {
    const base = { url: "https://newstartup.dev", title: "New name", pitch: "New pitch that is long enough" };
    for (const logoUrl of [
      "https://user:pw@newstartup.dev/logo.png", // credentials in a public payload
      "https://newstartup.dev/logo.png\nX-Injected: 1", // control characters
      `https://newstartup.dev/${"a".repeat(2100)}`, // unbounded length
      "https://127.0.0.1/logo.png", // not a public host
    ]) {
      const r = validateProfileInput({ ...base, logoUrl });
      expect(r.ok, logoUrl).toBe(false);
      expect(!r.ok && r.field).toBe("logoUrl");
    }
  });
  it("existing profiles cannot be retargeted via checkout fields (static contract)", () => {
    const src = readFileSync(join(__dirname, "..", "app", "api", "checkout", "route.ts"), "utf8");
    // No startup.update/upsert path may remain in the checkout route.
    expect(src).not.toMatch(/prisma\.startup\.(update|upsert)/);
  });
});
