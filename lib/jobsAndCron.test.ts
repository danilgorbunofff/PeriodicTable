/* Phase 13 tests — jobs and cron (R13-2 … R13-9).
 *
 * The finding this file exists for: the scheduler and the workers disagreed
 * about what a "run" is, and nothing could tell a stalled schedule from an idle
 * queue. The tick asked for 25 rows while the daily Vercel cron (a GET, which
 * has no body) got the default 5, both routes declared a 30 s ceiling against a
 * 20 s + 10 s work plan, a failed claim was reported as zero work, the
 * screenshot worker claimed rows of every type, and the provider was never told
 * which logical message it was sending — so a retry after a lost response could
 * mail a buyer twice.
 *
 * Pure sections: the budget arithmetic, the batch resolver, the idempotency key,
 * the heartbeat bounds. Static section: the wiring in vercel.json, the tick and
 * the five routes, asserted against the source because the route tests are
 * DB-backed and would otherwise be the only evidence. DB section: the heartbeat
 * rows the report reads, and the header the provider actually receives.
 */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  JOB_WORK_BUDGET_MS,
  PLATFORM_CEILING_MS,
  RESPONSE_SLACK_MS,
  ROW_CEILING_MS,
  canStartRow,
  jobLimit,
} from "./jobBudget";
import {
  HEARTBEAT_ROUTES,
  HEARTBEAT_SLACK_MS,
  HEARTBEAT_STALE_MS,
  TICK_WORST_OBSERVED_MS,
  heartbeatReport,
  stampHeartbeat,
} from "./jobHeartbeat";
import { configFindingsOk } from "./env";
import { mailIdempotencyKey, sendReceiptEmail } from "./email";

const prisma = testPrisma();
const hasDb = hasTestDb;
const read = (...p: string[]) =>
  readFileSync(join(__dirname, "..", ...p), "utf8");

/** The three routes that declare a work plan of their own (vercel.json's two
 *  crons plus the tick's favourite call). */
const BUDGETED = [
  "app/api/jobs/outbox/route.ts",
  "app/api/jobs/screenshot/route.ts",
  "app/api/jobs/abandoned-checkouts/route.ts",
] as const;

const routeFile = (route: string) =>
  `app/api/jobs${route.replace("/api/jobs", "")}/route.ts`;

describe("the work plan fits inside the ceiling the platform enforces (R13-4)", () => {
  it("leaves response time on the table and never plans past the ceiling", () => {
    expect(JOB_WORK_BUDGET_MS + RESPONSE_SLACK_MS).toBeLessThanOrEqual(
      PLATFORM_CEILING_MS,
    );
    // A row may only be started while a whole row's ceiling fits in the budget,
    // so an in-flight claim is never abandoned mid-send.
    expect(ROW_CEILING_MS).toBeLessThan(JOB_WORK_BUDGET_MS);
  });

  it("is the maxDuration the routes declare — a plan the platform disagrees with is a plan that gets killed", () => {
    const seconds = PLATFORM_CEILING_MS / 1000;
    expect(Number.isInteger(seconds)).toBe(true);
    for (const file of BUDGETED) {
      expect(read(file), file).toContain(
        `export const maxDuration = ${seconds};`,
      );
    }
  });

  it("stops starting rows once the deadline is inside one row's ceiling", () => {
    const now = 1_000_000;
    expect(canStartRow(now + ROW_CEILING_MS, now)).toBe(true);
    expect(canStartRow(now + ROW_CEILING_MS - 1, now)).toBe(false);
    expect(canStartRow(now, now)).toBe(false);
  });
});

