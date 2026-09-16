/* Phase 4 pure unit tests (no DB): previews, abuse guards, tile captions. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { faviconFor, upstreamFaviconUrl, isUpstreamFaviconUrl, previewFor, jsonShotUrlFor, probeShot } from "./screenshots";
import { honeypotCaught, attestValid, turnstileEnabled } from "./abuse";
import { createStripeCheckoutSession } from "./stripe";

describe("previews", () => {
  it("prefers stored shot, then the proxied icon", () => {
    expect(previewFor({ previewImgUrl: "https://stored/shot.png", domain: "a.com" })).toBe("https://stored/shot.png");
    expect(previewFor({ domain: "a.com" })).toBe("/api/favicon?domain=a.com&sz=128");
  });

  it("never hands a browser a third-party host (R16-3)", () => {
    // The two browser-facing strings. Google used to be asked directly by every
    // page with a listing, and Microlink's PNG used to be streamed into the
    // visitor's session on hover — neither is a request the visitor agreed to,
    // and neither was disclosed. Both now come from our own origin.
    expect(faviconFor("acme.com")).toBe("/api/favicon?domain=acme.com&sz=64");
    expect(previewFor({ domain: "acme.com" })).not.toMatch(/google|microlink/);
    expect(faviconFor("acme.com")).not.toMatch(/google|microlink/);
  });

  it("favicon helper encodes domain and keeps the size", () => {
    expect(faviconFor("acme.com", 20)).toBe("/api/favicon?domain=acme.com&sz=20");
    expect(faviconFor("weird domain.com")).toContain(encodeURIComponent("weird domain.com"));
  });

  it("names the upstream only on the server side", () => {
    // The proxy route needs the real URL; nothing else may use it.
    expect(upstreamFaviconUrl("acme.com", 64)).toBe("https://www.google.com/s2/favicons?domain=acme.com&sz=64");
    expect(isUpstreamFaviconUrl("https://www.google.com/s2/favicons?domain=acme.com&sz=64")).toBe(true);
    expect(isUpstreamFaviconUrl("/api/favicon?domain=acme.com&sz=64")).toBe(false);
    expect(isUpstreamFaviconUrl(null)).toBe(false);
  });

  it("the worker probe still asks for JSON, never for bytes", () => {
    expect(jsonShotUrlFor("https://acme.com")).toContain(encodeURIComponent("https://acme.com"));
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
    const line = warn.mock.calls.map((c) => String(c[0])).join(" ");
    expect(line).toContain('"msg":"no-token"');
    expect(line).toContain('"action":"blocked"');
  });

  it("fails closed, and loudly, when siteverify is unreachable", async () => {
    vi.stubEnv("TURNSTILE_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      })
    );
    // R18-11: failing closed because Cloudflare is unreachable changes the
    // outcome (no sale), so the line is `error` — the only level that pages.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { verifyTurnstile } = await import("./abuse");

    expect(await verifyTurnstile("tok", "1.2.3.4")).toBe(false);
    const line = error.mock.calls.map((c) => String(c[0])).join(" ");
    expect(line).toContain('"msg":"siteverify-unreachable"');
    expect(line).toContain("ECONNRESET");
    expect(line).toContain('"scope":"turnstile"');
  });
});

/* Four different ways for the provider call to fail all returned the same bare
 * `null`, so the buyer saw one generic 502 and the reason died with the
 * request. A refused checkout is a sale that did not happen — it has to say
 * why, without ever putting the API key in the log. */
describe("createStripeCheckoutSession", () => {
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
    const calls: { url: string; auth: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: unknown) => {
        const { headers, body } = init as { headers: Record<string, string>; body: string };
        calls.push({ url: String(url), auth: headers.Authorization, body });
        return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
      })
    );
    return calls;
  };

  const liveKeys = () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_abc123");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
  };

  it("reports the provider's status and message when it refuses the session", async () => {
    liveKeys();
    const calls = stubProvider(401, { error: { status: 401, message: "Your API Key is invalid." } });
    // R07-4: a refusal is logged at `error`, not `warn` — it is every buyer's
    // checkout failing, not a caveat — and the line is throttled to one a minute
    // with a suppressed count (lib/stripe.ts logCheckoutRejection). This file
    // triggers exactly one refusal, so the line is unsuppressed here.
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await createStripeCheckoutSession(params)).toBeNull();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain('"msg":"checkout-rejected"');
    expect(logged).toContain('"providerStatus":401');
    // The mode, never the key: enough to tell a live/test mix-up from a revoked
    // key, and useless to anyone reading the log.
    expect(logged).toContain('"keyMode":"sk_test"');
    expect(logged).toContain("Your API Key is invalid");
    expect(logged).not.toContain("sk_test_abc123");
    expect(calls[0].auth).toContain("sk_test_abc123");
  });

  it("names the field a shape-shifted response dropped", async () => {
    liveKeys();
    stubProvider(200, { id: "cs_1", status: "open" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await createStripeCheckoutSession(params)).toBeNull();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain('"msg":"checkout-response-malformed"');
    expect(logged).toContain('"missing":"url"');
    expect(logged).toContain('"keys":"id,status"');
  });

  it("returns the session the provider handed back, quietly", async () => {
    liveKeys();
    stubProvider(200, { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await createStripeCheckoutSession(params)).toEqual({
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1",
      providerRef: "cs_1",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("flags a response that carries the url but no provider ref", async () => {
    liveKeys();
    stubProvider(200, { url: "https://checkout.stripe.com/c/pay/cs_1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await createStripeCheckoutSession(params)).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toContain('"missing":"id"');
  });

  it("names the missing key instead of calling the provider without one", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
    const calls = stubProvider(200, {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await createStripeCheckoutSession(params)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).toContain("STRIPE_SECRET_KEY");
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

    expect(await createStripeCheckoutSession(params)).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toContain("ECONNRESET");
  });

  // The two traps a Stripe port invites, both silent when they happen: Stripe's
  // unit is integer cents, and a reversal event delivers a charge — which
  // carries the payment intent's metadata and never the session's.
  it("quotes our whole dollars as unit_amount cents", async () => {
    liveKeys();
    const calls = stubProvider(200, { id: "cs_1", url: "https://c.stripe.com/cs_1" });

    await createStripeCheckoutSession({ ...params, amountUsd: 5 });
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("500");
    expect(body.get("line_items[0][price_data][currency]")).toBe("usd");
    expect(body.get("mode")).toBe("payment");
  });

  // Managed Payments refuses the session outright — HTTP 400, no checkout ever
  // created — when the line item has no eligible product tax code, and dev mode
  // cannot catch it because /pay/[paymentId] never calls Stripe. Pin the field.
  it("tags the line item with an eligible product tax code", async () => {
    liveKeys();
    const calls = stubProvider(200, { id: "cs_1", url: "https://c.stripe.com/cs_1" });

    await createStripeCheckoutSession(params);
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("line_items[0][price_data][product_data][tax_code]")).toBe("txcd_10000000");
  });

  it("writes the payment id to the session and to the intent", async () => {
    liveKeys();
    const calls = stubProvider(200, { id: "cs_1", url: "https://c.stripe.com/cs_1" });

    await createStripeCheckoutSession(params);
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("metadata[paymentId]")).toBe("pay_1");
    expect(body.get("payment_intent_data[metadata][paymentId]")).toBe("pay_1");
    expect(calls[0].url).toContain("/checkout/sessions");
  });
});
