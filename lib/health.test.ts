/* Phase 18 liveness probe (R18-6, R18-9, R18-12) — the probe's three answers,
   and the two things it must never do: throw, or turn a slow failure into an
   unhandled rejection. */
import { hasTestDb } from "./testDb"; // must stay first: pins DATABASE_URL before lib singletons bind
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { HEALTH_TIMEOUT_MS, probeDatabase } from "./health";
import { GET, POST } from "../app/api/health/route";

describe("probeDatabase (R18-9)", () => {
  it("answers up, with how long it took", async () => {
    const outcome = await probeDatabase(async () => [{ "?column?": 1 }]);
    expect(outcome).toMatchObject({ up: true, timedOut: false });
    expect(outcome.ms).toBeGreaterThanOrEqual(0);
    expect(outcome.error).toBeUndefined();
  });

  it("answers down with the failure, not an exception", async () => {
    const outcome = await probeDatabase(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:5432");
    });
    expect(outcome).toMatchObject({ up: false, timedOut: false });
    expect(outcome.error).toContain("ECONNREFUSED");
  });

  it("answers down with `timedOut` when the probe never comes back", async () => {
    const started = Date.now();
    const outcome = await probeDatabase(() => new Promise(() => {}), 20);
    expect(outcome).toMatchObject({ up: false, timedOut: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    // A timeout and a refusal are different incidents, and the human opening the
    // URL afterwards is the one who has to be told which.
    expect(outcome.error).toBeUndefined();
  });

  it("distinguishes a probe that is slow from one that is gone", async () => {
    const outcome = await probeDatabase(
      () => new Promise((resolve) => setTimeout(resolve, 30)),
      500
    );
    expect(outcome).toMatchObject({ up: true, timedOut: false });
  });

  it("keeps a default deadline short enough for a monitor", () => {
    expect(HEALTH_TIMEOUT_MS).toBe(2_000);
  });

  it("does not turn a failure that arrives after the deadline into an unhandled rejection", async () => {
    // The realistic shape of a database that has gone away: the connection error
    // arrives a second after the deadline the probe set. The route has already
    // answered 503 by then, so nothing is waiting for it — and an unhandled
    // rejection in this process would be a second incident caused by the code
    // that exists to report the first.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const outcome = await probeDatabase(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error("gave up late")), 20)),
        5
      );
      expect(outcome).toMatchObject({ up: false, timedOut: true });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reports the failing probe's rejection whenever it lands inside the deadline", async () => {
    const outcome = await probeDatabase(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("refused quickly")), 5)),
      200
    );
    expect(outcome).toMatchObject({ up: false, timedOut: false });
    expect(outcome.error).toContain("refused quickly");
  });

  it("survives a probe that throws synchronously", async () => {
    const outcome = await probeDatabase((() => {
      throw new Error("no client");
    }) as () => Promise<unknown>);
    expect(outcome).toMatchObject({ up: false, timedOut: false });
    expect(outcome.error).toContain("no client");
  });

  it("never leaves a timer behind", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await probeDatabase(async () => null, 30_000);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});

describe.skipIf(!hasTestDb)("the route, against a database that is up (R18-9)", () => {
  const url = "http://localhost/api/health";

  it("answers 200 with the probe's verdict, uncached", async () => {
    const res = await GET(new NextRequest(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, db: "up", timedOut: false });
    expect(body.deploy).toBeTruthy();
  });

  it("is a liveness probe and nothing else", async () => {
    const res = await POST(new NextRequest(url, { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });
});
