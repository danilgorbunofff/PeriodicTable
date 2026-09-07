/** Screenshot / preview helpers (Phase 4, spec 02-previews-og-seo.md).
 * No new infra in MVP: Microlink free shot URL on demand, favicon fallback.
 * Async persist job stores Startup.previewImgUrl within 24h of Payment.paid.
 */

export function faviconFor(domain: string, size = 64): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}

/** On-demand homepage shot (16:9). Microlink free tier, no key. Lazy + onError→favicon. */
export function shotUrlFor(url: string): string {
  return `https://image.microlink.io/?url=${encodeURIComponent(url)}&viewport.width=1200&viewport.height=675&embed=screenshot.url`;
}

/** Preferred hover preview: stored shot when present, else live shot, else favicon (caller onError). */
export function previewFor(params: { previewImgUrl?: string | null; url?: string | null; domain: string }): string {
  if (params.previewImgUrl) return params.previewImgUrl;
  if (params.url) return shotUrlFor(params.url);
  return faviconFor(params.domain, 128);
}

/** Best-effort persist: fetch the shot and return bytes for upload, or null to keep fallback. */
export async function fetchShotBytes(url: string, timeoutMs = 8000): Promise<Uint8Array | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(shotUrlFor(url), { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1024) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}
