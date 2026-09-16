/**
 * Error sink (Phase 18, R18-1 and R18-10).
 *
 * Before this, a 500, a crashed render, or a client-boundary throw produced one
 * platform log line and nothing durable: the plan level's log retention is about
 * an hour (§5.8), the two error boundaries wrote to the user's own console
 * (`app/error.tsx:20`, `app/global-error.tsx:16`), and there was no server-side
 * handler at all. An incident at 03:00 was therefore unreadable by 04:30 — the
 * same finding the review recorded against the whole observability story.
 *
 * What is here is deliberately the cheapest thing that answers "did anything
 * break, and where": one table (`ErrorReport`), one public write route
 * (`POST /api/internal/error`), and this module as the single funnel every
 * reporter goes through. No vendor SDK — that is operator decision
 * `D18-1` (`18` §9 `D17`), and until it is taken, a table the product already owns is the only sink that
 * cannot leak a payload (or a customer's address) to a third party.
 *
 * Three rules make the funnel safe to put behind any code path:
 *
 * 1. **It never throws and never adds latency the caller can see.** `report()`
 *    resolves on every path, so callers write `void report(...)`; a failure to
 *    *record* a failure is logged, never propagated — the boundary's 500 must
 *    not become a 500 about the 500.
 * 2. **A crash loop cannot fill the database.** Reports of the same
 *    `source|kind|message|route` inside `REPEAT_WINDOW_MS` collapse into one row
 *    carrying `occurrences`, a process-wide ceiling bounds writes per minute, and
 *    `MAX_CONSECUTIVE_FAILURES` sink failures open a breaker for
 *    `BREAKER_OPEN_MS`. Suppression is announced in the console, never silent.
 * 3. **A process that is not the deployment does not write.** See
 *    `errorSinkEnabled()`: a test run whose `DATABASE_URL` is whatever the shell
 *    held (on this repository, production) must not file fabricated incidents,
 *    because a fabricated row is afterwards indistinguishable from a real one.
 */
import { createHash } from "node:crypto";
import { ERROR_REPORT_LIMITS, cap, capFields } from "./errorLimits";
import { appEnv, deploymentId, describeError, logInfo, logWarn, type LogFields } from "./log";

// Re-exported from `./errorLimits` so the write route and the tests keep one
// import site; the module itself is browser-safe (see its header).
export { ERROR_REPORT_LIMITS, capFields };

export const ERROR_SOURCES = ["api", "server", "client", "process"] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

/** The same fingerprint inside this window is the same incident. */
export const REPEAT_WINDOW_MS = 60_000;
/** Hard ceiling on rows this process may write per window, across fingerprints. */
export const MAX_WRITES_PER_WINDOW = 30;
export const WRITE_WINDOW_MS = 60_000;
/** Consecutive sink failures before the funnel stops trying. */
export const MAX_CONSECUTIVE_FAILURES = 3;
export const BREAKER_OPEN_MS = 5 * 60_000;
/** Fingerprints tracked at once; expired ones are dropped before this is hit. */
const MAX_TRACKED_FINGERPRINTS = 512;

export type ErrorReportFields = {
  source: string;
  message: string;
  kind?: unknown;
  route?: unknown;
  digest?: unknown;
  stack?: unknown;
  requestId?: unknown;
  deploy?: unknown;
  env?: unknown;
};

/** A row as it is written: normalized, capped, with the deploy stamps attached. */
export type ErrorReportRow = {
  source: ErrorSource;
  kind: string | null;
  message: string;
  stack: string | null;
  route: string | null;
  digest: string | null;
  fingerprint: string;
  occurrences: number;
  deploy: string | null;
  env: string | null;
  requestId: string | null;
};

export type ErrorReportReason =
  | "invalid"
  | "disabled"
  | "suppressed"
  | "throttled"
  | "breaker-open"
  | "sink-failed";

export type ErrorReportResult = {
  recorded: boolean;
  reason?: ErrorReportReason;
  fingerprint?: string;
  occurrences?: number;
};

/** Where rows go. Asked per report, so the answer can follow the environment. */
export type ErrorReportSink = (row: ErrorReportRow) => Promise<void>;
export type ErrorReportSinkFactory = () => ErrorReportSink | null;

