/**
 * Job + admin authentication (Phase 6, P1-15).
 *
 * Production: every job invocation must authenticate — Bearer CRON_SECRET
 * (preferred) or matching body secret. No body-shape bypasses: an invalid
 * secret is rejected for EVERY payload. Missing CRON_SECRET in production
 * rejects everything (fail closed; lib/env.ts already requires it).
 * Non-production allows unauthenticated local/cron rehearsal.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { isProduction } from "./env";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function jobAuth(req: NextRequest, bodySecret?: string | null): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const ok = !!secret && ((!!bearer && safeEqual(bearer, secret)) || (!!bodySecret && safeEqual(bodySecret, secret)));
  if (ok) return null;
  if (isProduction()) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null; // dev/test rehearsal without secrets
}

/** Operator endpoints (moderation triage, outbox retry). ADMIN_TOKEN bearer,
 * timing-safe; 403 when unset OR mismatched — even in development, so a
 * leaked dev database is never one missing header from mutation. */
export function adminAuth(req: NextRequest): NextResponse | null {
  const token = process.env.ADMIN_TOKEN;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!token || !bearer || !safeEqual(bearer, token)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return null;
}
