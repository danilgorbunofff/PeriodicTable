/* Structured log shapes and the level rule (Phase 18, R18-11). Pure: the lines
   are captured from the console the logger writes to, nothing is persisted. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appEnv,
  currentRequestId,
  deploymentId,
  describeError,
  logError,
  logFailure,
  logInfo,
  logWarn,
  withRequestScope,
} from "./log";

type Env = Record<string, string | undefined>;

afterEach(() => {
  vi.restoreAllMocks();
});

function capture() {
  const lines: Record<string, unknown>[] = [];
  const record = (chunk: unknown) => {
    lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
  };
  vi.spyOn(console, "log").mockImplementation(record);
  vi.spyOn(console, "warn").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  return lines;
}

describe("logLine", () => {
  it("writes exactly one machine-readable line per call", () => {
    const lines = capture();
    logInfo("settle", "applied", { paymentId: "p_1", ms: 12 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      scope: "settle",
      msg: "applied",
      paymentId: "p_1",
      ms: 12,
    });
  });

  it("carries the deployment and the environment on every line", () => {
    const env = process.env as unknown as Env;
    const savedSha = env.VERCEL_GIT_COMMIT_SHA;
    const savedEnv = env.VERCEL_ENV;
    try {
      env.VERCEL_GIT_COMMIT_SHA = "0123456789abcdef0123456789abcdef";
      env.VERCEL_ENV = "production";
      const lines = capture();
      logInfo("mail", "sent");
      // Truncated to 12: the full sha is 40 characters nobody diffs by eye.
      expect(lines[0].deploy).toBe("0123456789ab");
      expect(lines[0].env).toBe("production");
    } finally {
      if (savedSha === undefined) delete env.VERCEL_GIT_COMMIT_SHA;
      else env.VERCEL_GIT_COMMIT_SHA = savedSha;
      if (savedEnv === undefined) delete env.VERCEL_ENV;
      else env.VERCEL_ENV = savedEnv;
    }
  });

  it("drops undefined fields and keeps explicit nulls", () => {
    const lines = capture();
    logInfo("outbox", "drained", { claimed: 3, lastError: null, note: undefined });
    expect(lines[0]).toMatchObject({ claimed: 3, lastError: null });
    expect("note" in lines[0]).toBe(false);
  });

  it("still writes a line when a field cannot be serialized", () => {
    const lines = capture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => logInfo("og", "render-failed", { cyclic })).not.toThrow();
    expect(lines).toHaveLength(1);
    // The identity of the line survives even though the payload could not be
    // rendered, so an operator can still see that the event happened.
    expect(lines[0]).toMatchObject({
      level: "info",
      scope: "og",
      msg: "render-failed",
      unserializable: true,
    });
  });

  it("routes each level to its own console method and no other", () => {
    const logged = capture();
    logInfo("a", "info");
    logWarn("a", "warn");
    logError("a", "error");
    expect(logged.map((l) => l.level)).toEqual(["info", "warn", "error"]);
  });

  it("logs a survived failure at warn, with the error flattened", () => {
    const lines = capture();
    logFailure("mail", "send-failed", new TypeError("fetch failed"), {
      template: "receipt",
    });
    // The rule: a failure the caller survived is never `error`, or a filter for
    // `error` would page on retried mail.
    expect(lines[0]).toMatchObject({
      level: "warn",
      scope: "mail",
      template: "receipt",
      error: "TypeError: fetch failed",
    });
  });
});

describe("describeError", () => {
  it("names and messages an Error, and passes a string through", () => {
    expect(describeError(new RangeError("too big"))).toBe("RangeError: too big");
    expect(describeError("plain")).toBe("plain");
  });

  it("survives the values a provider or a JSON body can hand back", () => {
    expect(describeError({ code: "rate_limited" })).toBe('{"code":"rate_limited"}');
    expect(describeError(undefined)).toBe("undefined");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(typeof describeError(cyclic)).toBe("string");
  });
});

describe("request scope", () => {
  it("puts the ambient request id on lines written several frames down", () => {
    const lines = capture();
    const inner = () => logInfo("settle", "applied", { paymentId: "p_2" });
    const middle = () => inner();
    withRequestScope("req-abc", middle);
    expect(lines[0].requestId).toBe("req-abc");
    expect(currentRequestId()).toBeUndefined();
  });

  it("omits the id outside a request rather than inventing one", () => {
    const lines = capture();
    logInfo("jobs", "drained");
    expect("requestId" in lines[0]).toBe(false);
  });

  it("returns the wrapped call's value and survives a throw", () => {
    expect(withRequestScope("req-1", () => 42)).toBe(42);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      withRequestScope("req-2", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(currentRequestId()).toBeUndefined();
  });
});

describe("deploymentId", () => {
  const penv = (o: Env) => o as unknown as NodeJS.ProcessEnv;

  it("prefers the commit sha, then the deployment id, then dev", () => {
    expect(
      deploymentId(
        penv({ VERCEL_GIT_COMMIT_SHA: "abcdef0123456789", VERCEL_DEPLOYMENT_ID: "dpl_1" }),
      ),
    ).toBe("abcdef012345");
    expect(deploymentId(penv({ VERCEL_DEPLOYMENT_ID: "dpl_1234567890" }))).toBe(
      "dpl_1234567890",
    );
    // An empty string from the platform must not become the deployment's name.
    expect(
      deploymentId(penv({ VERCEL_GIT_COMMIT_SHA: "  ", VERCEL_DEPLOYMENT_ID: "" })),
    ).toBe("dev");
  });

  it("falls back to NODE_ENV when Vercel does not say", () => {
    expect(appEnv(penv({ VERCEL_ENV: "preview" }))).toBe("preview");
    expect(appEnv(penv({ NODE_ENV: "test" }))).toBe("test");
    expect(appEnv(penv({}))).toBe("unknown");
  });
});
