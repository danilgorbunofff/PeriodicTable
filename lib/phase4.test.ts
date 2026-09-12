/* Phase 4 pure unit tests (no DB): previews, abuse guards, tile captions. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { faviconFor, shotUrlFor, previewFor, jsonShotUrlFor, probeShot } from "./screenshots";
import { honeypotCaught, attestValid, turnstileEnabled } from "./abuse";
import { createWhopCheckoutSession } from "./whop";

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

/* A refused token is a refused payment, and the buyer sees the same 400 either
 * way — so the reason has to reach the logs or nobody can tell a broken widget
 * from a bot wave from a bad `remoteip`. */
describe("verifyTurnstile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const stubVerify = (payload: unknown) => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (...args: unknown[]) => {
        bodies.push(String((args[1] as { body: URLSearchParams }).body));
        return new Response(JSON.stringify(payload), { status: 200 });
      })
    );
    return bodies;
  };

  it("surfaces Cloudflare's error code when a token is refused", async () => {
    vi.stubEnv("TURNSTILE_SECRET", "test-secret");
    const bodies = stubVerify({ success: false, "error-codes": ["invalid-input-response"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { verifyTurnstile } = await import("./abuse");

    expect(await verifyTurnstile("tok", "1.2.3.4")).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).toContain("invalid-input-response");
    expect(bodies[0]).toContain("remoteip=1.2.3.4");
  });

  it("omits remoteip when the caller has no IP to send", async () => {
    vi.stubEnv("TURNSTILE_SECRET", "test-secret");
    const bodies = stubVerify({ success: true });
    const { verifyTurnstile } = await import("./abuse");

    expect(await verifyTurnstile("tok", null)).toBe(true);
    expect(bodies[0]).not.toContain("remoteip");
  });

  it("blocks a missing token without calling Cloudflare, and says so", async () => {
    vi.stubEnv("TURNSTILE_SECRET", "test-secret");
    const bodies = stubVerify({ success: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { verifyTurnstile } = await import("./abuse");

    expect(await verifyTurnstile(undefined, "1.2.3.4")).toBe(false);
    expect(bodies).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).toContain("no token");
  });

  it("fails closed, and loudly, when siteverify is unreachable", async () => {
    vi.stubEnv("TURNSTILE_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      })
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { verifyTurnstile } = await import("./abuse");

    expect(await verifyTurnstile("tok", "1.2.3.4")).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).toContain("unreachable");
  });
});

/* Four different ways for the provider call to fail all returned the same bare
 * `null`, so the buyer saw one generic 502 and the reason died with the
 * request. A refused checkout is a sale that did not happen — it has to say
 * why, without ever putting the API key in the log. */
describe("createWhopCheckoutSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const params = {
    paymentId: "pay_1",
    amountUsd: 10,
    title: "Hydrogen",
    elementSymbol: "H",
    email: "buyer@example.com",
    redirectAfterPaid: "https://periodictable.lol/pay/pay_1",
  };

  const stubProvider = (status: number, payload: unknown) => {
    const calls: { url: string; auth: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: unknown) => {
        const headers = (init as { headers: Record<string, string> }).headers;
        calls.push({ url: String(url), auth: headers.Authorization });
        return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
      })
    );
    return calls;
  };

  const liveKeys = () => {
    vi.stubEnv("WHOP_API_KEY", "apik_test");
    vi.stubEnv("WHOP_WEBHOOK_SECRET", "whsec_test");
  };

  it("reports the provider's status and message when it refuses the session", async () => {
    liveKeys();
    const calls = stubProvider(401, { error: { status: 401, message: "Your API Key is invalid." } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await createWhopCheckoutSession(params)).toBeNull();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("HTTP 401");
    expect(logged).toContain("Your API Key is invalid");
    expect(logged).toContain("key=apik");
    expect(logged).not.toContain("apik_test");
    expect(calls[0].auth).toContain("apik_test");
  });

  it("names the field a shape-shifted response dropped", async () => {
    liveKeys();
    stubProvider(200, { id: "chs_1", status: "open" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await createWhopCheckoutSession(params)).toBeNull();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("missing checkout_url");
    expect(logged).toContain("keys: id,status");
  });

  it("returns the session the provider handed back, quietly", async () => {
    liveKeys();
    stubProvider(200, { id: "chs_1", checkout_url: "https://whop.com/checkout/chs_1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await createWhopCheckoutSession(params)).toEqual({
      checkoutUrl: "https://whop.com/checkout/chs_1",
      providerRef: "chs_1",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("flags a response that carries the url but no provider ref", async () => {
    liveKeys();
    stubProvider(200, { checkout_url: "https://whop.com/checkout/chs_1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await createWhopCheckoutSession(params)).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toContain("missing id");
  });

  it("names the missing key instead of calling the provider without one", async () => {
    vi.stubEnv("WHOP_API_KEY", "");
    vi.stubEnv("WHOP_WEBHOOK_SECRET", "whsec_test");
    const calls = stubProvider(200, {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await createWhopCheckoutSession(params)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).toContain("WHOP_API_KEY");
  });

  it("survives a provider that never answers, and says what happened", async () => {
    liveKeys();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      })
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await createWhopCheckoutSession(params)).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toContain("ECONNRESET");
  });
});