describe("the batch a caller actually gets (R13-5)", () => {
  const req = (method: string, query = "") =>
    ({
      method,
      nextUrl: {
        searchParams: new URL(`http://localhost/api/jobs/x${query}`)
          .searchParams,
      },
    }) as never;

  it("prefers the body, then the query string, then the default", () => {
    expect(jobLimit(req("POST", "?limit=9"), { limit: 12 }, 5, 25)).toBe(12);
    expect(jobLimit(req("POST", "?limit=9"), {}, 5, 25)).toBe(9);
    expect(jobLimit(req("POST"), { limit: 12 }, 5, 25)).toBe(12);
    expect(jobLimit(req("POST"), {}, 5, 25)).toBe(5);
  });

  it("reads a bodyless GET as a scheduler asking for the work, not for five rows", () => {
    // The deployed bug: vercel.json invoked these paths with GET, GET has no
    // body, so both daily backstops ran a fifth of the batch the route accepted
    // and a real backlog outlived the day it was noticed.
    expect(jobLimit(req("GET"), {}, 5, 25)).toBe(25);
    expect(jobLimit(req("GET"), {}, 5, 10)).toBe(10);
    expect(jobLimit(req("GET", "?limit=3"), {}, 5, 25)).toBe(3);
  });

  it("clamps, truncates and falls back instead of propagating NaN", () => {
    expect(jobLimit(req("POST", "?limit=9999"), {}, 5, 25)).toBe(25);
    expect(jobLimit(req("POST", "?limit=0"), {}, 5, 25)).toBe(1);
    expect(jobLimit(req("POST", "?limit=-4"), {}, 5, 25)).toBe(1);
    expect(jobLimit(req("POST", "?limit=abc"), {}, 5, 25)).toBe(5);
    expect(jobLimit(req("POST", "?limit="), {}, 5, 25)).toBe(5);
    expect(jobLimit(req("GET", "?limit="), {}, 5, 25)).toBe(25);
    expect(jobLimit(req("POST", "?limit=7.9"), {}, 5, 25)).toBe(7);
  });

  it("is the same number in the cron definition and in the route", () => {
    const crons = JSON.parse(read("vercel.json")) as {
      crons: { path: string }[];
    };
    for (const route of ["/api/jobs/outbox", "/api/jobs/screenshot"]) {
      const declared = crons.crons.find((c) => c.path.startsWith(`${route}?`));
      expect(declared, route).toBeDefined();
      const asked = Number(
        new URL(
          `http://x${declared!.path.slice(route.length)}`,
        ).searchParams.get("limit"),
      );
      const source = read(routeFile(route));
      const max = Number(/jobLimit\(req, body, \d+, (\d+)\)/.exec(source)?.[1]);
      expect(
        asked,
        `${route}: vercel.json asks for ${asked}, the route allows ${max}`,
      ).toBe(max);
    }
  });
});

describe("the tick keeps draining a backlog instead of waiting for the next tick (R13-5, R13-9)", () => {
  const tick = read(".github/workflows/outbox-tick.yml");

  it("re-loops while the route reports work left over", () => {
    expect(tick).toContain(".remaining // 0");
    expect(tick).toContain('[ "$remaining" -gt 0 ] || break');
    // Bounded: the tick's own timeout is five minutes and each call may hold
    // the route's whole work budget.
    expect(tick.match(/for i in 1 2 3 4; do/g)?.length).toBe(2);
    for (const file of [
      "app/api/jobs/outbox/route.ts",
      "app/api/jobs/screenshot/route.ts",
    ]) {
      expect(read(file), file).toContain("drainInBatches(");
      expect(read(file), file).toContain("remaining");
    }
  });

  it("annotates the run when unverified money grows past what was accounted for", () => {
    // Advisory by design: the row is PAID and correct, so the arm is a warning
    // (a coverage gap in the report) and not the failure that pages.
    expect(tick).toContain("RECONCILE_UNVERIFIED_BASELINE");
    expect(tick).toContain("::warning::");
    expect(tick).toMatch(/RECONCILE_UNVERIFIED_BASELINE: "\d+"/);
    expect(tick).toContain(".unverified.count // 0");
  });
});

