/**
 * Job + admin authentication (Phase 6, P1-15).
 *
 * Production: every job invocation must authenticate — Bearer CRON_SECRET
 * (preferred) or matching body secret. No body-shape bypasses: an invalid
 * secret is rejected for EVERY payload. Missing CRON_SECRET in production
 * rejects everything (fail closed; lib/env.ts already requires it).
 *
 * R13-2: the rehearsal exemption used to be decided by the framework's
 * environment string, so anything that did not call itself "production" — a
 * preview deployment, a laptop running `next start` with the production `.env`
 * loaded — answered an unauthenticated worker call, and the queue it drains is
 * the same queue. The exemption is now decided by *which database this process
 * would touch*: with no credential, a call is answered only when DATABASE_URL is
 * loopback-local (isLocalDatabase(), lib/env.ts), whatever NODE_ENV or
 * VERCEL_ENV say. The two failing arms fail the same way — 401 — so there is no
 * shape in which a remote database is reachable unauthenticated, and a local
 * rehearsal still needs no secret.
 *
 * Phase 11 (R11-4) added the two gates below. The credential check alone left
 * every operator and job surface unmetered: the review sent fifty consecutive
 * admin retries and fifty job calls, and every one was answered. A gate now
 * checks the credential first and then meters the caller, so the budget is spent
 * by calls that were allowed, not by the refusals a prober generates. Refusals
 * from here also carry the shared {error, code} envelope and a request id
 * (R11-3) — they were the only 401/403s in the app that did not.
 *
 * Phase 14 finished the job (R14-2, R14-8, R14-10):
 * - `?secret=` no longer names the caller budget: a query string is the one part
 *   of a URL that is guaranteed to end up in access logs, browser history and
 *   Referer headers, and it never authenticated anything (R14-8). Only the
 *   bearer header and a body secret count, and the body form is on its way out
 *   with the deployment that still uses it.
 * - Refusals are metered per source address and logged (R14-10). Formerly a
 *   hundred wrong tokens produced a hundred answers and no evidence at all.
 * - The refusal path fails CLOSED on a rate-store outage, because the caller was
 *   already being refused (R14-2).
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { isLocalDatabase, isProduction } from "./env";
import { clientIp } from "./ip";
import { rateLimitAsync } from "./rateStore";
import { apiError } from "./route";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function jobAuth(
  req: NextRequest,
  bodySecret?: string | null,
): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  const bearer =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const ok =
    !!secret &&
    ((!!bearer && safeEqual(bearer, secret)) ||
      (!!bodySecret && safeEqual(bodySecret, secret)));
  if (ok) return null;
  // Local rehearsal: this working tree's own database, no secret, and a queue
  // nobody else can see. Everywhere else — including a "development" string
  // pointing at a remote DATABASE_URL — this is a 401.
  if (isProduction() || !isLocalDatabase()) {
    return apiError("unauthorized", { status: 401, code: "UNAUTHORIZED" });
  }
  return null;
}

/** Operator endpoints (moderation triage, outbox retry). ADMIN_TOKEN bearer,
 * timing-safe; 403 when unset OR mismatched — even in development, so a
 * leaked dev database is never one missing header from mutation.
 *
 * R17-6: `ADMIN_TOKENS` adds *named* operators (`name:token,name:token`), and a
 * named token authenticates here exactly like the shared one. The reason is
 * attribution rather than secrecy: with one token, the name in
 * `AuditLog.actorRef` is whatever the caller typed, so the trail records who
 * claimed to act and revocation is all-or-nothing (one env var, one deploy).
 * With a named token the route can record the identity the credential proves —
 * see operatorIdentity() — and removing one operator is deleting one entry.
 * Both mechanisms may be live at once: the shared token stays for the
 * break-glass case (D12), and it simply carries no name. */
export function adminAuth(req: NextRequest): NextResponse | null {
  const bearer =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const token = process.env.ADMIN_TOKEN;
  const ok =
    !!bearer &&
    ((!!token && safeEqual(bearer, token)) ||
      operatorTokens().some((t) => safeEqual(bearer, t.token)));
  if (ok) return null;
  return apiError("forbidden", { status: 403, code: "FORBIDDEN" });
}

