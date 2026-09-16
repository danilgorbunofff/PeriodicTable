/**
 * API route helpers (Phase 4): every JSON response carries a request id for
 * log correlation, and errors use the shared {error, code} shape the client
 * fetchJson parses into ApiError.
 *
 * Phase 11 (R11-3) added the *boundary* below: `apiRoute()` is the one export a
 * route file needs, and it makes the two failure shapes the review actually
 * measured — a bare 405 and a zero-length 500 — impossible to reach a client.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { describeError, logError, logInfo, withRequestScope } from "./log";
import { reportCaught } from "./errorReport";

export function requestId(): string {
  try {
    return randomUUID();
  } catch {
    return `req-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/**
 * Short shared caching for the read APIs that may be a few seconds stale
 * (R03-3). One declaration instead of a copied string per route.
 *
 * The live probe (2026-09-14, production): three requests 2 s apart to
 * `/api/elements` came back `x-vercel-cache: MISS` then `HIT`, `age: 0/2/4`,
 * with `date` frozen — the edge does honour the 10 s window. Mirroring the same
 * policy in `Vercel-CDN-Cache-Control` states the CDN half explicitly, so
 * editing the client directive later cannot silently drop the edge window.
 *
 * R15-1 (2026-09-16): the browser-facing directive used to be whatever the
 * edge rewrote it to (`public, max-age=0, must-revalidate`), so a repeat view
 * or a remount always cost a round trip. It now carries a window of its own —
 * `max-age=5`, deliberately *below* the 30 s `refreshInterval` every consumer
 * of these routes polls at (`app/page.tsx`, `components/TerritoryView.tsx`,
 * `components/WorldOrder.tsx`, `components/ActivityCard.tsx`). That is the
 * whole safety argument: a cache entry can never outlive the poll that would
 * have replaced it, so the live numbers keep their cadence while a burst of
 * mounts (modal open + territory view, a reload, a back-navigation) is
 * answered without a request. `lib/readCache.test.ts` asserts the inequality
 * against the client's own literal, so raising this number past the poll
 * interval fails the suite rather than the board.
 */
export const READ_CACHE = {
  "Cache-Control": "public, max-age=5, s-maxage=10, stale-while-revalidate=30",
  "Vercel-CDN-Cache-Control": "s-maxage=10, stale-while-revalidate=30",
} as const;

export function apiJson<T>(data: T, init?: ResponseInit & { code?: string }): NextResponse {
  const id = requestId();
  const res = NextResponse.json(data, init);
  res.headers.set("x-request-id", id);
  return res;
}

export function apiError(message: string, opts: { status?: number; code?: string } = {}): NextResponse {
  const { status = 400, code = "BAD_REQUEST" } = opts;
  const res = NextResponse.json({ error: message, code }, { status });
  res.headers.set("x-request-id", requestId());
  return res;
}

/* ------------------------------------------------------------------ *
 * Route boundary (Phase 11, R11-3)
 * ------------------------------------------------------------------ */

/**
 * A route handler of any arity: `(...args)` because Next hands a dynamic route
 * a second `{ params }` argument and a static one does not.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApiHandler = (...args: any[]) => Response | Promise<Response>;

/** The verbs a route file exports. HEAD is served by GET (Next does that for
 *  every route module) and so is never exported by hand. */
const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Verb = (typeof VERBS)[number];
type RouteExports = Verb | "OPTIONS";

const STATUS_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "UNPROCESSABLE_ENTITY",
  429: "RATE_LIMITED",
  500: "INTERNAL",
  502: "BAD_GATEWAY",
  503: "UNAVAILABLE",
  504: "GATEWAY_TIMEOUT",
};

/** The machine-readable code for a status that arrived without one. */
export function codeForStatus(status: number): string {
  return STATUS_CODES[status] ?? (status >= 500 ? "INTERNAL" : "BAD_REQUEST");
}

const STATUS_MESSAGES: Record<number, string> = {
  400: "Bad request.",
  401: "Unauthorized.",
  403: "Forbidden.",
  404: "Not found.",
  405: "Method not allowed.",
  409: "Conflict.",
  413: "Payload too large.",
  415: "Unsupported media type.",
  429: "Too many requests. Try again later.",
  500: "Internal error.",
  502: "Upstream provider failed.",
  503: "Service unavailable.",
  504: "Upstream timeout.",
};