describe("provider idempotency keys (R13-8)", () => {
  it("keys our own register and the provider with the same string", () => {
    expect(mailIdempotencyKey("receipt-pay_1")).toBe("pt_mail_receipt-pay_1");
    expect(mailIdempotencyKey("receipt-pay_1")).toBe(
      mailIdempotencyKey("receipt-pay_1"),
    );
  });

  it("hashes what the provider would reject rather than truncating it into a collision", () => {
    const long = `preview-${"x".repeat(300)}`;
    const hashed = mailIdempotencyKey(long);
    expect(hashed.length).toBeLessThanOrEqual(256);
    expect(hashed.startsWith("pt_mail_sha256_")).toBe(true);
    expect(hashed).not.toContain("xxx");
    // Two keys sharing a 300-character prefix must not share a header.
    expect(hashed).not.toBe(mailIdempotencyKey(`${long}y`));
  });
});

describe("heartbeat bounds come from the measured cadence, not from hope (R13-3)", () => {
  it("allows a route twice the worst gap ever observed before calling it stopped", () => {
    // The schedule is best-effort: 34 runs in 110 hours, with gaps of 1 h 44 m,
    // 3 h 12 m and 6 h 40 m. A bound below the observed worst gap is a false
    // alarm generator, and one so far above it never fires at all.
    expect(TICK_WORST_OBSERVED_MS).toBe(400 * 60_000);
    for (const route of HEARTBEAT_ROUTES) {
      expect(HEARTBEAT_STALE_MS[route], route).toBeGreaterThan(
        TICK_WORST_OBSERVED_MS,
      );
    }
    for (const route of ["/api/jobs/outbox", "/api/jobs/screenshot"] as const) {
      expect(HEARTBEAT_STALE_MS[route]).toBe(
        24 * 60 * 60_000 + HEARTBEAT_SLACK_MS,
      );
    }
    for (const route of [
      "/api/jobs/abandoned-checkouts",
      "/api/jobs/reconcile",
      "/api/jobs/config",
    ] as const) {
      expect(HEARTBEAT_STALE_MS[route]).toBe(2 * TICK_WORST_OBSERVED_MS);
    }
  });

  it("is wired into every route it watches — an unwatched route is the original blindness", () => {
    for (const route of HEARTBEAT_ROUTES) {
      expect(read(routeFile(route)), route).toContain("stampHeartbeat(");
    }
  });
});

