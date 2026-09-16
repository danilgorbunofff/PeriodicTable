/* Phase 2 acceptance (doc/review/02-shell-and-static-surfaces.md §8): every dead
   end is the product's own screen — wordmark, one h1, a legal nav, a way back —
   and both 404 shapes render inside the app shell instead of Next's bare
   `__next_error__` document (R02-1, R02-2), with route and root boundaries that
   keep a working retry (R02-3).

   The chrome is asserted by rendering it: react-dom/server already ships with
   Next, and the acceptance check greps a *served body*, so reading the same
   markup is closer to the check than matching source text is. What only exists
   once Next runs — which file the App Router picks for which shape — is locked
   by reading the files, the idiom lib/a11y.test.ts already uses. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { GLOBAL_ERROR, HOME_LINK, LEGAL_LINKS, NOT_FOUND, ROUTE_ERROR } from "./boundaries";
import { BoundaryNotice } from "./boundaryChrome";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
/** Rendered markup escapes the ampersand in "About & disclaimer". */
const escapeLabel = (label: string) => label.replace(/&/g, "&amp;");
const html = (props: Parameters<typeof BoundaryNotice>[0]) => renderToStaticMarkup(BoundaryNotice(props));
const NOT_FOUND_HTML = html({ eyebrow: NOT_FOUND.eyebrow, heading: NOT_FOUND.heading, body: NOT_FOUND.body });
const ROUTE_ERROR_HTML = html({
  eyebrow: ROUTE_ERROR.eyebrow,
  heading: ROUTE_ERROR.heading,
  body: ROUTE_ERROR.body,
  onRetry: () => {},
  retryLabel: ROUTE_ERROR.retry,
});

describe("the 404 screen (R02-1, R02-2)", () => {
  it("carries the phrase the acceptance check greps a served body for", () => {
    expect(NOT_FOUND.heading).toMatch(/could not be found/i);
    expect(NOT_FOUND_HTML).toContain(NOT_FOUND.heading);
    expect(NOT_FOUND_HTML).toMatch(/could not be found/i);
  });

  it("is the product's own chrome, not a bare document", () => {
    // The wordmark, rendered as the layout renders it: brand plus the money-tone TLD.
    expect(NOT_FOUND_HTML).toContain('periodictable<span class="text-money">.lol</span>');
    expect(NOT_FOUND_HTML).toContain(NOT_FOUND.eyebrow);
    expect(NOT_FOUND_HTML).toContain(NOT_FOUND.body);
  });

  it("gives the page exactly one h1", () => {
    expect(NOT_FOUND_HTML.match(/<h1/g)).toHaveLength(1);
  });

  it("offers a way back into the product", () => {
    expect(NOT_FOUND_HTML).toContain('href="/"');
    expect(NOT_FOUND_HTML).toContain(HOME_LINK);
  });

  it("keeps the legal nav reachable from a dead end", () => {
    expect(NOT_FOUND_HTML).toContain('aria-label="Legal"');
    for (const link of LEGAL_LINKS) {
      expect(NOT_FOUND_HTML).toContain(`href="${link.href}"`);
      expect(NOT_FOUND_HTML).toContain(escapeLabel(link.label));
    }
  });

  it("renders inside the app shell rather than Next's bare error document", () => {
    // The old `notFound()` shape rendered Next's bare document: no layout, no
    // chrome, `<html id="__next_error__">`. Importing next/error is how that
    // shape comes back, so that import is what this pins.
    const s = src("app/not-found.tsx");
    expect(s).toContain("BoundaryNotice");
    expect(s).not.toMatch(/from "next\/error"/);
  });

  it("stays out of the index, the tag the stock page used to send", () => {
    const s = src("app/not-found.tsx");
    expect(s).toMatch(/export const metadata/);
    expect(s).toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
  });
});

