"use client";
import { useEffect } from "react";
import { ROUTE_ERROR } from "../lib/boundaries";
import { BoundaryNotice } from "../lib/boundaryChrome";
import { reportClientError } from "../lib/clientError";

/**
 * Route-level error boundary (R02-3).
 *
 * Without this file a thrown render fell through to Next's stock error page in
 * every segment, so a broken component looked like a broken site. It renders
 * inside the root layout, and `reset()` re-renders the segment — the retry does
 * not reload the document, so a failure caused by a stale in-memory value
 * clears (02 §6).
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // A server-thrown error arrives here with only a digest, and Next's own log
    // is on the server. Log whatever survived so the trace is in the console the
    // user is already looking at, and file it with the sink (R18-1) so the same
    // failure is countable and attributable to a deploy without a support email.
    console.error("[route error]", error);
    reportClientError("client", error, {
      digest: error.digest,
      kind: "RouteError",
      route: typeof window === "undefined" ? undefined : window.location.pathname,
    });
  }, [error]);

  return (
    <BoundaryNotice
      eyebrow={ROUTE_ERROR.eyebrow}
      heading={ROUTE_ERROR.heading}
      body={ROUTE_ERROR.body}
      onRetry={reset}
      retryLabel={ROUTE_ERROR.retry}
    />
  );
}
