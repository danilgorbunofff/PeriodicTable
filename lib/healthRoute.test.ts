/* Phase 18 liveness route, database-down arm (R18-9, R18-12).

   The 200 path needs a database and is covered in `lib/health.test.ts`; this file
   is the other half — what a monitor sees when Postgres is gone — which needs a
   client that refuses. The mock is module-scoped on purpose: it is the only way
   to make `prisma.$queryRaw` fail, and the file has decided the database is
   unavailable for its whole life. */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

/** Set by the test that needs the hanging shape before the route is imported. */
let mode: "refuse" | "hang" = "refuse";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: () => {
      if (mode === "hang") return new Promise(() => {});
      return Promise.reject(new Error("ECONNREFUSED 10.0.0.5:5432 (pool: 0 of 5 available)"));
    },
  },
}));

const { GET } = await import("../app/api/health/route");

describe("the route, against a database that is down (R18-9)", () => {
  it("answers 503, names the database as the problem, and leaks nothing else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await GET(new NextRequest("http://localhost/api/health"));

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, db: "down", timedOut: false });
    // The status is the alarm; the host, the port and the pool are not. Anyone
    // who opens this URL in a browser is a stranger.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("ECONNREFUSED");
    expect(serialised).not.toContain("10.0.0.5");
    expect(serialised).not.toContain("pool");

    // ... but the operator reading the logs gets all of it, in one line.
    const lines = warn.mock.calls.flat().map(String).filter((l) => l.includes("db-probe-failed"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ECONNREFUSED");
    expect(lines[0]).toContain("timeoutMs");
    warn.mockRestore();
  });

  it("answers 503 with `timedOut` when the probe is still hanging at the deadline", async () => {
    mode = "hang";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await GET(new NextRequest("http://localhost/api/health"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    // A timeout is the one failure a rejection cannot express, and the human who
    // opens the URL needs to know which of the two they are looking at.
    expect(body).toMatchObject({ ok: false, db: "down", timedOut: true });
    expect(String(warn.mock.calls.flat().join(" "))).toContain('"timedOut":true');
    warn.mockRestore();
    mode = "refuse";
  });
});
