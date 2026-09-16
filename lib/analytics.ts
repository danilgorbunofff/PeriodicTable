/** Analytics (Phase 5, spec 01-seed-instrument.md; gate R18-13).
 *
 * Plausible pageviews plus the seven funnel events below. Nothing here sends
 * anything unless the deployment configured a domain AND this browser granted
 * consent (`lib/analyticsConsent.ts`): the layout used to serve the script
 * directly off the env var, so one variable both configured the vendor and
 * collected from every visitor (doc 18 §3.9, §5.6).
 *
 * Two gates rather than one because they fail differently. The script is only
 * injected after a grant, which keeps the request from being made at all; this
 * check keeps a *stale* global honest — a `window.plausible` left behind by an
 * earlier grant, a decline in another tab, or a hand-injected script must not
 * turn the funnel events into a second, ungated collection path.
 *
 * No-op locally so dev/E2E never throws.
 */
import { analyticsAllowed } from "./analyticsConsent";

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
    if (!analyticsAllowed()) return;
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
