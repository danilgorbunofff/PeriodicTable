/**
 * Structured log lines and the level rule (Phase 18, R18-11).
 *
 * Before this, the product wrote 23 runtime log lines in three different shapes:
 * three JSON objects (`{scope:"settle"|"txn"|"og"|"jobs"|"api"}`) and the rest
 * free text with a `[tag]` prefix. None of them carried the deployment or the
 * environment, so a log window could not answer the first question an incident
 * asks — *which build said this?* — and a line about a payment could not be tied
 * to the request that caused it.
 *
 * Two things fix that without threading an argument through every call:
 *
 *  - **The deployment fields are added here**, from the platform's own
 *    variables (`VERCEL_GIT_COMMIT_SHA`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_ENV`),
 *    with a `dev` fallback, so every line written through this module says which
 *    build and which environment produced it.
 *  - **The request id is ambient.** `withRequestScope()` wraps a route
 *    invocation (lib/route.ts does, for every route), and every line written
 *    inside it carries that id — including lines written several frames down in
 *    lib/settle.ts or lib/outbox.ts, which have no request object to consult.
 *    A line written outside any request (a job worker, a script) simply has no
 *    `requestId`, which is honest: there is no request.
 *
 * **The level rule**, which is the part a reader needs to trust a filter:
 * a failure the caller *survived* — a mail that did not go out, a preview that
 * did not render, an audit row that could not be written — logs at `warn`,
 * because the outcome the user saw was still correct and the work is retried by
 * something else. A failure that *changed the outcome* — a rejected delivery, a
 * payment that could not be applied, an unhandled route error — logs at
 * `error`. `info` is for things that happened as designed. Only `error` is worth
 * paging on, which is why nothing that merely degraded may use it.
 *
 * Server-only: `node:async_hooks` is not available in the browser, and no client
 * component may import this module (the two error boundaries report to
 * `/api/internal/error` instead — see lib/errorReport.ts).
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "info" | "warn" | "error";

/** Extra fields are values, never objects with cycles: `describeError()` exists
 *  for that. A field whose value is `undefined` is dropped rather than rendered
 *  as `null`, so "absent" and "present and null" stay distinguishable. */
export type LogFields = Record<string, unknown>;

const requestScope = new AsyncLocalStorage<string>();

/** Run `fn` with `id` as the ambient request id for every line written inside. */
export function withRequestScope<T>(id: string, fn: () => T): T {
  return requestScope.run(id, fn);
}

/** The id of the request this line belongs to, or undefined outside a request. */
export function currentRequestId(): string | undefined {
  return requestScope.getStore();
}

/**
 * Which build produced this line. Vercel exposes the commit sha and a deployment
 * id; a local run has neither, and `dev` is the honest answer there — an empty
 * string would render as a missing field and read like a bug in the logger.
 */
export function deploymentId(env: NodeJS.ProcessEnv = process.env): string {
  const sha = env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (sha) return sha.slice(0, 12);
  const deployment = env.VERCEL_DEPLOYMENT_ID?.trim();
  if (deployment) return deployment.slice(0, 24);
  const build = env.NEXT_PUBLIC_BUILD_ID?.trim();
  return build ? build.slice(0, 24) : "dev";
}

/** The environment a line came from: `production`, `preview`, `development`. */
export function appEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.VERCEL_ENV?.trim() || env.NODE_ENV || "unknown";
}

/** Error-shaped value for a log field: the name and message, nothing else (a
 *  stack in a log line is 20 lines of noise around the one line that matters,
 *  and every sink already records the stack for uncaught errors). */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** One line, always. JSON.stringify can throw on a caller-supplied value (a
 *  cycle, a BigInt), and a logger that throws is worse than no logger: the
 *  failure it was reporting is lost with it. */
function emit(level: LogLevel, line: Record<string, unknown>): void {
  let text: string;
  try {
    text = JSON.stringify(line);
  } catch {
    text = JSON.stringify({
      level,
      scope: line.scope,
      msg: line.msg,
      unserializable: true,
    });
  }
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export function logLine(
  level: LogLevel,
  scope: string,
  msg: string,
  fields: LogFields = {},
): void {
  const line: Record<string, unknown> = {
    level,
    scope,
    msg,
    env: appEnv(),
    deploy: deploymentId(),
  };
  const requestId = requestScope.getStore();
  if (requestId) line.requestId = requestId;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) line[key] = value;
  }
  emit(level, line);
}

/** Something happened as designed. */
export function logInfo(scope: string, msg: string, fields?: LogFields): void {
  logLine("info", scope, msg, fields);
}

/** Something degraded and the product carried on — see the level rule above. */
export function logWarn(scope: string, msg: string, fields?: LogFields): void {
  logLine("warn", scope, msg, fields);
}

/** Something changed the outcome. This is the level a pager may use. */
export function logError(scope: string, msg: string, fields?: LogFields): void {
  logLine("error", scope, msg, fields);
}

/**
 * A non-blocking failure, in one call: the level rule's `warn` arm with the
 * error flattened so a `catch (e) { ... }` needs no shape of its own.
 */
export function logFailure(
  scope: string,
  msg: string,
  err: unknown,
  fields?: LogFields,
): void {
  logWarn(scope, msg, { ...fields, error: describeError(err) });
}
