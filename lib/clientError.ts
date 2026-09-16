/**
 * Browser-side error reporting (Phase 18, R18-1, R18-10).
 *
 * The review's picture of "error tracking" at the time: it did not exist. A
 * render that threw was caught by the boundary (`app/error.tsx`, R02-3), shown
 * to the user as a polite notice, and written to `console.error` — a console
 * nobody was reading. The only place a client-side failure could surface was a
 * support email that described it from memory. So: no count of how often the
 * boundary fired, no stack, no route, nothing to correlate with a deploy.
 *
 * This is the browser half of the sink in `lib/errorReport.ts`. It is
 * deliberately the dumbest possible client: shape a small payload, POST it once,
 * and never let reporting change what the user sees. Three rules make that safe:
 *
 *  · **Never throw, never retry, never block.** A transport failure is dropped
 *    (`ok: false`). An error reporter that can itself break the page is a new
 *    incident, not less of one — and a retry loop during a client-side failure
 *    storm is precisely when the browser can least afford it.
 *  · **One POST per distinct failure per page load.** A component that throws on
 *    every render produces hundreds of identical reports; a `Set` of fingerprint
 *    keys, capped, collapses the burst before it leaves the browser. The server
 *    deduplicates and rate-limits too, on purpose: this is the cheap layer, not
 *    a trusted one.
 *  · **No query string, ever.** The route is `location.pathname` only, for the
 *    same reason `requestPath()` in `lib/route.ts` strips it — this site's query
 *    strings carry `?token=` (manage links), `?me=` and checkout params, and an
 *    error report is a record that gets kept for months and read by whoever is
 *    on call. Hashes are dropped with it; nothing here reconstructs the URL.
 */
import { ERROR_REPORT_LIMITS, capFields } from "./errorLimits";

export type ClientErrorSource = "client" | "process";

export type ClientErrorPayload = {
  source: ClientErrorSource;
  kind: string;
  message: string;
  route?: string;
  stack?: string;
  digest?: string;
};

/** Enough to tell a storm from a handful; beyond that they are the same story. */
const MAX_DISTINCT_PER_LOAD = 25;
const seen = new Set<string>();

/** `Error` and friends give a name and a stack; anything else is stringified. */
export function describeClientError(error: unknown): {
  kind: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      kind: error.name || "Error",
      message: error.message || error.name || "Error",
      stack: error.stack,
    };
  }
  if (typeof error === "string" && error) return { kind: "Error", message: error };
  if (error && typeof error === "object") {
    try {
      return { kind: "Error", message: JSON.stringify(error) };
    } catch {
      return { kind: "Error", message: "unserializable error" };
    }
  }
  return { kind: "Error", message: String(error) };
}

/** The current path without its query string or hash. */
function routeLabel(loc: { pathname?: string } | undefined): string | undefined {
  const pathname = loc?.pathname;
  return typeof pathname === "string" && pathname ? pathname : undefined;
}

/**
 * Build the payload for one failure. Split out from the send so the shape —
 * the field caps especially — is testable without a DOM.
 */
export type ClientErrorExtra = {
  digest?: string;
  kind?: string;
  message?: string;
  route?: string;
};

export function clientErrorPayload(
  source: ClientErrorSource,
  error: unknown,
  extra: ClientErrorExtra = {}
): ClientErrorPayload {
  const described = describeClientError(error);
  const payload: ClientErrorPayload = {
    source,
    kind: extra.kind ?? described.kind,
    message: extra.message ?? described.message,
    route: extra.route,
    stack: described.stack,
    digest: extra.digest,
  };
  // Same ceilings the server enforces, read from the same constants. Sending
  // more only wastes bytes on the way to being truncated, and an unbounded stack
  // from a bundled build can be a hundred kilobytes.
  return capFields(
    payload as unknown as Record<string, unknown>,
    ERROR_REPORT_LIMITS as unknown as Record<string, number>
  ) as unknown as ClientErrorPayload;
}

function isDuplicate(payload: ClientErrorPayload): boolean {
  const key = `${payload.source}|${payload.kind}|${payload.message}`;
  if (seen.has(key)) return true;
  if (seen.size >= MAX_DISTINCT_PER_LOAD) return true;
  seen.add(key);
  return false;
}

/**
 * Send one error report. Returns whether it left the browser; every path is
 * total, so a caller may fire this from a render or an unload handler.
 */
export function reportClientError(
  source: ClientErrorSource,
  error: unknown,
  extra: ClientErrorExtra = {}
): boolean {
  try {
    const payload = clientErrorPayload(source, error, extra);
    if (!payload.message || isDuplicate(payload)) return false;
    const body = JSON.stringify(payload);
    const nav = typeof navigator === "undefined" ? undefined : navigator;
    // `sendBeacon` survives the page being torn down (and is the one transport
    // that will not be cancelled by a navigation); `fetch` with `keepalive` is
    // the fallback for the browsers that lack it.
    if (nav && typeof nav.sendBeacon === "function") {
      return nav.sendBeacon("/api/internal/error", new Blob([body], { type: "application/json" }));
    }
    if (typeof fetch === "function") {
      void fetch("/api/internal/error", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** The slice of `window` the installer needs — a real one or a test double. */
export type WindowLike = {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  location?: { pathname?: string };
};

/**
 * Catch the two failures React's boundaries cannot: an error thrown outside the
 * render tree (a timer, an event handler, a third-party script) and a rejected
 * promise nobody handled. Installed once per page load from
 * `components/ClientErrorReporter.tsx`; returns its own uninstall.
 */
export function installClientErrorHandlers(win: WindowLike | undefined = typeof window === "undefined" ? undefined : window): () => void {
  if (!win) return () => {};

  const onError = (event: unknown) => {
    const ev = event as
      | { error?: unknown; message?: string; filename?: string; lineno?: number; colno?: number }
      | undefined;
    // Where the throw happened, for the cases where the script is cross-origin
    // and the browser hands us a masked "Script error." with no `error` object.
    const where =
      typeof ev?.filename === "string" && ev.filename
        ? `${ev.filename}${ev.lineno ? `:${ev.lineno}` : ""}${ev.colno ? `:${ev.colno}` : ""}`
        : undefined;
    reportClientError("client", ev?.error ?? ev?.message ?? "unknown error", {
      message: ev?.message || where,
      kind: describeClientError(ev?.error).kind,
      route: routeLabel(win.location),
    });
  };

  const onRejection = (event: unknown) => {
    const reason = (event as { reason?: unknown } | undefined)?.reason;
    // Still source `client`: "process" is the Node runtime's own crashes. A
    // rejected promise is a browser-side failure with its own shape, which is
    // what the kind is for.
    reportClientError("client", reason, {
      kind: "UnhandledRejection",
      route: routeLabel(win.location),
    });
  };

  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);
  return () => {
    win.removeEventListener("error", onError);
    win.removeEventListener("unhandledrejection", onRejection);
  };
}
