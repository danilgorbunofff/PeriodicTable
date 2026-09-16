/**
 * Job + admin authentication (Phase 6, P1-15).
 *
 * Production: every job invocation must authenticate — Bearer CRON_SECRET
 * (preferred) or matching body secret. No body-shape bypasses: an invalid
 * secret is rejected for EVERY payload. Missing CRON_SECRET in production
 * rejects everything (fail closed; lib/env.ts already requires it).
 * Non-production allows unauthenticated local/cron rehearsal.
 *
 * Phase 11 (R11-4) added the two gates below. The credential check alone left
 * every operator and job surface unmetered: the review sent fifty consecutive
 * admin retries and fifty job calls, and every one was answered. A gate now
 * checks the credential first and then meters the caller, so the budget is spent
 * by calls that were allowed, not by the refusals a prober generates. Refusals
 * from here also carry the shared {error, code} envelope and a request id
 * (R11-3) — they were the only 401/403s in the app that did not.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { isProduction } from "./env";
import { rateLimitAsync } from "./rateStore";
import { apiError } from "./route";

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
    return apiError("unauthorized", { status: 401, code: "UNAUTHORIZED" });
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
    return apiError("forbidden", { status: 403, code: "FORBIDDEN" });
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Metering (Phase 11, R11-4)
 * ------------------------------------------------------------------ */

/**
 * One caller's budget per route per window.
 *
 * Sized against the real invocation patterns, not guessed: the GitHub tick runs
 * every ten minutes and calls screenshot and outbox (up to twice each per tick,
 * cron + workflow), abandoned-checkouts, reconcile and config — about six calls
 * per tick, ~36/hour, per route. Thirty a minute sits an order of magnitude
 * above that and still stops a stuck retry loop, which is what the review
 * measured: fifty calls, fifty answers. Admin is an operator's browser: sixty a
 * minute is faster than anyone clicks and still bounded.
 */
export const JOB_LIMIT = 30;
export const JOB_WINDOW_MS = 60_000;
export const ADMIN_LIMIT = 60;
export const ADMIN_WINDOW_MS = 60_000;

/**
 * The budget is per credential, not per source address: cron and the workflow
 * share one secret and arrive from a pool of addresses, so an IP key would
 * multiply the budget by however many addresses the runner happens to use. The
 * credential is hashed rather than stored — a Redis key is a log line on a
 * platform we do not own, and the token is the thing that must not appear in
 * one. The route is in the key so a busy endpoint cannot exhaust the others.
 */
function callerKey(prefix: string, route: string, req: NextRequest, extra: string | null): string {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const credential = bearer ?? extra ?? req.nextUrl.searchParams.get("secret") ?? "unauthenticated";
  const digest = createHash("sha256")
    .update(`${credential}:${process.env.CLICK_SALT ?? "ptl-dev-salt"}`)
    .digest("hex")
    .slice(0, 16);
  return `${prefix}:${digest}:${route}`;
}

async function throttle(
  prefix: "admin" | "job",
  route: string,
  req: NextRequest,
  limit: number,
  windowMs: number,
  extra: string | null
): Promise<NextResponse | null> {
  // Fail-open by design (lib/rateStore): a limiter outage must not take the
  // outbox down with it.
  if (await rateLimitAsync(callerKey(prefix, route, req, extra), limit, windowMs)) return null;
  return apiError("Too many requests. Try again later.", { status: 429, code: "RATE_LIMITED" });
}

/**
 * The operator gate: auth, then metering. Every `/api/admin/**` handler starts
 * with this (`route` is the path under `/api/`, e.g. `"admin/reports"`), which
 * is what `lib/contracts.test.ts` asserts — a route that calls `adminAuth()`
 * directly is unmetered and fails the suite.
 */
export async function adminGate(req: NextRequest, route: string): Promise<NextResponse | null> {
  const denied = adminAuth(req);
  if (denied) return denied;
  return throttle("admin", route, req, ADMIN_LIMIT, ADMIN_WINDOW_MS, null);
}

/** The job gate: `jobAuth` (Bearer, body or query secret) plus metering. */
export async function jobGate(req: NextRequest, route: string, bodySecret?: string | null): Promise<NextResponse | null> {
  const denied = jobAuth(req, bodySecret);
  if (denied) return denied;
  return throttle("job", route, req, JOB_LIMIT, JOB_WINDOW_MS, bodySecret ?? null);
}
