/** Analytics (Phase 5, spec 01-seed-instrument.md).
 * Plausible pageviews (script tag in layout when NEXT_PUBLIC_PLAUSIBLE_DOMAIN set)
 * + custom funnel events. No-op locally so dev/E2E never throws.
 */
export const ANALYTICS_EVENTS = [
  "tile_click",
  "drawer_open",
  "search_submit",
  "checkout_start",
  "checkout_paid",
  "reclaim_click",
  "go_click",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export function track(event: AnalyticsEvent, props?: Record<string, string | number>): void {
  try {
    const w = window as unknown as {
      plausible?: (e: string, o?: { props?: Record<string, string | number> }) => void;
    };
    if (typeof w.plausible === "function") {
      w.plausible(event, props ? { props } : undefined);
    }
  } catch {
    // Analytics must never break the product.
  }
}
