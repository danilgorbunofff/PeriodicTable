/**
 * The launch-day dashboard, as one authenticated read (doc 18 §3.8, R18-5 …
 * R18-14).
 *
 * Doc 18 §3.8 defined the operator's seven questions and found that three of
 * them ("did anything get paid", "is the queue deep/stale/failing", "did the
 * mail leave") existed only as SQL someone typed by hand, and a fourth (the
 * audit trail) had no reader at all. This module is that dashboard: every
 * number §3.8 asks for, in one response, computed from the tables that already
 * hold the truth — no new state, no counters to drift, nothing written.
 *
 * Three rules shape it, and each is a finding in the review:
 *
 * - **One definition of money** (R18-7). "Paid" means `Payment.status = PAID`:
 *   the provider's money arrived and the stake was applied. `/api/stats`'
 *   money fields are board-scoped (they sum the elements currently on the
 *   board, hidden ones included) and cannot be compared with it; that labelling
 *   is the other half of this fix.
 * - **Alarms do not flip the status code** (R18-8, §3.10). `/api/health` and
 *   `/api/jobs/config` answer "is the deployment serving"; a deep queue, a
 *   stale tick or a failed receipt must not make a pinger declare the site
 *   down — that is how a monitor gets muted before the real outage. They are
 *   reported as an `alarms` list here instead, each with the threshold that
 *   produced it, and the channel and recipient per class is the operator's
 *   (`D18`) and lives in `ops/alerts.md`.
 * - **Conversions are server-side** (R18-14). `click → checkout → paid` is
 *   computed from `ClickEvent`, `Payment` and `appliedAt`, not from the seven
 *   client-side analytics events, which are inert unless the operator turns
 *   them on (R18-13) and would in any case be the browser's account of a
 *   purchase rather than the ledger's. §3.9 says the same about
 *   `checkout_paid`: if the two ever disagree, this is the authoritative one.
 *
 * Cost: every query here is a count or a bounded `take` over an existing index
 * (`Payment(status)`, `OutboxEvent(nextAttemptAt)`/`(type, completedAt)`,
 * `AuditLog(createdAt)`), it runs on an authenticated operator route, and the
 * window is capped at 90 days. Nothing here is on a visitor path.
 *
 * It fails closed: a table it cannot read makes the route answer 500 rather
 * than a body of zeros. Fallback zeros in a dashboard are indistinguishable
 * from "nothing happened", which is the one reading an operator must never get
 * by accident — and reachability already has a surface of its own, with a
 * status code a monitor can read (`/api/health`, R18-6).
 */
import { prisma } from "./prisma";
import { mailDriver, suppressedCount } from "./email";
import {
  failedMailHealth,
  outboxHealth,
  OUTBOX_MAX_ATTEMPTS,
  type OutboxHealth,
} from "./outbox";
import { heartbeatReport } from "./jobHeartbeat";
import { getProdConfigReport, type ProdConfigFinding } from "./env";
import { getProviderMode, stripeKeyMode } from "./stripe";

/** Default window for every rate, conversion and "since" in the report. A week
 *  is what "how is launch going" means; the day figure rides along because
 *  launch day is the day someone asks. */
export const OPS_WINDOW_DAYS = 7;
export const OPS_WINDOW_MAX_DAYS = 90;

/** Queue depth at which the backlog is worth a human's attention, and the age
 *  at which a row stops being "in flight" and starts being stuck (R18-8). Both
 *  are thresholds, not facts: `ops/alerts.md` states them next to the channel
 *  and the recipient, and this constant is the one place they are defined. */
export const OUTBOX_ALARM_PENDING = 25;
export const OUTBOX_ALARM_AGE_MINUTES = 120;

export type OpsAlarm = {
  /** Stable machine name — the alert policy keys on this, not on prose. */
  code: string;
  severity: "critical" | "warn";
  /** The observation, in one sentence, with the number that produced it. */
  detail: string;
  /** The threshold the observation crossed, so a reader can argue with it. */
  threshold: string;
  /** Where the operator goes next. */
  surface: string;
};

/**
 * The window's start, clamped. An operator asking for `?days=10000` must not be
 * able to turn this route into a full-table scan on a shared database.
 */
export function opsWindowStart(days: number, now: number = Date.now()): Date {
  const clamped = Math.min(
    OPS_WINDOW_MAX_DAYS,
    Math.max(1, Math.floor(Number.isFinite(days) ? days : OPS_WINDOW_DAYS)),
  );
  return new Date(now - clamped * 86_400_000);
}

export function opsWindowDays(days: number | undefined): number {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return OPS_WINDOW_DAYS;
  return Math.min(OPS_WINDOW_MAX_DAYS, Math.floor(n));
}

