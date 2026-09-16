"use client";
import { useEffect, useState } from "react";
import {
  ANALYTICS_CONSENT_KEY,
  ensureAnalyticsScript,
  readAnalyticsConsent,
  writeAnalyticsConsent,
  type AnalyticsConsentChoice,
} from "../lib/analyticsConsent";

/**
 * The analytics notice and gate (R18-13).
 *
 * Rendered from the root layout only when the deployment has configured an
 * analytics domain, so an unconfigured deployment — which is production today —
 * serves no banner, no script and no third-party request, exactly as the privacy
 * page says. It renders nothing until the choice is read in an effect: reading
 * storage during render would produce a hydration mismatch, and a mismatch is
 * how a consent banner ends up on the wrong side of the decision.
 *
 * Accepting injects the script (`ensureAnalyticsScript`); declining injects
 * nothing. Both are stored, so the question is asked once. There is no
 * "reject by scrolling away" arm: no answer means no script, which is the same
 * posture as a decline, only asked once more on the next page view.
 */
export default function AnalyticsConsent({ domain }: { domain: string }) {
  const [choice, setChoice] = useState<AnalyticsConsentChoice | null>(null);
  const [read, setRead] = useState(false);

  useEffect(() => {
    const stored = readAnalyticsConsent();
    setChoice(stored);
    setRead(true);
    if (stored === "granted") ensureAnalyticsScript(domain);
  }, [domain]);

  function answer(next: AnalyticsConsentChoice) {
    writeAnalyticsConsent(next);
    setChoice(next);
    if (next === "granted") ensureAnalyticsScript(domain);
  }

  // `read` keeps the first paint empty rather than flashing the bar at a
  // visitor who already answered in a previous session.
  if (!read || choice !== null) return null;

  return (
    <div
      role="region"
      aria-label="Analytics consent"
      data-consent-key={ANALYTICS_CONSENT_KEY}
      className="fixed bottom-3 left-3 right-3 z-[var(--z-toast)] mx-auto flex max-w-xl flex-col gap-2 rounded-2xl bg-white p-3 text-sm font-bold text-ink shadow-float max-md:text-[13px] sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-balance">
        Count a page view? It is cookieless, aggregate and off unless you say yes.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => answer("denied")}
          className="rounded-full bg-icy px-4 py-1.5 text-sm font-bold text-mutedink"
        >
          No thanks
        </button>
        <button
          type="button"
          onClick={() => answer("granted")}
          className="rounded-full bg-ink px-4 py-1.5 text-sm font-bold text-white"
        >
          Allow
        </button>
      </div>
    </div>
  );
}
