"use client";
import { useEffect } from "react";
import { GLOBAL_ERROR } from "../lib/boundaries";
import { BoundaryNotice } from "../lib/boundaryChrome";
import { reportClientError } from "../lib/clientError";
// The root layout is exactly what failed in this path, so this file is the only
// place left that can pull the stylesheet in.
import "./globals.css";

/**
 * Root error boundary (R02-3): the failure the route boundary cannot catch —
 * anything thrown in the root layout itself. It replaces the layout, so it has
 * to render its own `<html>` and `<body>`, and it may not assume either exists.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // The root layout failed, so this is the one boundary with no page around it:
    // the report is the only record that survives the user's session.
    console.error("[global error]", error);
    reportClientError("client", error, {
      digest: error.digest,
      kind: "GlobalError",
      route: typeof window === "undefined" ? undefined : window.location.pathname,
    });
  }, [error]);

  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <BoundaryNotice
          eyebrow={GLOBAL_ERROR.eyebrow}
          heading={GLOBAL_ERROR.heading}
          body={GLOBAL_ERROR.body}
          onRetry={reset}
          retryLabel={GLOBAL_ERROR.retry}
        />
      </body>
    </html>
  );
}
