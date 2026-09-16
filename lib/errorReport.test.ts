/* Phase 18 error sink (R18-1, R18-10) — pure funnel behaviour, plus the
   end-to-end write against a test database. */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first: pins DATABASE_URL before lib singletons bind
import { describe, it, expect, vi, afterAll } from "vitest";
import { NextRequest } from "next/server";
import {
  BREAKER_OPEN_MS,
  ERROR_REPORT_LIMITS,
  MAX_CONSECUTIVE_FAILURES,
  MAX_WRITES_PER_WINDOW,
  REPEAT_WINDOW_MS,
  capFields,
  createErrorReporter,
  errorSinkEnabled,
  fingerprintOf,
  normalizeErrorReport,
  reportCaught,
  type ErrorReportRow,
} from "./errorReport";
import { GET, POST } from "../app/api/internal/error/route";

/** A sink that records rows, so the funnel's decisions are observable. */
function collector() {
  const rows: ErrorReportRow[] = [];
  const sink = vi.fn(async (row: ErrorReportRow) => {
    rows.push(row);
  });
  return { rows, sink, factory: () => sink };
}

const base = { source: "api", message: "boom" };

describe("normalizeErrorReport (R18-1)", () => {
  it("refuses anything that is not an object with a known source and a message", () => {
    for (const bad of [null, "boom", 42, [], { source: "api" }, { message: "boom" }, { source: "server", message: "  " }]) {
      expect(normalizeErrorReport(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    const wrongSource = normalizeErrorReport({ source: "sink", message: "boom" });
    expect(wrongSource.ok).toBe(false);
    if (!wrongSource.ok) expect(wrongSource.reason).toContain("source must be one of");
  });

  it("caps every field and turns blanks into absent, not empty", () => {
    const result = normalizeErrorReport({
      source: "client",
      message: "m".repeat(600),
      kind: "k".repeat(200),
      route: "r".repeat(400),
      digest: "d".repeat(300),
      stack: "s".repeat(3_000),
      requestId: "   ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.message).toHaveLength(ERROR_REPORT_LIMITS.message);
    expect(result.row.kind).toHaveLength(ERROR_REPORT_LIMITS.kind);
    expect(result.row.route).toHaveLength(ERROR_REPORT_LIMITS.route);
    expect(result.row.digest).toHaveLength(ERROR_REPORT_LIMITS.digest);
    expect(result.row.stack).toHaveLength(ERROR_REPORT_LIMITS.stack);
    expect(result.row.requestId).toBeNull();
  });

  it("stamps the deploy and environment from the process when the caller did not", () => {
    const env = { VERCEL_GIT_COMMIT_SHA: "abcdef1234567890", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
    const filled = normalizeErrorReport({ ...base }, env);
    expect(filled.ok && filled.row.deploy).toBe("abcdef123456");
    expect(filled.ok && filled.row.env).toBe("production");
    // A public reporter may state its own stamps — the caps still apply to them.
    const stated = normalizeErrorReport({ ...base, deploy: "x".repeat(100), env: "preview" }, env);
    expect(stated.ok && stated.row.deploy).toHaveLength(ERROR_REPORT_LIMITS.deploy);
    expect(stated.ok && stated.row.env).toBe("preview");
  });

  it("fingerprints the identity of a failure and nothing else", () => {
    const a = fingerprintOf({ source: "api", kind: "INTERNAL", message: "boom", route: "/api/x" });
    expect(a).toHaveLength(16);
    expect(fingerprintOf({ source: "api", kind: "INTERNAL", message: "boom", route: "/api/x" })).toBe(a);
    expect(fingerprintOf({ source: "api", kind: "INTERNAL", message: "boom", route: "/api/y" })).not.toBe(a);
    expect(fingerprintOf({ source: "api", kind: "INTERNAL", message: "boom!", route: "/api/x" })).not.toBe(a);
    // Absent and empty are the same failure, not two.
    expect(fingerprintOf({ source: "api", kind: null, message: "boom", route: null })).toBe(
      fingerprintOf({ source: "api", kind: "", message: "boom", route: "" })
    );
  });

  it("caps a plain field bag the way the sink would", () => {
    const capped = capFields(
      { message: "m".repeat(600), kind: "api", route: "", stack: undefined },
      { message: 500, kind: 120, route: 300 }
    );
    expect(capped.message).toHaveLength(500);
    expect(capped.kind).toBe("api");
    expect(capped.route).toBeUndefined();
    expect("stack" in capped).toBe(false);
  });
});

describe("errorSinkEnabled (R18-10)", () => {
  it("never lets a test process write to a non-loopback database", () => {
    const prod = "postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/neondb";
    expect(errorSinkEnabled({ VITEST: "1", DATABASE_URL: prod } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(
      errorSinkEnabled({
        VITEST: "1",
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:55433/periodictable_test",
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(true);
    expect(errorSinkEnabled({ VITEST: "1", DATABASE_URL: prod, VITEST_ALLOW_REMOTE_DB: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(errorSinkEnabled({ VITEST: "1" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    // A deployment is not a test run.
    expect(errorSinkEnabled({ DATABASE_URL: prod } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("the funnel's own limits (R18-1)", () => {
  it("collapses a repeat into the row it already wrote, and counts the occurrences", async () => {
    let at = 1_000;
    const { rows, sink, factory } = collector();
    const reporter = createErrorReporter({ sink: factory, now: () => at });

    expect(await reporter.report(base)).toMatchObject({ recorded: true, occurrences: 1 });
    at += 1_000;
    expect(await reporter.report(base)).toMatchObject({ recorded: false, reason: "suppressed" });
    at += 1_000;
    expect(await reporter.report({ ...base })).toMatchObject({ recorded: false, reason: "suppressed" });
    at += REPEAT_WINDOW_MS + 1;
    // The burst ends: the next row carries how many arrived while it was quiet.
    expect(await reporter.report(base)).toMatchObject({ recorded: true, occurrences: 3 });

    expect(rows).toHaveLength(2);
    expect(sink).toHaveBeenCalledTimes(2);
    // Two rows written, two bursts collapsed. `writes` counts the last 60 s of
    // writes rather than all of them (it is the ceiling's counter), and the first
    // write has just aged out of that window — the distinction between "how many
    // ever" and "how many lately" is the one the ceiling is made of.
    expect(reporter.stats()).toMatchObject({ tracked: 1, writes: 1, suppressed: 2, dropped: 0 });
  });

  it("announces a suppressed burst once, not once per report", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const { factory } = collector();
    const reporter = createErrorReporter({ sink: factory });
    for (let i = 0; i < 5; i += 1) await reporter.report(base);
    const lines = info.mock.calls.flat().join(" ").split("\n").filter((l) => l.includes("repeat-suppressed"));
    expect(lines).toHaveLength(1);
    info.mockRestore();
  });

  it("treats a different fingerprint as a different incident in the same window", async () => {
    const { rows, factory } = collector();
    const reporter = createErrorReporter({ sink: factory });
    await reporter.report(base);
    await reporter.report({ ...base, message: "boom elsewhere" });
    expect(rows).toHaveLength(2);
  });

  it("bounds writes per window so a crash loop cannot fill the table", async () => {
    const { rows, factory } = collector();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reporter = createErrorReporter({ sink: factory, now: () => 5_000 });

    for (let i = 0; i < MAX_WRITES_PER_WINDOW + 3; i += 1) {
      await reporter.report({ ...base, message: `boom ${i}` });
    }
    expect(rows).toHaveLength(MAX_WRITES_PER_WINDOW);
    expect(warn.mock.calls.flat().join(" ")).toContain('"msg":"write-throttled"');
    expect(reporter.stats()).toMatchObject({ writes: MAX_WRITES_PER_WINDOW, dropped: 3 });
    warn.mockRestore();
  });

  it("opens a breaker on a failing sink, then tries again when the window passes", async () => {
    let at = 10_000;
    let broken = true;
    const rows: ErrorReportRow[] = [];
    const sink = vi.fn(async (row: ErrorReportRow) => {
      if (broken) throw new Error("neon is asleep");
      rows.push(row);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reporter = createErrorReporter({ sink: () => sink, now: () => at });

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
      at += 1;
      expect(await reporter.report({ ...base, message: `boom ${i}` })).toMatchObject({
        recorded: false,
        reason: "sink-failed",
      });
    }
    expect(warn.mock.calls.flat().join(" ")).toContain('"msg":"sink-open-circuit"');

    // While the breaker is open the sink is not called at all — that is the
    // whole point: a database that is refusing must not be hammered by the code
    // that reports refusals.
    at += 1;
    expect(await reporter.report({ ...base, message: "boom during breaker" })).toMatchObject({
      recorded: false,
      reason: "breaker-open",
    });
    expect(sink).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);

    broken = false;
    at += BREAKER_OPEN_MS + 1;
    expect(await reporter.report({ ...base, message: "boom during breaker" })).toMatchObject({ recorded: true });
    expect(rows).toHaveLength(1);
    warn.mockRestore();
  });

  it("reports the sink as disabled when the process may not write", async () => {
    const reporter = createErrorReporter({ sink: () => null });
    expect(await reporter.report(base)).toMatchObject({ recorded: false, reason: "disabled" });
  });

  it("never lets a sink failure escape, and answers the same way for garbage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reporter = createErrorReporter({
      sink: () => async () => {
        throw new Error("connection refused");
      },
    });
    await expect(reporter.report(base)).resolves.toMatchObject({ recorded: false, reason: "sink-failed" });
    await expect(reporter.report("not an object")).resolves.toEqual({ recorded: false, reason: "invalid" });
    await expect(reporter.report({ ...base, message: "" })).resolves.toEqual({ recorded: false, reason: "invalid" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("reportCaught (R18-1)", () => {
  it("is total, whichever shape the throw has", async () => {
    const results = await Promise.all(
      [new Error("a"), "b", { c: 1 }, null, undefined].map((value) =>
        reportCaught("server", value, { kind: "server-render", route: "/s/x" })
      )
    );
    expect(results.every((r) => typeof r.recorded === "boolean")).toBe(true);
    // In the DB suite the uniform sink is a real one, so these five values are
    // written: clean up after them. They are matched on the shape this test
    // uses and nothing else does, and the table has no pruning job by design —
    // without this every run leaves five rows behind and the window a sibling
    // file asserts over drifts (lib/opsMetrics.test.ts reads the same table).
    if (hasTestDb) {
      const prisma = testPrisma();
      await prisma.errorReport.deleteMany({ where: { kind: "server-render", route: "/s/x" } });
      await prisma.$disconnect();
    }
  });
});

describe.skipIf(!hasTestDb)("the write end, end to end (R18-1)", () => {
  const prisma = testPrisma();
  const marker = `sink-test-${Date.now()}`;
  const url = new URL("http://localhost/api/internal/error");

  afterAll(async () => {
    await prisma.errorReport.deleteMany({ where: { message: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  const post = (body: string) =>
    POST(new NextRequest(url, { method: "POST", body, headers: { "content-type": "application/json" } }));

  it("stores one row and answers 202 without echoing it", async () => {
    const message = `${marker} unhandled`;
    const res = await post(JSON.stringify({ source: "server", kind: "RouteError", message, route: "/pricing" }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { recorded: boolean; reason: null };
    expect(body).toEqual({ recorded: true, reason: null });
    // The body carries the decision, never the message or the row: this route is
    // public, so it says "seen" and nothing an attacker can read back.
    expect(JSON.stringify(body)).not.toContain("unhandled");

    const rows = await prisma.errorReport.findMany({ where: { message } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "server",
      kind: "RouteError",
      route: "/pricing",
      fingerprint: fingerprintOf({ source: "server", kind: "RouteError", message, route: "/pricing" }),
      occurrences: 1,
      env: "test",
    });
    expect(rows[0].deploy).toBeTruthy();

    // The same failure again is the same incident, not a second row.
    const again = await post(JSON.stringify({ source: "server", kind: "RouteError", message, route: "/pricing" }));
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ recorded: false, reason: "suppressed" });
    expect(await prisma.errorReport.count({ where: { message } })).toBe(1);
  });

  it("refuses a body it cannot normalize, and one that is too large", async () => {
    const invalid = await post(JSON.stringify({ source: "nope", message: "x" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "BAD_REQUEST" });

    expect((await post("{not json")).status).toBe(400);

    const huge = await post(
      JSON.stringify({ source: "client", message: marker, stack: "s".repeat(ERROR_REPORT_LIMITS.bodyBytes) })
    );
    expect(huge.status).toBe(413);
    expect(await prisma.errorReport.count({ where: { message: marker } })).toBe(0);
  });

  it("has no read end", async () => {
    // Rows are incidents, including whatever a client chose to send; there is
    // deliberately nothing that serves them back over HTTP.
    const res = await GET(new NextRequest(url, { method: "GET" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST, OPTIONS");
  });

  it("stamps a caught server error through the process-wide funnel", async () => {
    const message = `${marker} caught`;
    const requestId = `req-${marker}`;
    const result = await reportCaught("api", new Error(message), {
      kind: "INTERNAL",
      route: "/api/board",
      requestId,
    });
    expect(result.recorded).toBe(true);
    const row = await prisma.errorReport.findFirst({ where: { requestId } });
    expect(row).toMatchObject({
      source: "api",
      kind: "INTERNAL",
      route: "/api/board",
      message: `Error: ${message}`,
      occurrences: 1,
    });
    expect(row?.stack).toContain(message);
    await prisma.errorReport.deleteMany({ where: { requestId } });
  });
});
