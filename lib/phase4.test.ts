/* Phase 4 pure unit tests (no DB): previews, abuse guards, tile captions. */
import { describe, it, expect } from "vitest";
import { faviconFor, shotUrlFor, previewFor } from "./screenshots";
import { honeypotCaught, attestValid, turnstileEnabled } from "./abuse";

describe("previews", () => {
  it("prefers stored shot, then live shot, then favicon", () => {
    expect(previewFor({ previewImgUrl: "https://stored/shot.png", url: "https://a.com", domain: "a.com" })).toBe(
      "https://stored/shot.png"
    );
    expect(previewFor({ url: "https://a.com", domain: "a.com" })).toContain("image.microlink.io");
    expect(previewFor({ domain: "a.com" })).toContain("s2/favicons");
  });
  it("favicon helper encodes domain", () => {
    expect(faviconFor("acme.com")).toContain("acme.com");
  });
  it("shot helper encodes url", () => {
    expect(shotUrlFor("https://acme.com")).toContain(encodeURIComponent("https://acme.com"));
  });
});

describe("abuse guards", () => {
  it("honeypot catches filled hidden fields only", () => {
    expect(honeypotCaught("")).toBe(false);
    expect(honeypotCaught(null)).toBe(false);
    expect(honeypotCaught(undefined)).toBe(false);
    expect(honeypotCaught("bot")).toBe(true);
  });
  it("attest requires explicit opt-in", () => {
    expect(attestValid(true)).toBe(true);
    expect(attestValid(false)).toBe(false);
    expect(attestValid(undefined)).toBe(false);
  });
  it("turnstile is env-gated (passes locally without secret)", async () => {
    const { verifyTurnstile } = await import("./abuse");
    if (!process.env.TURNSTILE_SECRET) {
      expect(turnstileEnabled()).toBe(false);
      expect(await verifyTurnstile(null)).toBe(true);
    }
  });
});
