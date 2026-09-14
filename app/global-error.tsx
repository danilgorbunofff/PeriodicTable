"use client";
import { useEffect } from "react";
import { GLOBAL_ERROR } from "../lib/boundaries";
import { BoundaryNotice } from "../lib/boundaryChrome";
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
    console.error("[global error]", error);
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