describe.skipIf(!hasDb)(
  "what the report reads (R13-3) and what the provider receives (R13-8)",
  () => {
    type Row = {
      key: string;
      lastRunAt: Date;
      runs: number;
      lastError: string | null;
    };
    const snapshot: Row[] = [];
    const env = process.env as unknown as Record<string, string | undefined>;
    const ADDR = "phase13-provider@example.com";
    const WATCHED: (typeof HEARTBEAT_ROUTES)[number] =
      "/api/jobs/abandoned-checkouts";

    beforeAll(async () => {
      snapshot.push(...(await prisma.jobHeartbeat.findMany()));
      await prisma.emailLog.deleteMany({ where: { to: ADDR } });
      await prisma.emailAddress.deleteMany({ where: { email: ADDR } });
    });

    afterAll(async () => {
      vi.unstubAllGlobals();
      delete env.RESEND_API_KEY;
      // Restore rather than delete: another suite's route calls stamp these rows
      // too, and an idle pass of a worker in this file must not erase them.
      for (const row of snapshot) {
        await prisma.jobHeartbeat.upsert({
          where: { key: row.key },
          create: row,
          update: {
            lastRunAt: row.lastRunAt,
            runs: row.runs,
            lastError: row.lastError,
          },
        });
      }
      await prisma.emailLog.deleteMany({ where: { to: ADDR } });
      await prisma.emailAddress.deleteMany({ where: { email: ADDR } });
    });

    it("lists every watched route and reports an age for each, findings or not", async () => {
      const { findings, routes } = await heartbeatReport();
      expect(routes.map((r) => r.route).sort()).toEqual(
        [...HEARTBEAT_ROUTES].sort(),
      );
      expect(
        routes.every((r) => r.boundMs === HEARTBEAT_STALE_MS[r.route]),
      ).toBe(true);
      // Whatever the hosts has done, a heartbeat never blocks serving: it is an
      // operator's problem (restart the schedule), not a deployment's.
      expect(findings.every((f) => f.severity === "operator")).toBe(true);
      expect(findings.every((f) => f.key.startsWith("heartbeat:"))).toBe(true);
      expect(configFindingsOk(findings)).toBe(true);
    });

    it("calls a route that has never reported, and one past its bound, stopped", async () => {
      await prisma.jobHeartbeat.deleteMany({});
      try {
        const { findings, routes } = await heartbeatReport();
        expect(findings.map((f) => f.key).sort()).toEqual(
          HEARTBEAT_ROUTES.map((r) => `heartbeat:${r}`).sort(),
        );
        expect(
          findings.every((f) =>
            f.detail.includes("never reached this instance"),
          ),
        ).toBe(true);
        expect(
          routes.every(
            (r) => r.ageMs === null && r.runs === 0 && r.lastRunAt === null,
          ),
        ).toBe(true);

        // A fresh stamp is not a finding, and it counts the run.
        await stampHeartbeat(WATCHED, null);
        const fresh = await heartbeatReport();
        expect(fresh.findings.map((f) => f.key)).not.toContain(
          `heartbeat:${WATCHED}`,
        );
        expect(fresh.routes.find((r) => r.route === WATCHED)?.runs).toBe(1);

        // Past the bound it is, with the date and the bound in the detail — the
        // two things an operator needs to know it is the schedule and not the job.
        const bound = HEARTBEAT_STALE_MS[WATCHED];
        const parked = new Date(Date.now() - bound - 60_000);
        await prisma.jobHeartbeat.update({
          where: { key: WATCHED },
          data: { lastRunAt: parked },
        });
        const stale = await heartbeatReport();
        const finding = stale.findings.find(
          (f) => f.key === `heartbeat:${WATCHED}`,
        );
        expect(finding?.severity).toBe("operator");
        expect(finding?.detail).toContain(parked.toISOString());
        expect(finding?.detail).toContain("bound");
        expect(
          stale.routes.find((r) => r.route === WATCHED)?.ageMs,
        ).toBeGreaterThan(bound);
      } finally {
        await prisma.jobHeartbeat.deleteMany({});
      }
    });

    it("hands the provider the dedupe key, and nothing at all when there is no key", async () => {
      const payload = {
        to: ADDR,
        elementSymbol: "TST1",
        elementName: "Test One",
        amountUsd: 6,
        rank: 1,
        domain: "phase13.dev",
      };
      const sent: Record<string, string>[] = [];
      env.RESEND_API_KEY = "re_test";
      vi.stubGlobal(
        "fetch",
        async (_url: string, init: { headers: Record<string, string> }) => {
          sent.push(init.headers);
          return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
        },
      );
      try {
        await sendReceiptEmail({ ...payload, dedupeKey: "receipt-pay_13" });
        expect(sent[0]["Idempotency-Key"]).toBe(
          mailIdempotencyKey("receipt-pay_13"),
        );

        const long = `preview-${"z".repeat(300)}`;
        await sendReceiptEmail({ ...payload, dedupeKey: long });
        expect(sent[1]["Idempotency-Key"]).toBe(mailIdempotencyKey(long));
        expect(sent[1]["Idempotency-Key"]).not.toBe(sent[0]["Idempotency-Key"]);

        // An inline send with nothing to identify it must not borrow a key.
        await sendReceiptEmail(payload);
        expect(Object.keys(sent[2])).not.toContain("Idempotency-Key");
        expect(sent).toHaveLength(3);
      } finally {
        vi.unstubAllGlobals();
        delete env.RESEND_API_KEY;
      }
    });
  },
);
