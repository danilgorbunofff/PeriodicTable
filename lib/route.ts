/**
 * API route helpers (Phase 4): every JSON response carries a request id for
 * log correlation, and errors use the shared {error, code} shape the client
 * fetchJson parses into ApiError.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

export function requestId(): string {
  try {
    return randomUUID();
  } catch {
    return `req-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/**
 * Short shared caching for the read APIs that may be a few seconds stale
 * (R03-3). One declaration instead of a copied string per route.
 *
 * The live probe (2026-09-14, production): three requests 2 s apart to
 * `/api/elements` came back `x-vercel-cache: MISS` then `HIT`, `age: 0/2/4`,
 * with `date` frozen — the edge does honour the 10 s window. It also rewrites
 * the browser-facing directive to `public, max-age=0, must-revalidate`, so no
 * browser is ever promised a stale copy. Mirroring the same policy in
 * `Vercel-CDN-Cache-Control` states the CDN half explicitly, so editing the
 * client directive later cannot silently drop the edge window.
 */
export const READ_CACHE = {
  "Cache-Control": "s-maxage=10, stale-while-revalidate=30",
  "Vercel-CDN-Cache-Control": "s-maxage=10, stale-while-revalidate=30",
} as const;

export function apiJson<T>(data: T, init?: ResponseInit & { code?: string }): NextResponse {
  const id = requestId();
  const res = NextResponse.json(data, init);
  res.headers.set("x-request-id", id);
  return res;
}

export function apiError(message: string, opts: { status?: number; code?: string } = {}): NextResponse {
  const { status = 400, code = "BAD_REQUEST" } = opts;
  const res = NextResponse.json({ error: message, code }, { status });
  res.headers.set("x-request-id", requestId());
  return res;
}
