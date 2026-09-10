/* Phase 4 pure unit tests (no DB): previews, abuse guards, tile captions. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { faviconFor, shotUrlFor, previewFor, jsonShotUrlFor, probeShot } from "./screenshots";
import { honeypotCaught, attestValid, turnstileEnabled } from "./abuse";

describe("previews", () => {
  it("prefers stored shot, then live shot, then favicon", () => {
    expect(previewFor({ previewImgUrl: "https://stored/shot.png", url: "https://a.com", domain: "a.com" })).toBe(
      "https://stored/shot.png"
    );
    expect(previewFor({ url: "https://a.com", domain: "a.com" })).toContain("api.microlink.io");
    expect(previewFor({ domain: "a.com" })).toContain("s2/favicons");
  });
  it("favicon helper encodes domain", () => {
    expect(faviconFor("acme.com")).toContain("acme.com");
  });
  it("shot helper encodes url", () => {
    expect(shotUrlFor("https://acme.com")).toContain(encodeURIComponent("https://acme.com"));
  });
  it("live shot embeds bytes, worker probe asks for JSON", () => {
    expect(shotUrlFor("https://acme.com")).toContain("embed=screenshot.url");
    expect(jsonShotUrlFor("https://acme.com")).not.toContain("embed=");
  });
});

describe("probeShot", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (impl: () => Promise<unknown>) => vi.stubGlobal("fetch", vi.fn(impl));

  it("stores the provider CDN url on success", async () => {
    stub(async () => ({
      ok: true,
      json: async () => ({ status: "success", data: { screenshot: { url: "https://iad.microlink.io/abc.png" } } }),
    }));
    expect(await probeShot("https://acme.com")).toBe("https://iad.microlink.io/abc.png");
  });

  it("returns null when Microlink renders no screenshot (retry, never store a non-image)", async () => {
    stub(async () => ({ ok: true, json: async () => ({ status: "success", data: { screenshot: null } }) }));
    expect(await probeShot("https://acme.com")).toBeNull();
  });

  it("returns null on non-2xx, bad shape, or a foreign host", async () => {
    stub(async () => ({ ok: false, json: async () => ({}) }));
    expect(await probeShot("https://acme.com")).toBeNull();
    stub(async () => ({ ok: true, json: async () => ({ status: "fail" }) }));
    expect(await probeShot("https://acme.com")).toBeNull();
    stub(async () => ({ ok: true, json: async () => "not json" }));
    expect(await probeShot("https://acme.com")).toBeNull();
    stub(async () => ({
      ok: true,
      json: async () => ({ status: "success", data: { screenshot: { url: "http://evil.example/x.png" } } }),
    }));
    expect(await probeShot("https://acme.com")).toBeNull();
  });

  it("refuses private hosts and aborts on timeout", async () => {
    stub(async () => ({ ok: true, json: async () => ({ status: "success", data: {} }) }));
    expect(await probeShot("http://127.0.0.1:3000")).toBeNull();
    expect(await probeShot("not a url")).toBeNull();
    stub(async () => {
      throw new Error("aborted");
    });
    expect(await probeShot("https://acme.com")).toBeNull();
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