export type OpsMoney = {
  definition: string;
  /** Every row, by status: the §3.8 row 4 query, in the response. */
  byStatus: { status: string; count: number; usd: number }[];
  paidCount: number;
  paidGrossUsd: number;
  reversedCount: number;
  reversedUsd: number;
  /** paidGrossUsd − reversedUsd. The launch-day money metric (R18-7). */
  paidNetUsd: number;
  /** Money that arrived inside the window, and how much of it turned into a
   *  live stake — the `paid → settled` conversion of R18-14. `settledCount` is
   *  lower than `windowPaidCount` when a payment was refunded before it was
   *  applied, which is the whole point of counting it separately. */
  window: {
    days: number;
    paidCount: number;
    paidUsd: number;
    settledCount: number;
    settledUsd: number;
    settledRate: number | null;
  };
  label: string;
};

export type OpsFunnel = {
  windowDays: number;
  /** Verified redirects on unclaimed tiles (ClickEvent) — the top of the
   *  funnel as the product actually measures it. */
  clicks: number;
  checkoutsStarted: number;
  paid: number;
  clickToCheckout: number | null;
  checkoutToPaid: number | null;
  source: string;
};

export type OpsMail = {
  driver: "resend" | "logged";
  byStatus: { status: string; count: number; lastAt: string | null }[];
  failedCount: number;
  oldestUnretriedKey: string | null;
  suppressed: number;
  /** The most recent failures, without the address: the register keeps the
   *  person, the report keeps the diagnosis (R18-3). */
  recentFailures: {
    template: string;
    providerStatus: number | null;
    detail: string | null;
    error: string | null;
    at: string;
  }[];
};

export type OpsAudit = {
  byAction: { action: string; count: number; lastAt: string | null }[];
  recent: {
    action: string;
    actorType: string;
    actorRef: string | null;
    elementId: number | null;
    paymentId: string | null;
    startupId: string | null;
    at: string;
  }[];
  /** The row reader for anything beyond this summary (R18-5). */
  reader: string;
};

export type OpsProviderEvents = {
  byOutcome: { outcome: string; count: number }[];
  recentErrors: {
    id: string;
    provider: string;
    eventType: string;
    detail: string | null;
    paymentId: string | null;
    at: string;
  }[];
};

export type OpsErrors = {
  /** Windowed like every other rate here: `count` is rows written inside it,
   *  and `recent` is the last few rows in the table regardless of window, so
   *  "nothing in the window" stays distinguishable from "nothing ever". */
  count: number;
  occurrences: number;
  bySource: { source: string; count: number; lastAt: string | null }[];
  recent: {
    at: string;
    source: string;
    kind: string | null;
    route: string | null;
    message: string;
    occurrences: number;
    deploy: string | null;
    requestId: string | null;
  }[];
  note: string;
};

export type OpsReport = {
  ok: boolean;
  generatedAt: string;
  windowDays: number;
  money: OpsMoney;
  funnel: OpsFunnel;
  outbox: OutboxHealth;
  mail: OpsMail;
  audit: OpsAudit;
  providerEvents: OpsProviderEvents;
  errors: OpsErrors;
  config: {
    ok: boolean;
    providerMode: "stripe" | "dev";
    stripeKeyMode: "live" | "test" | "unknown" | "unset";
    required: ProdConfigFinding[];
    advisories: ProdConfigFinding[];
  };
  /** The heartbeat findings (R13-3) as alarms too: "a tick stopped running" is
   *  a class of failure in its own right (§3.10 row 9), not only a config
   *  caveat. */
  staleTicks: { route: string; ageHours: number | null; boundHours: number }[];
  alarms: OpsAlarm[];
};

/** Fractions are rounded to four places: a launch-day conversion can legitimately
 *  be 3 in 900, and a rate that rounds to 0.00 is a rate that says nothing. */
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Every number the dashboard needs, in one round trip.
 *
 * Everything is read in parallel and nothing is cached: this runs on the
 * operator's tick, not on a buyer's request path.
 */
