import type { Metadata } from "next";
import { NOT_FOUND } from "../lib/boundaries";
import { BoundaryNotice } from "../lib/boundaryChrome";

/**
 * The 404 (R02-1, R02-2).
 *
 * Two shapes landed on Next's stock error page before this file existed: an
 * unmatched URL (`/zzz-not-a-page`, `/legal`) and `notFound()` from a route
 * (`/legal/nope`). The stock page carried no wordmark, no nav and no way back
 * into the product, and the `notFound()` shape rendered outside the app shell
 * entirely (`<html id="__next_error__">`). Both shapes now render this, inside
 * the root layout.
 */
export const metadata: Metadata = {
  title: "Page not found · periodictable.lol",
  description: "That address is not served here.",
  // The status code is already 404; this keeps the tag the stock page used to send.
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return <BoundaryNotice eyebrow={NOT_FOUND.eyebrow} heading={NOT_FOUND.heading} body={NOT_FOUND.body} />;
}
