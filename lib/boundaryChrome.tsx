import React from "react";
import { HOME_LINK, LEGAL_LINKS } from "./boundaries";

/**
 * Chrome shared by the three boundary screens — the 404 (R02-1, R02-2), the
 * route error and the root error (R02-3).
 *
 * Plain `<a>` rather than `next/link` on purpose: a boundary is what renders
 * when something already went wrong, so it must not depend on the client router
 * being healthy. It also keeps this component renderable outside Next, which is
 * how lib/boundaryChrome.test.ts greps the served phrases without a browser.
 *
 * The wordmark and the legal nav are here because the old 404s had neither: a
 * visitor who mistypes a URL gets a dead end with no route into the product and
 * no way to reach the rules.
 */
export function BoundaryNotice({
  eyebrow,
  heading,
  body,
  onRetry,
  retryLabel,
}: {
  eyebrow: string;
  heading: string;
  body: string;
  /** Route boundaries get the panel's primary button; the 404 gets the link home. */
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-profilebg px-4 py-10 text-ink">
      <main className="w-full max-w-md">
        <a href="/" className="font-display text-[22px] font-bold text-ink no-underline">
          periodictable<span className="text-money">.lol</span>
        </a>
        <div className="mt-5 rounded-card bg-cardbg px-6 py-7 text-center shadow-card">
          <div className="text-[11px] font-black uppercase tracking-widest text-mutedink">{eyebrow}</div>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink">{heading}</h1>
          <p className="mt-3 text-sm font-semibold leading-relaxed text-mutedink">{body}</p>
          {onRetry ? (
            <>
              <button
                type="button"
                onClick={onRetry}
                className="mt-5 inline-flex h-11 items-center rounded-full bg-cta px-6 font-display text-sm font-bold text-ink hover:brightness-95 [@media(pointer:coarse)]:min-h-[44px]"
              >
                {retryLabel}
              </button>
              <div className="mt-4">
                <a href="/" className="text-sm font-bold text-mutedink no-underline hover:text-ink">
                  {HOME_LINK}
                </a>
              </div>
            </>
          ) : (
            <div className="mt-5">
              <a
                href="/"
                className="inline-flex h-11 items-center rounded-full bg-cta px-6 font-display text-sm font-bold text-ink no-underline hover:brightness-95 [@media(pointer:coarse)]:min-h-[44px]"
              >
                {HOME_LINK}
              </a>
            </div>
          )}
        </div>
        <nav aria-label="Legal" className="mt-6 flex flex-wrap items-center justify-center gap-x-2 gap-y-2 text-xs font-bold text-mutedink">
          {LEGAL_LINKS.map((link, i) => (
            <span key={link.href} className="flex items-center gap-x-2">
              {i > 0 ? <span aria-hidden="true">·</span> : null}
              <a href={link.href} className="no-underline hover:text-ink hover:underline">
                {link.label}
              </a>
            </span>
          ))}
        </nav>
      </main>
    </div>
  );
}