export async function opsReport(
  opts: { days?: number; now?: Date } = {},
): Promise<OpsReport> {
  const now = opts.now ?? new Date();
  const days = opsWindowDays(opts.days);
  const since = opsWindowStart(days, now.getTime());

  const [statusGroups, windowPaid, reversed, windowSettled, clicks, started] =
    await Promise.all([
      prisma.payment.groupBy({
        by: ["status"],
        _count: { _all: true },
        _sum: { amountUsd: true },
      }),
      prisma.payment.findMany({
        where: { status: "PAID", appliedAt: { gte: since } },
        select: { amountUsd: true },
      }),
      prisma.payment.aggregate({
        where: { status: "REFUNDED" },
        _count: { _all: true },
        _sum: { amountUsd: true },
      }),
      prisma.payment.aggregate({
        where: { status: "PAID", appliedAt: { gte: since }, stakeId: { not: null } },
        _count: { _all: true },
        _sum: { amountUsd: true },
      }),
      prisma.clickEvent.count({ where: { createdAt: { gte: since } } }),
      prisma.payment.count({ where: { createdAt: { gte: since } } }),
    ]);

  const byStatus = statusGroups
    .map((row) => ({
      status: row.status,
      count: row._count._all,
      usd: row._sum.amountUsd ?? 0,
    }))
    .sort((a, b) => b.count - a.count);
  const countOf = (status: string) =>
    byStatus.find((row) => row.status === status)?.count ?? 0;
  const usdOf = (status: string) =>
    byStatus.find((row) => row.status === status)?.usd ?? 0;
  const windowPaidUsd = windowPaid.reduce((sum, p) => sum + p.amountUsd, 0);
  const settledCount = windowSettled._count._all;

  const [outbox, mail, audit, providerEvents, errors, stale] = await Promise.all([
    outboxHealth(now),
    mailHealth(),
    auditSummary(since),
    providerEventSummary(since),
    errorSummary(since),
    staleTicks(now),
  ]);

  const report: OpsReport = {
    ok: true,
    generatedAt: now.toISOString(),
    windowDays: days,
    money: {
      definition:
        "Paid = Payment.status is PAID: the provider's money arrived and the stake was applied. Net = paid minus reversed. This is the only figure that means 'how much was paid' — /api/stats' money fields are board-scoped (R18-7).",
      byStatus,
      paidCount: countOf("PAID"),
      paidGrossUsd: usdOf("PAID"),
      reversedCount: reversed._count._all,
      reversedUsd: reversed._sum.amountUsd ?? 0,
      paidNetUsd: usdOf("PAID") - (reversed._sum.amountUsd ?? 0),
      window: {
        days,
        paidCount: windowPaid.length,
        paidUsd: windowPaidUsd,
        settledCount,
        settledUsd: windowSettled._sum.amountUsd ?? 0,
        settledRate:
          windowPaid.length === 0
            ? null
            : round4(settledCount / windowPaid.length),
      },
      label: "book-scoped (all payments), not board-scoped",
    },
    funnel: {
      windowDays: days,
      clicks,
      checkoutsStarted: started,
      paid: windowPaid.length,
      clickToCheckout: clicks === 0 ? null : round4(started / clicks),
      checkoutToPaid: started === 0 ? null : round4(windowPaid.length / started),
      source:
        "Server-side: ClickEvent rows (a verified redirect to a tile nobody has claimed), Payment rows created, and payments applied inside the window. The seven client-side analytics events are informative only and are not authoritative for money (R18-14).",
    },
    outbox,
    mail,
    audit,
    providerEvents,
    errors,
    config: configSummary(),
    staleTicks: stale,
    alarms: [],
  };
  report.alarms = alarmsFor(report);
  return report;
}

/** The `alarms` list, derived from a report. Kept separate from `opsReport` so
 *  the thresholds are testable without a database, and so a caller that has
 *  already read the blocks (a monitor, a test) can ask the same question the
 *  route asks. Severity is the operator's priority, not a status code: nothing
 *  here changes what any route returns.
 *
 * Two deliberate absences. `money` is not alarmed on: a refunded payment is a
 * business decision, not a fault, and a threshold on the settled rate would fire
 * on every honest refund. `config` is alarmed on only for `required` findings —
 * the advisories in `/api/jobs/config` are the pinger's judgement call, this is
 * the operator's, and a deployment running a Stripe test key in production is
 * exactly the finding that must show up as an alarm rather than as a field. */
