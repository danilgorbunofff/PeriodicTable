/* Phase 18 client error reporting (R18-1, R18-10) — the payload, the browser
   transports, and the handlers' install/uninstall contract. */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  clientErrorPayload,
  describeClientError,
  installClientErrorHandlers,
  reportClientError,
  type WindowLike,
} from "./clientError";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A `window` that records its listeners, so the handlers can be fired by hand. */
function fakeWindow(pathname = "/s/example.com", extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const win: WindowLike & { fire: (type: string, event: unknown) => void; removeCalls: string[] } = {
    location: { pathname, ...extra },
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      win.removeCalls.push(type);
      listeners.get(type)?.delete(listener);
    },
    fire(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    removeCalls: [],
  };
  return win;
}

/** Capture whatever a reporter sends, without a network. */
function captureBeacon() {
  const sent: { url: string; blob: Blob }[] = [];
  const navigatorStub = {
    userAgent: "vitest",
    sendBeacon: vi.fn((url: string, blob: Blob) => {
      sent.push({ url, blob });
      return true;
    }),
  };
  vi.stubGlobal("navigator", navigatorStub);
  return { sent, navigatorStub, body: async (i = 0) => JSON.parse(await sent[i].blob.text()) };
}

describe("clientErrorPayload (R18-1)", () => {
  it("names the failure, and keeps the route to the path", () => {
    const payload = clientErrorPayload("client", new TypeError("x is not a function"), {
      route: "/periodic-table",
      digest: "abc123",
    });
    expect(payload).toMatchObject({
      source: "client",
      kind: "TypeError",
      message: "x is not a function",
      route: "/periodic-table",
      digest: "abc123",
    });
    expect(payload.stack).toContain("x is not a function");
  });

  it("caps what it sends at the same ceilings the server enforces", () => {
    const long = new Error("m".repeat(900));
    long.stack = "s".repeat(9_000);
    const payload = clientErrorPayload("client", long);
    expect(payload.message).toHaveLength(500);
    expect(payload.stack).toHaveLength(2_000);
    // A body over the server's limit is a 413 and a lost report, so the client
    // never builds one.
    expect(JSON.stringify(payload).length).toBeLessThan(4_096);
  });

  it("describes whatever it is handed", () => {
    expect(describeClientError(new RangeError("boom"))).toMatchObject({ kind: "RangeError", message: "boom" });
    expect(describeClientError("plain string")).toEqual({ kind: "Error", message: "plain string" });
    expect(describeClientError({ a: 1 }).message).toBe('{"a":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeClientError(cyclic).message).toBe("unserializable error");
    expect(describeClientError(undefined).message).toBe("undefined");
  });
});

describe("reportClientError (R18-1)", () => {
  it("beacons a JSON body to the sink and reports success", async () => {
    const { sent, body } = captureBeacon();
    expect(reportClientError("client", new Error("first failure"))).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/internal/error");
    expect(await body()).toMatchObject({ source: "client", message: "first failure" });
  });

  it("sends one report per distinct failure, not one per render", () => {
    const { navigatorStub } = captureBeacon();
    const error = new Error("render loop");
    expect(reportClientError("client", error)).toBe(true);
    expect(reportClientError("client", error)).toBe(false);
    expect(reportClientError("client", new Error("render loop"))).toBe(false);
    expect(reportClientError("client", new Error("a different failure"))).toBe(true);
    expect(navigatorStub.sendBeacon).toHaveBeenCalledTimes(2);
  });

  it("falls back to a keepalive fetch when there is no beacon", async () => {
    const fetchStub = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("navigator", { userAgent: "vitest" });
    vi.stubGlobal("fetch", fetchStub);
    expect(reportClientError("client", new Error("no beacon here"))).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/internal/error");
    expect(init.keepalive).toBe(true);
    expect(init.method).toBe("POST");
  });

  it("gives up quietly when there is no transport at all", () => {
    vi.stubGlobal("navigator", { userAgent: "vitest" });
    vi.stubGlobal("fetch", undefined);
    expect(reportClientError("client", new Error("nowhere to send this"))).toBe(false);
  });

  it("never throws out of a failed transport", () => {
    vi.stubGlobal("navigator", {
      userAgent: "vitest",
      sendBeacon: () => {
        throw new Error("blocked by an extension");
      },
    });
    expect(reportClientError("client", new Error("beacon threw"))).toBe(false);
  });
});

describe("installClientErrorHandlers (R18-1)", () => {
  it("reports an uncaught error with its kind, its location and no query string", async () => {
    const { sent, body } = captureBeacon();
    const win = fakeWindow("/s/example.com", { search: "?token=operator-secret", hash: "#x" });
    const uninstall = installClientErrorHandlers(win);

    win.fire("error", {
      message: "Uncaught TypeError: nope",
      filename: "https://periodictable.app/chunk-abc.js",
      lineno: 12,
      colno: 34,
      error: new TypeError("nope"),
    });
    const payload = await body();
    expect(payload).toMatchObject({
      source: "client",
      kind: "TypeError",
      message: "Uncaught TypeError: nope",
      route: "/s/example.com",
    });
    // A manage link's token is a credential; it does not go into an incident row.
    expect(sent[0].blob.type).toBe("application/json");
    expect(JSON.stringify(payload)).not.toContain("operator-secret");

    uninstall();
    expect(win.removeCalls).toEqual(["error", "unhandledrejection"]);
  });

  it("reports a rejected promise nobody handled", async () => {
    const { body } = captureBeacon();
    const win = fakeWindow("/claim");
    installClientErrorHandlers(win);
    win.fire("unhandledrejection", { reason: new Error("payment poll exploded") });
    expect(await body()).toMatchObject({
      source: "client",
      kind: "UnhandledRejection",
      message: "payment poll exploded",
      route: "/claim",
    });
  });

  it("survives a cross-origin script error with no error object", async () => {
    const { body } = captureBeacon();
    const win = fakeWindow("/");
    installClientErrorHandlers(win);
    win.fire("error", { message: "Script error.", filename: "", lineno: 0, colno: 0, error: null });
    expect(await body()).toMatchObject({ message: "Script error." });
  });

  it("does nothing at all on the server", () => {
    expect(installClientErrorHandlers(undefined)).toBeTypeOf("function");
  });
});
