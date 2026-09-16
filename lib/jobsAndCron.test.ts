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
 * the six routes, asserted against the source because the route tests are
 * DB-backed and would otherwise be the only evidence. DB sections: the heartbeat
 * rows the report reads, the header the provider actually receives, and — since
 * R20-7 spent the plan's second cron slot on it — the composite daily run, called
 * as the platform calls it.
 */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
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

import { GET as dailyGET } from "../app/api/jobs/daily/route";
import { GET as reconcileGET } from "../app/api/jobs/reconcile/route";

const prisma = testPrisma();
const hasDb = hasTestDb;
const read = (...p: string[]) =>
  readFileSync(join(__dirname, "..", ...p), "utf8");

/** The four routes that declare a work plan of their own (vercel.json's two
 *  crons — one of which is the composite daily run that drives three jobs — plus
 *  the tick's favourite call). */
const BUDGETED = [
  "app/api/jobs/outbox/route.ts",
  "app/api/jobs/screenshot/route.ts",
  "app/api/jobs/daily/route.ts",
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
    // R20-7: the screenshot entry was retired into the composite daily run, so
    // outbox is the only entry left that asks for a batch by query string. The
    // composite still gets the batch the retired entry asked for (10) because a
    // bodyless GET resolves to the route's own maximum — pinned below.
    for (const route of ["/api/jobs/outbox"]) {
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
    const daily = crons.crons.find((c) => c.path === "/api/jobs/daily");
    expect(daily, "/api/jobs/daily").toBeDefined();
    expect(daily!.path).not.toContain("?");
    const dailySource = read("app/api/jobs/daily/route.ts");
    expect(/jobLimit\(req, body, \d+, (\d+)\)/.exec(dailySource)?.[1]).toBe("10");
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
    // The tick re-loops on `remaining` in the answer, so every route it drives
    // has to report it. R20-7: the preview counts (including `remaining`) moved
    // into lib/outbox.ts, so the composite daily run and the worker route share
    // one definition — pinned at the source now, rather than at both call sites.
    expect(read("lib/outbox.ts")).toContain("remaining: out.remaining");
    expect(read("app/api/jobs/outbox/route.ts")).toContain("remaining");
    for (const [file, drain] of [
      ["app/api/jobs/screenshot/route.ts", "drainPreviews("],
      ["app/api/jobs/daily/route.ts", "drainPreviews("],
    ] as const) {
      expect(read(file), file).toContain(drain);
      expect(read(file), file).toContain("previewCounts(");
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
    // R20-7: five of the six routes now have a daily backstop — outbox through
    // its own entry, screenshot/reconcile/config through the composite run, and
    // the composite's own row, which is the platform's word that it fired — so
    // only the checkout sweep is still derived from the tick alone.
    for (const route of [
      "/api/jobs/outbox",
      "/api/jobs/screenshot",
      "/api/jobs/reconcile",
      "/api/jobs/config",
      "/api/jobs/daily",
    ] as const) {
      expect(HEARTBEAT_STALE_MS[route], route).toBe(
        24 * 60 * 60_000 + HEARTBEAT_SLACK_MS,
      );
    }
    expect(HEARTBEAT_STALE_MS["/api/jobs/abandoned-checkouts"]).toBe(
      2 * TICK_WORST_OBSERVED_MS,
    );
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

/* R20-7's whole claim is that one cron entry can drive three jobs. The static
   section above asserts the wiring; this calls the route the way the platform
   does and reads the consequence — a body with all three verdicts, and the
   heartbeat rows a stopped schedule would trip. Deliberately not asserting
   `ok: true` for the reports: the test database is shared, and a suite that
   leaves money drift behind must not turn this into a flake. What is asserted
   is the coupling — the embedded leg equals the same report called directly. */
describe.skipIf(!hasDb)("the composite daily run (R20-7)", () => {
  const COMPOSITE = "/api/jobs/daily";
  const DRIVEN = ["/api/jobs/screenshot", COMPOSITE] as const;
  type HeartbeatRow = {
    key: string;
    lastRunAt: Date;
    runs: number;
    lastError: string | null;
  };
  const snapshot: HeartbeatRow[] = [];

  type Daily = {
    ok: boolean;
    failing: number;
    jobs: {
      preview: { ok: boolean; errors: number; checked: number; remaining: number };
      reconcile: { ok: boolean; status: number; report: { ok?: boolean } };
      config: { ok: boolean; status: number; report: { ok?: boolean } };
    };
  };

  const call = async (url = `http://localhost${COMPOSITE}`) => {
    const res = await dailyGET(new NextRequest(url) as never);
    return { status: res.status, body: (await res.json()) as Daily };
  };

  beforeAll(async () => {
    snapshot.push(
      ...(await prisma.jobHeartbeat.findMany({
        where: { key: { in: [...DRIVEN] } },
      })),
    );
  });

  afterAll(async () => {
    await prisma.jobHeartbeat.deleteMany({ where: { key: { in: [...DRIVEN] } } });
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
  });

  it("answers with all three legs, and the status code is their verdict", async () => {
    const { status, body } = await call();

    // The preview leg runs on the worker's own budget and vocabulary.
    expect(body.jobs.preview.ok).toBe(true);
    expect(body.jobs.preview.errors).toBe(0);
    expect(typeof body.jobs.preview.checked).toBe("number");

    // Both reports are embedded under `report`, unflattened: each has an `ok` of
    // its own, and a merge would pass one leg's money verdict off as the run's.
    for (const leg of ["reconcile", "config"] as const) {
      expect(body.jobs[leg].status, leg).toBeGreaterThanOrEqual(200);
      expect(body.jobs[leg].report, leg).toBeTruthy();
    }

    // Every leg ok means 200 and `failing: 0`; anything else is a 500 whose
    // count is the number of bad legs. This is the coupling a monitor relies on.
    const bad = [
      !body.jobs.preview.ok,
      !body.jobs.reconcile.ok,
      !body.jobs.config.ok,
    ].filter(Boolean).length;
    expect(body.failing).toBe(bad);
    expect(status).toBe(bad === 0 ? 200 : 500);
    expect(body.ok).toBe(bad === 0);
  });

  it("answers with the reports themselves, not a second reading of them", async () => {
    const { body } = await call();
    const res = await reconcileGET(
      new NextRequest("http://localhost/api/jobs/reconcile") as never,
    );
    const direct = (await res.json()) as { ok?: boolean };

    // Same verdict, same body: the composite is a caller of the report, so the
    // two can never disagree about money.
    expect(body.jobs.reconcile.status).toBe(res.status);
    expect(body.jobs.reconcile.ok).toBe(res.ok && direct.ok !== false);
    expect(body.jobs.reconcile.report).toEqual(direct);
  });

  it("stamps the runs it performed, so a stopped schedule is visible", async () => {
    const before = await prisma.jobHeartbeat.findMany({
      where: { key: { in: [...DRIVEN] } },
    });
    const runsBefore = new Map(before.map((r) => [r.key, r.runs]));

    const { body } = await call();

    for (const key of DRIVEN) {
      const row = await prisma.jobHeartbeat.findUnique({ where: { key } });
      expect(row, key).toBeTruthy();
      // A run that happened is counted and dated, whatever the legs said —
      // the heartbeat answers "did the schedule fire", not "did it succeed".
      expect(row!.runs, key).toBe((runsBefore.get(key) ?? 0) + 1);
      expect(Date.now() - row!.lastRunAt.getTime(), key).toBeLessThan(60_000);
      // A failed leg is recorded as an error on the run's own row rather than
      // swallowed; a clean run leaves none behind. The worker's row answers for
      // the preview leg, the composite's for all three.
      const clean = key === COMPOSITE ? body.failing === 0 : body.jobs.preview.errors === 0;
      if (clean) expect(row!.lastError, key).toBeNull();
      else expect(row!.lastError, key).toBeTruthy();
    }
  });

  it("takes the batch it was asked for, and defaults like a scheduler's GET", async () => {
    // The platform's cron is a bodyless GET, which takes the route's maximum —
    // the bug R13-5 was written for. Pinned here because it is this route that
    // now spends the cron slot.
    const svc = new NextRequest(`http://localhost${COMPOSITE}`) as never;
    expect(jobLimit(svc, {}, 5, 10)).toBe(10);
    const { body } = await call(`http://localhost${COMPOSITE}?limit=1`);
    expect(body.jobs.preview.checked).toBeLessThanOrEqual(1);
  });
});