export function alarmsFor(
  report: Pick<OpsReport, "outbox" | "mail" | "staleTicks" | "config">,
): OpsAlarm[] {
  const alarms: OpsAlarm[] = [];
  const { outbox, mail, staleTicks, config } = report;

  if (outbox.pending >= OUTBOX_ALARM_PENDING && outbox.due === 0) {
    alarms.push({
      code: "outbox-depth",
      severity: "critical",
      detail: `${outbox.pending} undelivered outbox rows and none of them due: the queue is not draining.`,
      threshold: `pending >= ${OUTBOX_ALARM_PENDING} and due == 0`,
      surface: "/api/jobs/outbox, ops/email.md",
    });
  } else if (outbox.pending >= OUTBOX_ALARM_PENDING) {
    alarms.push({
      code: "outbox-depth",
      severity: "warn",
      detail: `${outbox.pending} undelivered outbox rows are waiting.`,
      threshold: `pending >= ${OUTBOX_ALARM_PENDING}`,
      surface: "/api/jobs/outbox, ops/email.md",
    });
  }
  if (
    outbox.oldestPendingMinutes !== null &&
    outbox.oldestPendingMinutes >= OUTBOX_ALARM_AGE_MINUTES
  ) {
    alarms.push({
      code: "outbox-stale",
      severity: "critical",
      detail: `The oldest undelivered row has waited ${outbox.oldestPendingMinutes} minutes (${outbox.oldestDueAt ?? "unknown"}).`,
      threshold: `oldestPendingMinutes >= ${OUTBOX_ALARM_AGE_MINUTES}`,
      surface: "/api/jobs/outbox with type/limit, ops/email.md",
    });
  }
  if (outbox.exhausted > 0) {
    alarms.push({
      code: "outbox-exhausted",
      severity: "critical",
      detail: `${outbox.exhausted} rows have spent all ${OUTBOX_MAX_ATTEMPTS} attempts: no worker will ever retry them.`,
      threshold: "exhausted > 0",
      surface: `POST /api/admin/outbox/retry with ${outbox.oldestKey ?? "<dedupeKey>"}`,
    });
  }
  if (mail.failedCount > 0) {
    alarms.push({
      code: "mail-failed",
      severity: "warn",
      detail: `${mail.failedCount} sent messages failed and were never superseded by a success.`,
      threshold: "failedCount > 0",
      surface: mail.oldestUnretriedKey
        ? `POST /api/admin/outbox/retry ${JSON.stringify(mail.oldestUnretriedKey)}`
        : "ops/email.md",
    });
  }
  if (mail.driver === "logged") {
    alarms.push({
      code: "mail-not-sending",
      severity: "critical",
      detail:
        "RESEND_API_KEY is unset, so every send is recorded and nothing leaves the building.",
      threshold: 'driver == "logged"',
      surface: "ops/secrets.md, /api/jobs/config",
    });
  }
  if (config.required.length > 0) {
    alarms.push({
      code: "config-required",
      severity: "critical",
      detail: `Required configuration is missing or wrong: ${config.required
        .map((f) => f.key)
        .join(", ")}.`,
      threshold: "required findings > 0",
      surface: "/api/jobs/config",
    });
  }
  for (const tick of staleTicks) {
    alarms.push({
      code: `stale-tick:${tick.route}`,
      severity: "critical",
      detail:
        tick.ageHours === null
          ? `${tick.route} has never run.`
          : `${tick.route} last ran ${tick.ageHours}h ago (bound ${tick.boundHours}h).`,
      threshold: `age > ${tick.boundHours}h`,
      surface: `/api/jobs/config (${tick.route})`,
    });
  }
  return alarms;
}

/** The sink's own reader (R18-1). Without one the `ErrorReport` table was
 *  write-only: a failure at 03:00 was countable but invisible, and the operator
 *  had to open psql to see a message. The last few rows are shown without the
 *  window because "the newest row is three days old" and "there are no rows" are
 *  different answers, and the `stack` is deliberately not carried — it is the
 *  row's bytes, and a dashboard that pastes a stack into a response is a
 *  dashboard that leaks an arbitrary amount of whatever the thrower knew. Read
 *  the row by `fingerprint` when a stack is what you need.
 *
 *  It is not an alarm: a caught client error is not an outage, and one buyer
 *  with a broken browser is not a page. What the operator alerts on is the
 *  classes in `ops/alerts.md`, which is what the `alarms` list carries. */
async function errorSummary(since: Date): Promise<OpsErrors> {
  const [count, totals, groups, recent] = await Promise.all([
    prisma.errorReport.count({ where: { createdAt: { gte: since } } }),
    prisma.errorReport.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { occurrences: true },
    }),
    prisma.errorReport.groupBy({
      by: ["source"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.errorReport.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 10,
      select: {
        source: true,
        kind: true,
        route: true,
        message: true,
        occurrences: true,
        deploy: true,
        requestId: true,
        createdAt: true,
      },
    }),
  ]);
  return {
    count,
    occurrences: totals._sum.occurrences ?? 0,
    bySource: groups
      .map((row) => ({
        source: row.source,
        count: row._count._all,
        lastAt: row._max.createdAt ? row._max.createdAt.toISOString() : null,
      }))
      .sort((a, b) => b.count - a.count),
    recent: recent.map((row) => ({
      at: row.createdAt.toISOString(),
      source: row.source,
      kind: row.kind,
      route: row.route,
      message: row.message,
      occurrences: row.occurrences,
      deploy: row.deploy,
      requestId: row.requestId,
    })),
    note: "Counts rows in ErrorReport inside the window; recent is the last 10 rows ever, newest first. Zero rows means the sink recorded nothing, not that nothing failed: a crash before the reporter is bound — a boot-time throw, an edge runtime — is only in the log drain (ops/alerts.md).",
  };
}