describe("the error screens (R02-3)", () => {
  it("names what broke without claiming anything was lost", () => {
    for (const copy of [ROUTE_ERROR, GLOBAL_ERROR]) {
      expect(copy.eyebrow).toBeTruthy();
      expect(copy.heading).toBeTruthy();
      expect(copy.body.length).toBeGreaterThan(60);
      expect(copy.retry).toBeTruthy();
      // A boundary is not a sales surface: no price, no floor, no offer.
      expect(`${copy.heading} ${copy.body}`).not.toMatch(/\$\d|unclaimed/i);
    }
    expect(GLOBAL_ERROR.heading).toMatch(/periodictable\.lol/);
  });

  it("offers a retry that is a button, and a way home beside it", () => {
    expect(ROUTE_ERROR_HTML).toContain(ROUTE_ERROR.retry);
    expect(ROUTE_ERROR_HTML).toMatch(/<button[^>]*type="button"/);
    expect(ROUTE_ERROR_HTML).toContain(HOME_LINK);
    // Same chrome as the 404, so a failure is not a different-looking site.
    expect(ROUTE_ERROR_HTML).toContain('periodictable<span class="text-money">.lol</span>');
    expect(ROUTE_ERROR_HTML).toContain('aria-label="Legal"');
  });

  it("wires the route boundary to reset(), so retry re-renders instead of reloading", () => {
    const s = src("app/error.tsx");
    expect(s.startsWith('"use client";')).toBe(true);
    expect(s).toMatch(/useEffect\(/);
    expect(s).toMatch(/console\.error\(/);
    expect(s).toMatch(/onRetry=\{reset\}/);
    expect(s).toMatch(/from "\.\.\/lib\/boundaries"/);
  });

  it("gives the root boundary its own document and stylesheet", () => {
    // It replaces the root layout, so nothing it needs is guaranteed to exist.
    const s = src("app/global-error.tsx");
    expect(s.startsWith('"use client";')).toBe(true);
    expect(s).toMatch(/import "\.\/globals\.css";/);
    expect(s).toMatch(/<html lang="en">/);
    expect(s).toMatch(/<body/);
    expect(s).toMatch(/onRetry=\{reset\}/);
  });

  it("keeps the chrome independent of the client router", () => {
    // A boundary is what renders when something already went wrong; next/link
    // would make the escape route depend on the thing that broke.
    const s = src("lib/boundaryChrome.tsx");
    expect(s).not.toMatch(/from "next\/link"/);
    expect(s).toMatch(/from "\.\/boundaries"/);
  });
});

/* Doc 15 §5.14 (R15-3, R15-10): a *database* outage used to be the one failure
   with no answer — every API route went through withContract and both ISR pages
   had a fallback, but the two pages that read through the cache directly threw
   out of the render and the visitor got Next's error document. What a page says
   when a read fails is source-level (the throw happens inside Next's render
   pass), so these lock the shape rather than a served body. */
describe("the data-outage answers (R15-3, R15-10)", () => {
  it("keeps every profile read guarded, in both the metadata and the page", () => {
    const s = src("app/s/[domain]/page.tsx");
    // generateMetadata runs before the page and its own read had no guard, so an
    // outage threw there first — the page below never got to answer.
    expect((s.match(/logProfileRead\(/g) ?? []).length).toBe(3);
    expect(s).toMatch(/title: "Startup profile — periodictable\.lol"/);
  });

  it("tells a missing profile (404) apart from an outage (200 shell)", () => {
    const s = src("app/s/[domain]/page.tsx");
    // Only a read that *threw* is the outage; a hidden or empty profile is a
    // 404 in every deployment, exactly as before this pass.
    expect(s).toMatch(/if \(!dbFailed\) return notFound\(\);/);
    expect(s).toMatch(/profile temporarily unavailable/);
    expect(s).toMatch(/The table itself is still up/);
  });

  it("never answers an unknown element symbol with a real element's shell", () => {
    const s = src("app/elements/[sym]/page.tsx");
    // The redirect above only fires when a row was found, so without this an
    // unknown symbol fell through to the populated shell (ISR kept a copy).
    expect(s).toMatch(/if \(!el\) notFound\(\)/);
    expect(s).toMatch(/Live standings are temporarily unavailable/);
    // The outage leaves a line naming the page, through `lib/log.ts` (R18-11).
    expect(s).toMatch(/logError\("page", "element-read-failed", \{/);
  });

  it("logs the failing read with the page and the reason, never silently", () => {
    for (const p of ["app/s/[domain]/page.tsx", "app/elements/[sym]/page.tsx"]) {
      const s = src(p);
      // A structured payload through `lib/log.ts` (R18-11, which replaced the
      // hand-rolled `console.error(JSON.stringify(…))` this pass first used):
      // the point is that an outage leaves evidence, not just a different
      // picture, and the line goes to the structured sink the drain reads.
      expect(s, p).toContain("lib/log");
      expect(s, p).toMatch(/logError\("page", "[a-z-]+", \{/);
      expect(s, p).toMatch(/error: describeError\(err\)/);
    }
  });
});
