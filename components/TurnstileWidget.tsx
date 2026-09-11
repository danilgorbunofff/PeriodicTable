"use client";
import { useEffect, useRef } from "react";

/** Minimal shape of the Turnstile global exposed by api.js?render=explicit. */
declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, opts: { sitekey: string }) => string;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<void> | null = null;

/** Loads api.js at most once per page load; resolves once window.turnstile exists. */
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SCRIPT_SRC;
      script.async = true;
      script.addEventListener("load", () => resolve());
      script.addEventListener("error", () => {
        scriptPromise = null; // let a later open retry
        reject(new Error("turnstile script failed to load"));
      });
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

/**
 * Cloudflare Turnstile widget (Phase 5 §shared abuse controls).
 *
 * Rendered EXPLICITLY instead of via the implicit `.cf-turnstile` DOM scan:
 * this mounts inside a modal, so the element does not exist when api.js loads
 * and the implicit scanner never sees it. No widget means no
 * `cf-turnstile-response` field, so every checkout was rejected server-side
 * with "Bot check failed. Try again." — the whole payment path was dead.
 *
 * api.js is loaded on demand rather than in the root layout: only visitors who
 * open a claim form need it, and loading it after this div is committed keeps
 * render ordering deterministic.
 */
export function TurnstileWidget({ sitekey }: { sitekey: string }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !container.current || !window.turnstile) return;
        widgetId = window.turnstile.render(container.current, { sitekey });
      })
      .catch(() => {
        // Blocked or offline. The server still gates on TURNSTILE_SECRET, so a
        // missing token surfaces as the standard "Bot check failed." message.
      });
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [sitekey]);

  return <div className="mt-2" ref={container} />;
}
