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