async function mailHealth(): Promise<OpsMail> {
  const [groups, health, suppressed, failures] = await Promise.all([
    prisma.emailLog.groupBy({
      by: ["status"],
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    failedMailHealth(),
    suppressedCount(),
    prisma.emailLog.findMany({
      where: { status: "error" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        template: true,
        providerStatus: true,
        detail: true,
        error: true,
        createdAt: true,
      },
    }),
  ]);
  return {
    driver: mailDriver(),
    byStatus: groups
      .map((row) => ({
        status: row.status,
        count: row._count._all,
        lastAt: row._max.createdAt ? row._max.createdAt.toISOString() : null,
      }))
      .sort((a, b) => b.count - a.count),
    failedCount: health.failed,
    oldestUnretriedKey: health.oldestKey,
    suppressed,
    recentFailures: failures.map((row) => ({
      template: row.template,
      providerStatus: row.providerStatus,
      detail: row.detail,
      error: row.error,
      at: row.createdAt.toISOString(),
    })),
  };
}

async function auditSummary(since: Date): Promise<OpsAudit> {
  const [groups, recent] = await Promise.all([
    prisma.auditLog.groupBy({
      by: ["action"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.auditLog.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
      select: {
        action: true,
        actorType: true,
        actorRef: true,
        elementId: true,
        paymentId: true,
        startupId: true,
        createdAt: true,
      },
    }),
  ]);
  return {
    byAction: groups
      .map((row) => ({
        action: row.action,
        count: row._count._all,
        lastAt: row._max.createdAt ? row._max.createdAt.toISOString() : null,
      }))
      .sort((a, b) => b.count - a.count),
    recent: recent.map((row) => ({
      action: row.action,
      actorType: row.actorType,
      actorRef: row.actorRef,
      elementId: row.elementId,
      paymentId: row.paymentId,
      startupId: row.startupId,
      at: row.createdAt.toISOString(),
    })),
    reader: "GET /api/admin/audit?action=&startup=&payment=&before=",
  };
}

async function providerEventSummary(since: Date): Promise<OpsProviderEvents> {
  const [groups, errors] = await Promise.all([
    prisma.providerEvent.groupBy({
      by: ["outcome"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.providerEvent.findMany({
      where: { outcome: "ERROR", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        provider: true,
        eventType: true,
        detail: true,
        paymentId: true,
        createdAt: true,
      },
    }),
  ]);
  return {
    byOutcome: groups
      .map((row) => ({ outcome: row.outcome, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
    recentErrors: errors.map((row) => ({
      id: row.id,
      provider: row.provider,
      eventType: row.eventType,
      detail: row.detail,
      paymentId: row.paymentId,
      at: row.createdAt.toISOString(),
    })),
  };
}

function configSummary(): OpsReport["config"] {
  const { ok, findings } = getProdConfigReport();
  return {
    ok,
    // R18-4: the report the pinger reads answers `ok` only for `required`
    // findings, so advisories need a surface that shows them *without* changing
    // a status code. This is that surface.
    providerMode: getProviderMode(),
    stripeKeyMode: stripeKeyMode(),
    required: findings.filter((f) => f.severity === "required"),
    advisories: findings.filter((f) => f.severity !== "required"),
  };
}

/** The routes whose own bound has been exceeded (R13-3's findings, as alarms).
 *  `heartbeatReport()` already measured and classified them; this only renames
 *  the shape, because §3.10 wants the stale tick to be a *signal* an operator
 *  can route, not a field buried in a config body. */
async function staleTicks(now: Date): Promise<OpsReport["staleTicks"]> {
  const report = await heartbeatReport(now.getTime());
  const stale = new Set(
    report.findings
      .filter((f) => f.key.startsWith("heartbeat:"))
      .map((f) => f.key.slice("heartbeat:".length)),
  );
  return report.routes
    .filter((route) => stale.has(route.route))
    .map((route) => ({
      route: route.route,
      ageHours: route.ageMs === null ? null : Math.round(route.ageMs / 3_600_000),
      boundHours: Math.round(route.boundMs / 3_600_000),
    }));
}
