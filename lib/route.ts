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
 * with `date` frozen — the edge does honour the 10 s window. It also rewrites
 * the browser-facing directive to `public, max-age=0, must-revalidate`, so no
 * browser is ever promised a stale copy. Mirroring the same policy in
 * `Vercel-CDN-Cache-Control` states the CDN half explicitly, so editing the
 * client directive later cannot silently drop the edge window.
 */
export const READ_CACHE = {
  "Cache-Control": "s-maxage=10, stale-while-revalidate=30",
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
 * Wrap a handler in the boundary contract: reuse the platform's request id when
 * one arrived, answer an uncaught throw as a JSON 500 (or a 503 when the throw
 * is the database being unreachable — "our dependency is down" and "we have a
 * bug" are different pages for an operator), and hand every refusal through
 * `enforceContract`.
 *
 * `apiRoute()` already wraps what it exports; this is exported for the tests
 * that exercise the boundary without a route file.
 */
export function withContract(handler: ApiHandler): ApiHandler {
  const wrapped = async (...args: unknown[]): Promise<Response> => {
    const id = inboundRequestId(args[0]) ?? requestId();
    try {
      return await enforceContract(await handler(...args), id);
    } catch (err) {
      const connectivity = isConnectivityFailure(err);
      const status = connectivity ? 503 : 500;
      const code = connectivity ? "DB_UNAVAILABLE" : "INTERNAL";
      // The log line pairs with the header a caller sees — the whole point of
      // the request id is that support can find this line from either end.
      console.error(`[api] ${id} ${status} ${code}:`, err instanceof Error ? `${err.name}: ${err.message}` : err);
      return NextResponse.json(
        { error: messageForStatus(status), code },
        { status, headers: { "x-request-id": id } }
      );
    }
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