function messageForStatus(status: number): string {
  return STATUS_MESSAGES[status] ?? `Request failed (${status}).`;
}

/** Prisma reports a dead pool or an unreachable host as one of these; a Node
 *  errno may arrive instead when the failure happens before Prisma wraps it. */
const CONNECTIVITY = new Set([
  "P1000",
  "P1001",
  "P1002",
  "P1003",
  "P1008",
  "P1010",
  "P1017",
  "P2024",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
]);

function isConnectivityFailure(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 3) return false;
  const { name, code, cause } = err as { name?: unknown; code?: unknown; cause?: unknown };
  if (name === "PrismaClientInitializationError" || name === "PrismaClientRustPanicError") return true;
  if (typeof code === "string" && CONNECTIVITY.has(code)) return true;
  return isConnectivityFailure(cause, depth + 1);
}

function inboundRequestId(arg: unknown): string | null {
  if (!arg || typeof arg !== "object") return null;
  const headers = (arg as { headers?: { get?: (name: string) => string | null } }).headers;
  const value = headers?.get?.("x-request-id");
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 128) : null;
}

function withRequestId(res: Response, id: string): Response {
  if (res.headers.get("x-request-id") !== id) res.headers.set("x-request-id", id);
  return res;
}

/** Rebuild a response with a JSON body, keeping its status and headers. */
function jsonBody(res: Response, body: unknown, id: string): Response {
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-request-id", id);
  return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers });
}

/**
 * Apply the one-refusal grammar the review asked for: every error carries a
 * `code` and an `x-request-id`. A body a route already wrote is kept and only
 * gains a code when it lacks one; a refusal with no body at all (the framework's
 * 405, an uncaught throw) becomes `{error, code}` with a message derived from
 * the status. An error *page* (HTML, a plain-text proxy error) is left as it
 * came back — rewriting a body that is not ours to describe would hide the
 * useful half of it.
 */
async function enforceContract(res: Response, id: string): Promise<Response> {
  withRequestId(res, id);
  if (res.status < 400) return res;

  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await res.clone().json().catch(() => null)) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      if (typeof (body as { code?: unknown }).code === "string") return res;
      return jsonBody(res, { ...(body as Record<string, unknown>), code: codeForStatus(res.status) }, id);
    }
    return jsonBody(res, { error: messageForStatus(res.status), code: codeForStatus(res.status) }, id);
  }

  const text = await res.clone().text().catch(() => "");
  if (text.trim() !== "") return res;
  return jsonBody(res, { error: messageForStatus(res.status), code: codeForStatus(res.status) }, id);
}

/**
 * The path a request was for, without the query string. Query strings on this
 * site carry secrets (`?token=`, `?me=`), and the path is the part that pairs
 * with a route file in a grep (R15-11).
 */
