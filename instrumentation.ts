/**
 * Server start hook (Phase 18, R18-1, R18-10, R18-11).
 *
 * The review's census recorded this file's absence: "no server-side
 * `instrumentation.ts` hook" (`18` §3.1, §5.1). What it buys is small and
 * specific — one boot line per process saying which deploy and which environment
 * is serving, and a durable report when the runtime itself dies — and it is
 * deliberately the *last* place a failure is caught rather than the first: a route
 * throw belongs to the boundary (`lib/route.ts`), a render throw to
 * `app/error.tsx`, and only a crash that reached the Node process arrives here.
 *
 * **The handlers restore Node's own behaviour instead of replacing it.** A
 * listener on `uncaughtException` suppresses Node's default (print the stack, exit
 * non-zero), so installing one naively converts "the server died" into "the server
 * is still accepting connections in an undefined state" — a worse incident than
 * the one this phase exists to make visible. So the handler reports, then removes
 * itself and rethrows on the next tick: with our listener gone the throw reaches
 * exactly the path it would have reached without us. A second arrival finds the
 * guard set and returns immediately, so this cannot loop. The report is given
 * `CRASH_REPORT_DEADLINE_MS` and no more: the process is already dying and the
 * platform is already logging the crash, and waiting indefinitely on a database
 * write would turn a fast restart into a hung one.
 */
import { describeError, logError, logInfo } from "./lib/log";
import { reportCaught } from "./lib/errorReport";

/** Long enough to be worth attempting, short enough not to hold up a restart. */
const CRASH_REPORT_DEADLINE_MS = 750;

let crashKind: CrashKind | undefined;
const installed: { uncaughtException?: (err: unknown) => void; unhandledRejection?: (reason: unknown) => void } = {};

export type CrashKind = "uncaughtException" | "unhandledRejection";

export async function register(): Promise<void> {
  // The edge runtime has no `process.on` and no database client; `lib/log.ts`
  // itself is runtime-agnostic, so the boot line is emitted either way.
  const runtime = process.env.NEXT_RUNTIME ?? "nodejs";
  logInfo("process", "boot", { runtime, node: process.version });
  if (runtime !== "nodejs") return;

  installed.uncaughtException = (err: unknown) => {
    void reportCrashAndRestore("uncaughtException", err);
  };
  installed.unhandledRejection = (reason: unknown) => {
    void reportCrashAndRestore("unhandledRejection", reason);
  };
  process.on("uncaughtException", installed.uncaughtException);
  process.on("unhandledRejection", installed.unhandledRejection);
}

/**
 * Log, report, then hand the crash back to the runtime. Exported for the test
 * that asserts the restore path — the half that must not be got wrong, because
 * getting it wrong is invisible until the night it matters.
 */
export async function reportCrashAndRestore(kind: CrashKind, err: unknown): Promise<void> {
  if (crashKind) return;
  crashKind = kind;

  const detail = {
    kind,
    error: describeError(err),
    stack: err instanceof Error ? err.stack?.slice(0, 2_000) : undefined,
  };
  logError("process", kind === "uncaughtException" ? "uncaught-exception" : "unhandled-rejection", detail);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), CRASH_REPORT_DEADLINE_MS);
    });
    await Promise.race([reportCaught("process", err, { kind }), deadline]);
  } catch {
    // `reportCaught` is total; this is belt and braces on the one path where an
    // exception would take the exit code with it.
  } finally {
    if (timer) clearTimeout(timer);
  }

  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    const listener = installed[event];
    if (listener) process.removeListener(event, listener);
  }
  // Cleared before the rethrow: if something else in the process swallows it and
  // the server keeps running, the next crash is reported rather than silently
  // treated as "already handled".
  crashKind = undefined;
  setImmediate(() => {
    throw err;
  });
}