/**
 * Whether this process may persist an error row.
 *
 * A row is only worth what its database is worth, and a process that is *not*
 * the deployment must not write into whatever `DATABASE_URL` the shell happened
 * to hold — on this repository that value is production, so a stray test run
 * would fill the incident table with fabricated incidents. The rule mirrors the
 * guard `lib/testDb.ts` already applies to destructive tests: under `VITEST`,
 * only a loopback database (or the explicit `VITEST_ALLOW_REMOTE_DB=1` opt-in
 * for an ephemeral preview branch) is writable; anywhere else is a deployment
 * writing to its own database, which is the point.
 */
export function errorSinkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.VITEST) return true;
  const url = env.DATABASE_URL ?? "";
  return url.length > 0 && (/(localhost|127\.0\.0\.1)/.test(url) || env.VITEST_ALLOW_REMOTE_DB === "1");
}

/** `source|kind|message|route`, hashed so the stored index stays small. */
export function fingerprintOf(parts: Pick<ErrorReportRow, "source" | "kind" | "message" | "route">): string {
  return createHash("sha256")
    .update([parts.source, parts.kind ?? "", parts.message, parts.route ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

export function normalizeErrorReport(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env
): { ok: true; row: ErrorReportRow } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "body must be a JSON object" };
  }
  const f = raw as ErrorReportFields;
  const source = typeof f.source === "string" ? f.source.trim() : "";
  if (!(ERROR_SOURCES as readonly string[]).includes(source)) {
    return { ok: false, reason: `source must be one of ${ERROR_SOURCES.join(", ")}` };
  }
  const message = cap(f.message, ERROR_REPORT_LIMITS.message);
  if (!message) return { ok: false, reason: "message is required" };

  const base = {
    source: source as ErrorSource,
    kind: cap(f.kind, ERROR_REPORT_LIMITS.kind),
    message,
    route: cap(f.route, ERROR_REPORT_LIMITS.route),
    stack: cap(f.stack, ERROR_REPORT_LIMITS.stack),
    digest: cap(f.digest, ERROR_REPORT_LIMITS.digest),
    requestId: cap(f.requestId, ERROR_REPORT_LIMITS.requestId),
    // A reporter inside the deployment may state these; a public one must not be
    // able to claim a deployment it is not part of, so a missing stamp is filled
    // from this process's own environment.
    deploy: cap(f.deploy, ERROR_REPORT_LIMITS.deploy) ?? deploymentId(env),
    env: cap(f.env, ERROR_REPORT_LIMITS.env) ?? appEnv(env),
  };
  return { ok: true, row: { ...base, fingerprint: fingerprintOf(base), occurrences: 1 } };
}

export type ErrorReporter = {
  report(input: unknown): Promise<ErrorReportResult>;
  /** Counters for tests, and for the "is the funnel itself healthy" question. */
  stats(): { tracked: number; writes: number; suppressed: number; dropped: number };
};