/** One named operator credential. */
export type OperatorToken = { name: string; token: string };

/**
 * Parse `ADMIN_TOKENS` into named credentials. Malformed entries are skipped
 * rather than fatal: this is an operator convenience variable, and a stray
 * comma must not take the moderation surface down. Empty when unset — the
 * single-token posture, which is what production runs today.
 */
export function operatorTokens(
  env: NodeJS.ProcessEnv = process.env,
): OperatorToken[] {
  const raw = env.ADMIN_TOKENS;
  if (!raw) return [];
  const out: OperatorToken[] = [];
  for (const entry of raw.split(",")) {
    const at = entry.indexOf(":");
    if (at <= 0) continue;
    const name = entry.slice(0, at).trim().slice(0, 120);
    const token = entry.slice(at + 1).trim();
    if (name && token) out.push({ name, token });
  }
  return out;
}

/**
 * The name of the operator whose *token* this request presented, or null when
 * it presented the unnamed shared one (or nothing at all — a route only asks
 * after adminGate has already accepted the caller, so null here means "this
 * deployment has one shared token and no way to name the caller").
 *
 * Routes use it as the default attribution for `reviewedBy`/`operator` and for
 * `AuditLog.actorRef`, ahead of any string the body carries: when a named token
 * authenticated the call, the name in the trail is a fact rather than a claim.
 */
export function operatorIdentity(req: NextRequest): string | null {
  const bearer =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!bearer) return null;
  const match = operatorTokens().find((t) => safeEqual(bearer, t.token));
  return match?.name ?? null;
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
 *
 * R14-8 removed the `?secret=` term that used to sit between the two: it never
 * authenticated anything (jobAuth reads the header and the body only), and the
 * only thing it did was copy a secret out of the request body and into the
 * budget key — which meant a caller could spend a fresh budget by inventing a
 * new secret per request, and that a real secret could be pasted into a URL
 * without complaint. Bearer, then a body secret, then the shared
 * "unauthenticated" bucket that the local-rehearsal arm runs in.
 */
function callerKey(
  prefix: string,
  route: string,
  req: NextRequest,
  extra: string | null,
): string {
  const bearer =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const credential = bearer ?? extra ?? "unauthenticated";
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
  extra: string | null,
): Promise<NextResponse | null> {
  // Fail-open by design (lib/rateStore): a limiter outage must not take the
  // outbox down with it.
  if (
    await rateLimitAsync(callerKey(prefix, route, req, extra), limit, windowMs)
  )
    return null;
  return apiError("Too many requests. Try again later.", {
    status: 429,
    code: "RATE_LIMITED",
  });
}

/* ------------------------------------------------------------------ *
 * Refusal metering and reporting (Phase 14, R14-2 / R14-10)
 * ------------------------------------------------------------------ */

/**
 * How many refusals one address may generate per route per hour before the gate
 * stops answering them, and how many make the log call that rate anomalous.
 *
 * Sizing: an operator mistyping a token a few times, or a browser retrying a
 * stale one, stays an order of magnitude below sixty. The review's reproduction
 * — a hundred consecutive wrong tokens — crosses it in the first minute.
 */
export const AUTH_REJECTION_LIMIT = 60;
export const AUTH_REJECTION_WINDOW_MS = 60 * 60_000;
const AUTH_REJECTION_ALERT = 20;

type CredentialShape = "bearer token" | "body secret" | "no credential";

/** Per-process refusal counters, for the log line only — the limiter itself is
 *  the shared store. Bounded: an attacker arriving from many addresses must not
 *  be able to grow a map in the process that is answering them. */
const refusalCounters = new Map<string, { window: number; count: number }>();