function requestPath(req: unknown): string {
  const url = (req as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string") return "-";
  try {
    return new URL(url).pathname;
  } catch {
    return "-";
  }
}

/**
 * One line per origin invocation (R15-11). Before this, nothing in the product
 * measured itself: no route reported its own duration, and the log for a total
 * database outage had no request id and no path (doc 15 §5.10), so an operator
 * could not tell a slow route from a fast one or attribute a spike to a path.
 * The CDN absorbs most reads, so these lines are the origin's own traffic — the
 * cheapest honest version of "invocations, and how long each took". Deliberately
 * not a counter store: a counter table would put write load on every read to
 * answer a question the log already answers.
 *
 * R18-11 moved this line onto `lib/log.ts`, which adds the level, the message,
 * the environment and the deployment to every shape the product emits — the
 * field the review asked for by name ("search a log window for a `paymentId` and
 * try to attribute the lines to a deployment: impossible").
 */
function logInvocation(
  id: string,
  req: unknown,
  status: number,
  startedAt: number
): void {
  const method = (req as { method?: unknown } | undefined)?.method;
  logInfo("api", "invocation", {
    requestId: id,
    method: typeof method === "string" ? method : "-",
    path: requestPath(req),
    status,
    ms: Date.now() - startedAt,
  });
}

/**
 * Wrap a handler in the boundary contract: reuse the platform's request id when
 * one arrived, answer an uncaught throw as a JSON 500 (or a 503 when the throw
 * is the database being unreachable — "our dependency is down" and "we have a
 * bug" are different pages for an operator), and hand every refusal through
 * `enforceContract`.
 *
 * R18-10/R18-11: the whole invocation runs inside `withRequestScope`, so every
 * structured line a handler writes — several frames down, in a lib that never
 * sees a request — carries the same request id as the response header, and the
 * throw is filed with the error sink (`lib/errorReport.ts`) rather than only
 * being printed. The sink call is deliberately not awaited: recording a failure
 * must not add a failure mode to the request that is already failing.
 *
 * `apiRoute()` already wraps what it exports; this is exported for the tests
 * that exercise the boundary without a route file.
 */
export function withContract(handler: ApiHandler): ApiHandler {
  const wrapped = async (...args: unknown[]): Promise<Response> => {
    const id = inboundRequestId(args[0]) ?? requestId();
    const startedAt = Date.now();
    return withRequestScope(id, async () => {
      try {
        const res = await enforceContract(await handler(...args), id);
        logInvocation(id, args[0], res.status, startedAt);
        return res;
      } catch (err) {
        const connectivity = isConnectivityFailure(err);
        const status = connectivity ? 503 : 500;
        const code = connectivity ? "DB_UNAVAILABLE" : "INTERNAL";
        // The log line pairs with the header a caller sees — the whole point of
        // the request id is that support can find this line from either end.
        // `error` level, not `warn`: this is the branch where the caller did not
        // get what they asked for and nobody downstream caught it, which is the
        // one level the review's threshold table lets page an operator.
        logError("api", connectivity ? "database-unreachable" : "unhandled", {
          requestId: id,
          status,
          code,
          error: describeError(err),
          method:
            typeof (args[0] as { method?: unknown } | undefined)?.method === "string"
              ? ((args[0] as { method: string }).method)
              : "-",
          path: requestPath(args[0]),
        });
        void reportCaught("api", err, { kind: code, route: requestPath(args[0]), requestId: id });
        logInvocation(id, args[0], status, startedAt);
        return NextResponse.json(
          { error: messageForStatus(status), code },
          { status, headers: { "x-request-id": id } }
        );
      }
    });
  };
  return wrapped as ApiHandler;
}

function notAllowed(allow: string): ApiHandler {
  return () => {
    const res = apiError(`Method not allowed. Allowed: ${allow}.`, { status: 405, code: "METHOD_NOT_ALLOWED" });
    res.headers.set("Allow", allow);
    return res;
  };
}

function allowedOptions(allow: string): ApiHandler {
  return (req?: NextRequest) => {
    const res = new NextResponse(null, { status: 204 });
    res.headers.set("Allow", allow);
    res.headers.set("x-request-id", inboundRequestId(req) ?? requestId());
    return res;
  };
}

/**
 * The route boundary (R11-3). One call per route file:
 *
 * ```ts
 * export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: listBoard });
 * ```
 *
 * Every exported handler is wrapped, and the verbs the file does not implement
 * are filled in: 405 with `{error, code}` and an `Allow` header, and an
 * `OPTIONS` that answers 204 with the same list. Before this, a wrong method was
 * answered by the framework with a zero-length body and no `Allow` at all, so a
 * client could not discover the method, and a route that threw produced a 500 no
 * caller could correlate with a log line.
 */
export function apiRoute(handlers: Partial<Record<Verb, ApiHandler>>): Record<RouteExports, ApiHandler> {
  const implemented = VERBS.filter((verb) => typeof handlers[verb] === "function");
  // HEAD is served by GET, so it belongs immediately after it in the list.
  const allow = [
    ...(implemented.includes("GET") ? ["GET", "HEAD"] : []),
    ...implemented.filter((verb) => verb !== "GET"),
    "OPTIONS",
  ].join(", ");
  const out = {} as Record<RouteExports, ApiHandler>;
  for (const verb of VERBS) out[verb] = withContract(handlers[verb] ?? notAllowed(allow));
  out.OPTIONS = withContract(allowedOptions(allow));
  return out;
}