export function createErrorReporter(opts: {
  sink: ErrorReportSinkFactory;
  now?: () => number;
}): ErrorReporter {
  const now = opts.now ?? (() => Date.now());

  const seen = new Map<string, { lastRowAt: number; sinceRow: number }>();
  let writes: number[] = [];
  let failures = 0;
  let breakerUntil = 0;
  let suppressed = 0;
  let dropped = 0;

  function pruneWindow(at: number): void {
    writes = writes.filter((t) => at - t < WRITE_WINDOW_MS);
    if (seen.size <= MAX_TRACKED_FINGERPRINTS) return;
    for (const [key, entry] of seen) {
      if (at - entry.lastRowAt >= REPEAT_WINDOW_MS) seen.delete(key);
      if (seen.size <= MAX_TRACKED_FINGERPRINTS) break;
    }
  }

  async function report(input: unknown): Promise<ErrorReportResult> {
    try {
      const normalized = normalizeErrorReport(input);
      if (!normalized.ok) return { recorded: false, reason: "invalid" };
      const row = normalized.row;
      const at = now();

      const previous = seen.get(row.fingerprint);
      if (previous && at - previous.lastRowAt < REPEAT_WINDOW_MS) {
        previous.sinceRow += 1;
        suppressed += 1;
        // One line per burst, not per report: together with the row above it,
        // this is what tells "one crash" apart from "a crash loop".
        if (previous.sinceRow === 1) {
          logInfo("errors", "repeat-suppressed", {
            ...describeRow(row),
            occurrences: previous.sinceRow + 1,
            windowMs: REPEAT_WINDOW_MS,
          });
        }
        return { recorded: false, reason: "suppressed", fingerprint: row.fingerprint };
      }

      pruneWindow(at);
      const sink = opts.sink();
      if (!sink) return { recorded: false, reason: "disabled", fingerprint: row.fingerprint };
      if (at < breakerUntil) {
        dropped += 1;
        return { recorded: false, reason: "breaker-open", fingerprint: row.fingerprint };
      }
      if (writes.length >= MAX_WRITES_PER_WINDOW) {
        dropped += 1;
        logWarn("errors", "write-throttled", {
          fingerprint: row.fingerprint,
          windowMs: WRITE_WINDOW_MS,
          limit: MAX_WRITES_PER_WINDOW,
        });
        return { recorded: false, reason: "throttled", fingerprint: row.fingerprint };
      }

      // `occurrences` counts every time this fingerprint was seen since the last
      // row was written: the suppressed bursts are the number that says "and it
      // is still happening".
      const full: ErrorReportRow = { ...row, occurrences: (previous?.sinceRow ?? 0) + 1 };
      try {
        await sink(full);
      } catch (err) {
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          breakerUntil = now() + BREAKER_OPEN_MS;
          failures = 0;
          logWarn("errors", "sink-open-circuit", {
            fingerprint: row.fingerprint,
            openMs: BREAKER_OPEN_MS,
            error: describeError(err),
          });
        } else {
          logWarn("errors", "sink-failed", {
            fingerprint: row.fingerprint,
            error: describeError(err),
          });
        }
        return { recorded: false, reason: "sink-failed", fingerprint: row.fingerprint };
      }

      failures = 0;
      writes.push(at);
      seen.set(row.fingerprint, { lastRowAt: at, sinceRow: 0 });
      return { recorded: true, fingerprint: row.fingerprint, occurrences: full.occurrences };
    } catch (err) {
      // The funnel may not be the reason a request fails.
      logWarn("errors", "sink-unexpected", { error: describeError(err) });
      return { recorded: false, reason: "sink-failed" };
    }
  }

  return {
    report,
    stats: () => ({ tracked: seen.size, writes: writes.length, suppressed, dropped }),
  };
}

function describeRow(row: ErrorReportRow): LogFields {
  return {
    fingerprint: row.fingerprint,
    source: row.source,
    kind: row.kind ?? undefined,
    route: row.route ?? undefined,
    message: row.message,
  };
}

/**
 * The production sink.
 *
 * `lib/prisma` is imported lazily, and only once a report is actually about to
 * be written: the boundary imports this module, and pulling the database client
 * into its graph would make every route that merely wants a JSON helper open a
 * pool. The import also sits behind `errorSinkEnabled()`, so a test process with
 * no test database never loads it at all.
 */
let prismaModule: Promise<typeof import("./prisma")> | null = null;

export const prismaSink: ErrorReportSink = async (row) => {
  prismaModule ??= import("./prisma");
  const { prisma } = await prismaModule;
  await prisma.errorReport.create({
    data: {
      source: row.source,
      kind: row.kind,
      message: row.message,
      stack: row.stack,
      route: row.route,
      digest: row.digest,
      fingerprint: row.fingerprint,
      occurrences: row.occurrences,
      deploy: row.deploy,
      env: row.env,
      requestId: row.requestId,
    },
  });
};

/** The process-wide funnel: its suppression window and breaker are shared. */
export const errorReporter = createErrorReporter({
  sink: () => (errorSinkEnabled() ? prismaSink : null),
});

/**
 * Record one error. Never rejects; `void reportError(...)` is the expected call
 * site everywhere except the write route itself.
 */
export const reportError = errorReporter.report;

/** Server-side helper: report a caught value with the deploy stamps attached. */
export async function reportCaught(
  source: ErrorSource,
  err: unknown,
  fields: { kind?: string; route?: string; requestId?: string | null } = {}
): Promise<ErrorReportResult> {
  return reportError({
    source,
    kind: fields.kind,
    route: fields.route,
    requestId: fields.requestId ?? undefined,
    message: describeError(err),
    stack: err instanceof Error ? err.stack : describeError(err),
  });
}