function noteRefusal(
  route: string,
  shape: CredentialShape,
  ip: string,
  status: number,
): void {
  const window = Math.floor(Date.now() / AUTH_REJECTION_WINDOW_MS);
  const key = `${route}:${ip}`;
  const seen = refusalCounters.get(key);
  const count = seen && seen.window === window ? seen.count + 1 : 1;
  if (refusalCounters.size > 5_000) refusalCounters.clear();
  refusalCounters.set(key, { window, count });
  // The shape is logged, never the value: a prober with no header at all is a
  // different event from one guessing tokens, and a log must not become the
  // place a leaked secret is legible. Past the alert threshold the line is
  // escalated once per AUTH_REJECTION_ALERT refusals instead of every time.
  const line =
    `auth: refused (${shape}, ${status}) on /api/${route} from ${ip} — ` +
    `${count} this hour`;
  if (count % AUTH_REJECTION_ALERT === 0) {
    console.error(`${line} (a rate no operator reaches by hand)`);
  } else {
    console.warn(line);
  }
}

/** Which kind of credential a request presented — never its value. */
function credentialShape(
  req: NextRequest,
  bodySecret?: string | null,
): CredentialShape {
  if (req.headers.get("authorization")) return "bearer token";
  return bodySecret ? "body secret" : "no credential";
}

/**
 * Records one refusal and answers it, or answers 429 once this address has spent
 * the hour's refusal allowance on this route.
 *
 * The refusal budget is deliberately NOT the caller budget above. That one is
 * keyed on the credential and exists to bound legitimate work, so it cannot bill
 * a prober — every wrong token would land in the same "unauthenticated" bucket
 * and the operator's own calls would be throttled along with the attack. This
 * budget is keyed on the source address, which is the only identity a refusal
 * has. 429 is also the one answer here that confirms nothing: it does not say
 * whether the guess was close.
 *
 * Called from the gates rather than from `jobAuth`/`adminAuth`, so the 401/403
 * envelopes keep their single definition and the credential check stays a pure
 * function with no store dependency.
 */
async function refuse(
  req: NextRequest,
  route: string,
  shape: CredentialShape,
  denied: NextResponse,
): Promise<NextResponse> {
  const ip = clientIp(req.headers);
  noteRefusal(route, shape, ip, denied.status);
  // Fail CLOSED on a store outage: the caller was refused anyway, so the only
  // question is whether the answer says 401/403 or 429. Refusing keeps the cost
  // of guessing nonzero while the store is unavailable.
  const under = await rateLimitAsync(
    `authdenied:${route}:${ip}`,
    AUTH_REJECTION_LIMIT,
    AUTH_REJECTION_WINDOW_MS,
    { onStoreError: "closed" },
  );
  if (under) return denied;
  return apiError("Too many requests. Try again later.", {
    status: 429,
    code: "RATE_LIMITED",
  });
}

/**
 * The operator gate: auth, then metering. Every `/api/admin/**` handler starts
 * with this (`route` is the path under `/api/`, e.g. `"admin/reports"`), which
 * is what `lib/contracts.test.ts` asserts — a route that calls `adminAuth()`
 * directly is unmetered and fails the suite. A refusal is logged and billed to
 * the source address (R14-10, R14-2).
 */
export async function adminGate(
  req: NextRequest,
  route: string,
): Promise<NextResponse | null> {
  const denied = adminAuth(req);
  if (denied) return refuse(req, route, credentialShape(req), denied);
  return throttle("admin", route, req, ADMIN_LIMIT, ADMIN_WINDOW_MS, null);
}

/** The job gate: `jobAuth` (Bearer header or body secret — the query form is
 * gone, R14-8) plus metering, with refusals logged and billed to the source
 * address (R14-10, R14-2). */
export async function jobGate(
  req: NextRequest,
  route: string,
  bodySecret?: string | null,
): Promise<NextResponse | null> {
  const denied = jobAuth(req, bodySecret);
  if (denied) return refuse(req, route, credentialShape(req, bodySecret), denied);
  return throttle(
    "job",
    route,
    req,
    JOB_LIMIT,
    JOB_WINDOW_MS,
    bodySecret ?? null,
  );
}
