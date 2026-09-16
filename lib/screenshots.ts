/** Screenshot / preview helpers (Phase 4, spec 02-previews-og-seo.md).
 * No new infra in MVP: Microlink free shot on demand, favicon fallback.
 * Async persist job stores Startup.previewImgUrl within 24h of Payment.paid.
 *
 * NOTE: Microlink's old `image.microlink.io` host no longer resolves (verified
 * 2026-09-10 — NXDOMAIN on public resolvers), which silently failed every
 * preview job in production. Everything below now uses `api.microlink.io`.
 */

/** The icon service's own URL. **Server-side only** — it names Google, and a
 *  browser that fetches it hands Google the visitor's IP together with the
 *  listing being viewed (R16-3). The only intended caller is the proxy route
 *  that fetches it on the visitor's behalf, `app/api/favicon/route.ts`. */
export function upstreamFaviconUrl(domain: string, size = 64): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}

/** What a page puts in an `<img src>` for a listing's icon: this site's own
 *  proxy, never the icon service (R16-3). Relative on purpose — the same string
 *  works for a browser, for `next/og` and for a stored `Startup.logoUrl`. */
export function faviconFor(domain: string, size = 64): string {
  return `/api/favicon?domain=${encodeURIComponent(domain)}&sz=${size}`;
}

/** The icon service's URL, as stored on rows written before the proxy existed
 *  (R16-3). Every such row is rendered through the proxy instead, so old
 *  listings stop calling Google from the browser too. */
export function isUpstreamFaviconUrl(src: string | null | undefined): boolean {
  return typeof src === "string" && /^https?:\/\/(www\.)?google\.com\/s2\/favicons\?/.test(src);
}

/**
 * Microlink JSON API call for a 16:9 homepage screenshot — metadata, not bytes.
 * Cold render of an uncached site is ~4s, a cached repeat ~0.1s.
 */
export function jsonShotUrlFor(url: string): string {
  return `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false&viewport.width=1200&viewport.height=675`;
}

/** The listing's preview image: the shot our worker stored, else its icon.
 *
 *  R16-3 removed the `embed=screenshot.url` branch that let a browser stream
 *  Microlink's PNG directly. Hovering a tile therefore loaded a third party's
 *  renderer inside the visitor's session, from a host the privacy page had not
 *  named, before any screenshot had been stored — and the stored-shot path
 *  (§5.5: "our servers call it, once per listing, never your browser") is the
 *  only one the privacy page describes. A listing without a stored shot now
 *  shows its icon until the worker has one. */
export function previewFor(params: { previewImgUrl?: string | null; domain: string; size?: number }): string {
  if (params.previewImgUrl) return params.previewImgUrl;
  return faviconFor(params.domain, params.size ?? 128);
}

/**
 * Bounded single-probe preview persist (Phase 2 outbox drain + Phase 6 worker).
 * Returns true when a shot URL was stored. Throws on probe failure so the
 * caller can back off (outbox retry) — never swallows into silent success.
 */
export async function persistPreview(input: {
  startupId: string;
  url: string;
  store: (startupId: string, previewImgUrl: string) => Promise<unknown>;
}): Promise<boolean> {
  const shot = await probeShot(input.url);
  if (!shot) throw new Error("preview probe failed");
  await input.store(input.startupId, shot);
  return true;
}

/**
 * Probe a homepage shot and return its permanent CDN URL, or null.
 *
 * Uses the JSON API (no `embed`) so a worker transfers ~300 bytes instead of
 * the full ~1.8MB PNG: Microlink renders once, returns an `iad.microlink.io/…`
 * URL, and that stable URL is what we store — so page views never re-render.
 */
export async function probeShot(url: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    // Fetch-time SSRF guard (Phase 6): validation blocks these at intake, but
    // legacy rows predate it — never fetch non-public hosts.
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
    const { isPublicHost } = await import("./validate");
    if (!isPublicHost(host)) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(jsonShotUrlFor(url), { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: unknown; data?: { screenshot?: { url?: unknown } } };
    if (body?.status !== "success") return null;
    const shot = body.data?.screenshot?.url;
    if (typeof shot !== "string" || !shot) return null;
    // Never store a third-party-supplied URL unvetted: it ends up in an
    // `<img src>` on our pages, so require the provider's own HTTPS CDN.
    const parsed = new URL(shot);
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".microlink.io")) return null;
    return shot;
  } catch {
    return null;
  }
}

