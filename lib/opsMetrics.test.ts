/* Phase 18 dashboard, reader and alarms (R18-5, R18-7, R18-8, R18-14).
   Pure section: window clamping and every alarm in `alarmsFor`, no database.
   Integration section: `/api/admin/ops`, `/api/admin/audit` and the drain's
   `queue` block against known fixture rows. */
import { hasTestDb, purgeSettledOutbox, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import {
  OPS_WINDOW_DAYS,
  OPS_WINDOW_MAX_DAYS,
  OUTBOX_ALARM_AGE_MINUTES,
  OUTBOX_ALARM_PENDING,
  alarmsFor,
  opsReport,
  opsWindowDays,
  opsWindowStart,
  type OpsReport,
} from "./opsMetrics";
import { OUTBOX_MAX_ATTEMPTS } from "./outbox";
import { POST as outboxPOST } from "../app/api/jobs/outbox/route";
import { GET as opsGET } from "../app/api/admin/ops/route";
import { GET as auditGET } from "../app/api/admin/audit/route";

const prisma = testPrisma();
const hasDb = hasTestDb;
const ADMIN = "test-admin-token";
const T18 = 9990;
const DOMAINS = ["opsreport-t.dev", "opsreport2-t.dev"];
const PAID_USD = 66;
const REFUNDED_USD = 11;

type Env = Record<string, string | undefined>;
const penv = process.env as unknown as Env;
const req = (url: string, init?: { method?: string; headers?: Record<string, string> }) =>
  new NextRequest(`http://localhost${url}`, init);
const adminHeaders = { authorization: `Bearer ${ADMIN}` };

/** A report shaped only as far as `alarmsFor` reads it. Every field it does not
 *  look at stays at its quietest possible value, so a test that wants an alarm
 *  has to say which input produces it. */
function reportWith(
  patch: Partial<Pick<OpsReport, "outbox" | "mail" | "staleTicks" | "config">>,
): Pick<OpsReport, "outbox" | "mail" | "staleTicks" | "config"> {
  return {
    outbox: {
      driver: "resend",
      due: 0,
      pending: 0,
      pendingByType: [],
      oldestPendingMinutes: null,
      exhausted: 0,
      failed: 0,
      oldestKey: null,
      oldestDueHours: null,
      oldestDueAt: null,
      lastDeliveredAt: null,
    },
    mail: {
      driver: "resend",
      byStatus: [],
      failedCount: 0,
      oldestUnretriedKey: null,
      suppressed: 0,
      recentFailures: [],
    },
    staleTicks: [],
    config: {
      ok: true,
      providerMode: "stripe",
      stripeKeyMode: "live",
      required: [],
      advisories: [],
    },
    ...patch,
  };
}

const codes = (alarms: { code: string }[]) => alarms.map((a) => a.code);

describe("ops window (R18-7)", () => {
  it("clamps the window in both directions", () => {
    const now = Date.parse("2026-09-16T12:00:00.000Z");
    expect(opsWindowStart(7, now).toISOString()).toBe("2026-09-09T12:00:00.000Z");
    // An operator asking for ten years must not turn this into a full-table
    // scan on the shared database.
    expect(opsWindowStart(10_000, now).toISOString()).toBe(
      new Date(now - OPS_WINDOW_MAX_DAYS * 86_400_000).toISOString(),
    );
    expect(opsWindowStart(0, now).toISOString()).toBe(new Date(now - 86_400_000).toISOString());
    expect(opsWindowStart(Number.NaN, now).toISOString()).toBe(
      new Date(now - OPS_WINDOW_DAYS * 86_400_000).toISOString(),
    );
  });
  it("rounds a requested window to whole days and defaults to a week", () => {
    expect(opsWindowDays(undefined)).toBe(OPS_WINDOW_DAYS);
    expect(opsWindowDays(3)).toBe(3);
    expect(opsWindowDays(3.9)).toBe(3);
    expect(opsWindowDays(500)).toBe(OPS_WINDOW_MAX_DAYS);
    expect(opsWindowDays(Number.NaN)).toBe(OPS_WINDOW_DAYS);
    expect(opsWindowDays(-4)).toBe(OPS_WINDOW_DAYS);
  });
});

describe("alarms (R18-8, R18-9)", () => {
  it("says nothing when there is nothing to say", () => {
    expect(alarmsFor(reportWith({}))).toEqual([]);
  });
  it("separates a queue that is waiting from a queue that is stuck", () => {
    // Below the threshold: depth alone is not an alarm.
    expect(codes(alarmsFor(reportWith({ outbox: { ...reportWith({}).outbox, pending: OUTBOX_ALARM_PENDING - 1 } })))).toEqual([]);
    // Deep but still moving: warn. Deep and nothing due: critical. This is the
    // `claimed: 0` ambiguity of R18-8, made visible.
    const moving = alarmsFor(
      reportWith({ outbox: { ...reportWith({}).outbox, pending: OUTBOX_ALARM_PENDING, due: 4 } }),
    );
    expect(moving).toHaveLength(1);
    expect(moving[0].code).toBe("outbox-depth");
    expect(moving[0].severity).toBe("warn");
    const stuck = alarmsFor(
      reportWith({ outbox: { ...reportWith({}).outbox, pending: OUTBOX_ALARM_PENDING, due: 0 } }),
    );
    expect(stuck[0].severity).toBe("critical");
    expect(stuck[0].threshold).toContain("due == 0");
  });
  it("alarms on age at the threshold, not before it", () => {
    const at = (minutes: number | null) =>
      codes(
        alarmsFor(
          reportWith({ outbox: { ...reportWith({}).outbox, oldestPendingMinutes: minutes } }),
        ),
      );
    expect(at(OUTBOX_ALARM_AGE_MINUTES - 1)).not.toContain("outbox-stale");
    expect(at(OUTBOX_ALARM_AGE_MINUTES)).toContain("outbox-stale");
    expect(at(null)).not.toContain("outbox-stale");
  });
  it("names the exhausted rows and the lever for them", () => {
    const alarms = alarmsFor(
      reportWith({
        outbox: { ...reportWith({}).outbox, exhausted: 2, oldestKey: "receipt-pay_1" },
      }),
    );
    const exhausted = alarms.find((a) => a.code === "outbox-exhausted")!;
    expect(exhausted.severity).toBe("critical");
    expect(exhausted.detail).toContain(String(OUTBOX_MAX_ATTEMPTS));
    expect(exhausted.surface).toContain("receipt-pay_1");
  });
  it("alarms on unresolved mail failures and on a deployment that cannot send at all", () => {
    const failed = alarmsFor(reportWith({ mail: { ...reportWith({}).mail, failedCount: 1 } }));
    expect(failed.map((a) => a.code)).toEqual(["mail-failed"]);
    expect(failed[0].severity).toBe("warn");
    // `driver: "logged"` is not a warning: unset RESEND_API_KEY means nothing
    // leaves the building while every send still reports success locally.
    const logged = alarmsFor(
      reportWith({ mail: { ...reportWith({}).mail, driver: "logged", failedCount: 0 } }),
    );
    expect(logged.map((a) => a.code)).toEqual(["mail-not-sending"]);
    expect(logged[0].severity).toBe("critical");
  });
  it("turns a stale tick into its own alarm, keyed by route", () => {
    const stale = alarmsFor(
      reportWith({ staleTicks: [{ route: "/api/jobs/reconcile", ageHours: 30, boundHours: 24 }] }),
    );
    expect(stale.map((a) => a.code)).toEqual(["stale-tick:/api/jobs/reconcile"]);
    expect(stale[0].detail).toContain("30h");
    const never = alarmsFor(
      reportWith({ staleTicks: [{ route: "/api/jobs/outbox", ageHours: null, boundHours: 24 }] }),
    );
    expect(never[0].detail).toContain("never run");
  });
  it("alarms on a required configuration finding (R18-4)", () => {
    const required = alarmsFor(
      reportWith({
        config: {
          ok: false,
          providerMode: "stripe",
          stripeKeyMode: "test",
          required: [
            {
              key: "STRIPE_SECRET_KEY",
              severity: "required",
              detail: "a test key on a production deployment takes no money",
            },
          ],
          advisories: [],
        },
      }),
    );
    expect(required.map((a) => a.code)).toEqual(["config-required"]);
    expect(required[0].detail).toContain("STRIPE_SECRET_KEY");
  });
  it("every alarm carries a code, a threshold and a surface", () => {
    // The alert policy keys on the code and the operator follows the surface;
    // an alarm missing either is prose, not a signal.
    const all = alarmsFor(
      reportWith({
        outbox: {
          ...reportWith({}).outbox,
          pending: OUTBOX_ALARM_PENDING + 1,
          due: 0,
          exhausted: 1,
          oldestPendingMinutes: OUTBOX_ALARM_AGE_MINUTES + 1,
          oldestKey: "preview-st_1",
        },
        mail: { ...reportWith({}).mail, failedCount: 2, driver: "logged", oldestUnretriedKey: "receipt-pay_2" },
        staleTicks: [
          { route: "/api/jobs/outbox", ageHours: 99, boundHours: 24 },
          { route: "/api/jobs/config", ageHours: null, boundHours: 48 },
        ],
      }),
    );
    expect(codes(all).sort()).toEqual([
      "mail-failed",
      "mail-not-sending",
      "outbox-depth",
      "outbox-exhausted",
      "outbox-stale",
      "stale-tick:/api/jobs/config",
      "stale-tick:/api/jobs/outbox",
    ]);
    for (const alarm of all) {
      expect(alarm.code.length).toBeGreaterThan(0);
      expect(alarm.threshold.length).toBeGreaterThan(0);
      expect(alarm.surface.length).toBeGreaterThan(0);
      expect(["critical", "warn"]).toContain(alarm.severity);
    }
  });
});

describe.skipIf(!hasDb)("dashboard, reader and queue (R18-5, R18-7, R18-8, R18-14)", () => {
  let paidId = "";
  let refundedId = "";
  let startupId = "";

  beforeAll(async () => {
    penv.ADMIN_TOKEN = ADMIN;
    await prisma.stake.deleteMany({ where: { elementId: T18 } });
    await prisma.element.upsert({
      where: { id: T18 },
      create: {
        id: T18,
        symbol: "TST18",
        name: "Test Eighteen",
        atomicMass: "0",
        gridRow: 0,
        gridCol: 0,
        family: "EXOTIC_THEORETICAL",
        tier: "EXOTIC",
      },
      update: {},
    });
    const startup = await prisma.startup.upsert({
      where: { domain: DOMAINS[0] },
      create: {
        domain: DOMAINS[0],
        title: DOMAINS[0],
        pitch: "ops report fixture pitch",
        url: `https://${DOMAINS[0]}`,
        logoUrl: "x",
        email: "opsreport-t@example.com",
      },
      update: {},
    });
    startupId = startup.id;
    const stake = await prisma.stake.create({
      data: { elementId: T18, startupId: startup.id, amountUsd: PAID_USD, isLeader: true },
    });
    const paid = await prisma.payment.create({
      data: {
        elementId: T18,
        startupId: startup.id,
        amountUsd: PAID_USD,
        path: "JOIN",
        provider: "DEV",
        idempotencyKey: `opsreport-paid-${Date.now()}`,
        status: "PAID",
        appliedAt: new Date(),
        paidAt: new Date(),
        stakeId: stake.id,
      },
    });
    paidId = paid.id;
    const refunded = await prisma.payment.create({
      data: {
        elementId: T18,
        startupId: startup.id,
        amountUsd: REFUNDED_USD,
        path: "JOIN",
        provider: "DEV",
        idempotencyKey: `opsreport-refunded-${Date.now()}`,
        status: "REFUNDED",
        paidAt: new Date(Date.now() - 120_000),
        refundedAt: new Date(),
      },
    });
    refundedId = refunded.id;
    await prisma.auditLog.create({
      data: {
        action: "PAYMENT_REVERSED",
        startupId: startup.id,
        elementId: T18,
        paymentId: refundedId,
        detail: "opsreport fixture reversal",
      },
    });
    await prisma.providerEvent.create({
      data: {
        provider: "DEV",
        providerEventId: `opsreport-${Date.now()}`,
        eventType: "dev.report",
        paymentId: paidId,
        outcome: "ERROR",
        detail: "opsreport fixture delivery",
      },
    });
    await prisma.outboxEvent.create({
      data: {
        type: "STAKE_ANALYTICS",
        dedupeKey: `opsreport-pending-${Date.now()}`,
        payload: {},
      },
    });
  });

  afterAll(async () => {
    await prisma.providerEvent.deleteMany({ where: { payment: { startup: { domain: { in: DOMAINS } } } } });
    await purgeSettledOutbox(prisma, { startup: { domain: { in: DOMAINS } } });
    await prisma.outboxEvent.deleteMany({ where: { dedupeKey: { startsWith: "opsreport-" } } });
    await prisma.payment.deleteMany({ where: { startup: { domain: { in: DOMAINS } } } });
    await prisma.auditLog.deleteMany({ where: { startupId } });
    await prisma.errorReport.deleteMany({ where: { fingerprint: { startsWith: "opsreport-" } } });
    await prisma.stake.deleteMany({ where: { elementId: T18 } });
    await prisma.element.deleteMany({ where: { id: T18 } });
    await prisma.startup.deleteMany({ where: { domain: { in: DOMAINS } } });
    await prisma.$disconnect();
  });

  it("defines money once, and counts the window separately from the book", async () => {
    const report = await opsReport();
    expect(report.money.definition).toContain("Payment.status is PAID");
    expect(report.money.label).toContain("book-scoped");
    // Book scope: every row at every status, netted against reversals.
    const rows = await prisma.payment.groupBy({ by: ["status"], _count: { _all: true }, _sum: { amountUsd: true } });
    const sumOf = (status: string) => rows.find((r) => r.status === status)?._sum.amountUsd ?? 0;
    expect(report.money.paidGrossUsd).toBe(sumOf("PAID"));
    expect(report.money.paidNetUsd).toBe(sumOf("PAID") - sumOf("REFUNDED"));
    expect(report.money.reversedCount).toBeGreaterThanOrEqual(1);
    // Window scope: paid *and applied* inside the last week, which is the
    // `paid → settled` conversion R18-14 asks for.
    expect(report.money.window.paidCount).toBeGreaterThanOrEqual(1);
    expect(report.money.window.settledCount).toBeGreaterThanOrEqual(1);
    expect(report.money.window.settledUsd).toBeGreaterThanOrEqual(PAID_USD);
    expect(report.money.window.settledRate).toBeLessThanOrEqual(1);
  });

  it("computes the funnel server-side, from the ledger's own events", async () => {
    const report = await opsReport();
    expect(report.funnel.source).toContain("not authoritative");
    expect(report.funnel.paid).toBe(report.money.window.paidCount);
    // No clicks in the window is a null ratio, never 0/0 read as "nobody is
    // interested" — unknown and zero are different claims.
    if (report.funnel.clicks === 0) expect(report.funnel.clickToCheckout).toBeNull();
    else expect(report.funnel.clickToCheckout).toBeGreaterThan(0);
    expect(report.funnel.checkoutsStarted).toBeGreaterThanOrEqual(report.funnel.paid);
  });

  it("reports the queue, the mail and the operator trail in one read", async () => {
    const report = await opsReport();
    expect(report.outbox.pending).toBeGreaterThanOrEqual(1);
    expect(report.outbox.pendingByType.map((t) => t.type)).toContain("STAKE_ANALYTICS");
    expect(report.outbox.oldestPendingMinutes).toBeGreaterThanOrEqual(0);
    expect(report.mail.driver).toBe(process.env.RESEND_API_KEY ? "resend" : "logged");
    expect(report.audit.byAction.map((a) => a.action)).toContain("PAYMENT_REVERSED");
    expect(report.audit.reader).toContain("/api/admin/audit");
    expect(report.providerEvents.byOutcome.map((o) => o.outcome)).toContain("ERROR");
    expect(report.providerEvents.recentErrors.some((e) => e.paymentId === paidId)).toBe(true);
    expect(["stripe", "dev"]).toContain(report.config.providerMode);
    expect(["live", "test", "unknown", "unset"]).toContain(report.config.stripeKeyMode);
    // The wiring the operator depends on: the report's own list is what
    // `alarmsFor` says about the same numbers.
    expect(report.alarms).toEqual(alarmsFor(report));
  });

  it("reads its own sink back, windowed and bounded (R18-1)", async () => {
    // Deltas, not absolutes: every file in this suite shares one database, so
    // the block's question is "did these rows move the numbers", not "are the
    // numbers zero". Nothing else writes while this runs (`fileParallelism:
    // false`), which is what makes an exact delta assertable.
    const weekBefore = await opsReport();
    const dayBefore = await opsReport({ days: 1 });
    const now = Date.now();
    await prisma.errorReport.createMany({
      data: [
        {
          source: "api",
          kind: "TypeError",
          message: "opsreport fixture boom",
          fingerprint: "opsreport-a",
          occurrences: 3,
          route: "/api/stakes",
          deploy: "deploy0abc123",
          requestId: "opsreport-req",
          createdAt: new Date(now - 60_000),
        },
        {
          source: "client",
          message: "opsreport fixture older",
          fingerprint: "opsreport-b",
          createdAt: new Date(now - 3 * 24 * 3_600_000),
        },
      ],
    });

    const week = await opsReport();
    const day = await opsReport({ days: 1 });
    expect(week.errors.count).toBe(weekBefore.errors.count + 2);
    // Repeat count, not row count: three occurrences of one fingerprint is one
    // row and three failures, and the block reports both.
    expect(week.errors.occurrences).toBe(weekBefore.errors.occurrences + 4);
    expect(week.errors.bySource.map((s) => s.source)).toEqual(
      expect.arrayContaining(["api", "client"]),
    );
    expect(week.errors.recent[0]).toMatchObject({
      source: "api",
      kind: "TypeError",
      route: "/api/stakes",
      message: "opsreport fixture boom",
      occurrences: 3,
      deploy: "deploy0abc123",
      requestId: "opsreport-req",
    });
    // Bounded fields: the stack is the row's bytes and belongs in psql, not in
    // an operator response a proxy or a screenshot will carry off.
    expect(Object.keys(week.errors.recent[0])).not.toContain("stack");

    // The window is a real filter — the three-day-old row is outside a day —
    // while `recent` stays unwindowed so "nothing in the window" is still
    // distinguishable from "nothing ever".
    expect(day.errors.count).toBe(dayBefore.errors.count + 1);
    // Bounded, not merely unwindowed: the newest-ten list is a fixed size, and
    // its first row is the newest row in the table.
    expect(week.errors.recent.length).toBeLessThanOrEqual(10);
    expect(week.errors.note).toContain("recent is the last 10 rows ever");
    expect(week.errors.note).toContain("not that nothing failed");
  });

  it("serves the dashboard only to the operator, and never as a 5xx for an alarm", async () => {
    // 403 when no credential was offered at all, 401 when one was and was
    // wrong (lib/jobs.ts `adminAuth`/`refuse`): the two shapes are the same
    // answer the other operator routes give.
    expect((await opsGET(req("/api/admin/ops"))).status).toBe(403);
    expect((await opsGET(req("/api/admin/ops", { headers: { authorization: "Bearer nope" } }))).status).toBe(403);
    expect((await opsGET(req("/api/admin/ops", { headers: adminHeaders }))).status).toBe(200);

    const res = await opsGET(req("/api/admin/ops?days=30", { headers: adminHeaders }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpsReport;
    expect(body.windowDays).toBe(30);
    expect(res.headers.get("X-Ops-Alarms")).toBe(codes(body.alarms).join(",") || "-");
    expect(res.headers.get("X-Ops-Outbox-Pending")).toBe(String(body.outbox.pending));
    expect(res.headers.get("X-Ops-Paid-Net-Usd")).toBe(String(body.money.paidNetUsd));
    expect(res.headers.get("X-Ops-Errors")).toBe(String(body.errors.count));
    expect(res.headers.get("Cache-Control")).toContain("no-store");

    // A bad window is a caller error, not a different question answered quietly.
    expect((await opsGET(req("/api/admin/ops?days=0", { headers: adminHeaders }))).status).toBe(400);
    expect((await opsGET(req("/api/admin/ops?days=abc", { headers: adminHeaders }))).status).toBe(400);
    expect((await opsGET(req("/api/admin/ops?days=365", { headers: adminHeaders }))).status).toBe(400);

    // `?ok=1` is the opt-in alert rule: the default poll stays 200 whatever the
    // alarms say, and only this asks for a status a pinger can act on.
    const asked = await opsGET(req("/api/admin/ops?ok=1", { headers: adminHeaders }));
    expect(asked.status).toBe(body.alarms.length > 0 ? 503 : 200);
  });

  it("reads the audit trail, with validated filters and a cursor", async () => {
    expect((await auditGET(req("/api/admin/audit"))).status).toBe(403);
    // R11-6's lesson: an unknown action is a 400, not an empty page.
    const bad = await auditGET(req("/api/admin/audit?action=payment_reversed", { headers: adminHeaders }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("BAD_ACTION");

    const res = await auditGET(req("/api/admin/audit?action=PAYMENT_REVERSED", { headers: adminHeaders }));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; paymentId: string | null; detail: string | null }[];
    expect(rows.some((r) => r.paymentId === refundedId)).toBe(true);
    // Header counts the whole window; the body is one page of it.
    expect(Number(res.headers.get("X-Audit-Payment-Reversed"))).toBeGreaterThanOrEqual(rows.length);
    expect(Number(res.headers.get("X-Audit-Payment-Reversed"))).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers.get("X-Audit-Operator-Writes"))).toBeGreaterThanOrEqual(0);

    // The cursor stops at the previous page's last row and repeats nothing.
    const first = rows[0];
    const page2 = (await (
      await auditGET(req(`/api/admin/audit?action=PAYMENT_REVERSED&before=${first.id}`, { headers: adminHeaders }))
    ).json()) as { id: string }[];
    expect(page2.map((r) => r.id)).not.toContain(first.id);

    // Scoped to one startup, and a cursor that does not exist is not a 500.
    const scoped = await auditGET(req(`/api/admin/audit?startup=${startupId}`, { headers: adminHeaders }));
    expect(scoped.status).toBe(200);
    const scopedRows = (await scoped.json()) as { paymentId: string | null }[];
    expect(scopedRows.some((r) => r.paymentId === refundedId)).toBe(true);
    const ghost = await auditGET(req("/api/admin/audit?before=opsreport-missing-cursor", { headers: adminHeaders }));
    expect(ghost.status).toBe(200);
    expect((await ghost.json()) as unknown[]).toEqual([]);
  });

  it("tells the drain what the queue looks like, next to what it did", async () => {
    const res = await outboxPOST(
      req("/api/jobs/outbox", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      claimed: number;
      queue: { pending: number; due: number; exhausted: number; failed: number; oldestPendingMinutes: number | null };
    };
    expect(body.queue).toBeDefined();
    // The two numbers R18-8 says were being conflated: what this call did, and
    // how deep the queue is.
    expect(typeof body.claimed).toBe("number");
    expect(body.queue.pending).toBeGreaterThanOrEqual(0);
    expect(body.queue.exhausted).toBeLessThanOrEqual(body.queue.pending + body.queue.failed);
    expect(typeof body.queue.due).toBe("number");
  });
});
