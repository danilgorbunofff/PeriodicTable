/**
 * Rate limiting with pluggable storage (Phase 6, shared abuse controls).
 *
 * - `rateLimit()` keeps the historical sync in-memory behavior (dev tools,
 *   unit tests, and the click path's fast pre-check).
 * - `rateLimitAsync()` uses shared atomic storage when Upstash is configured
 *   (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) and the same memory
 *   store otherwise. All request routes use the async variant.
 * - The shared store fails OPEN by default (allows the request, logs the
 *   error): abuse controls must degrade, never 500 traffic. Production without
 *   Upstash logs a loud warning at first use.
 * - R14-2: the callers that stand in front of outbound mail or of money pass
 *   `onStoreError: "closed"` — see rateLimitAsync() below for why that is a
 *   deliberate split rather than a global inversion.
 */
import { describeError, logError, logWarn } from "./log";
import { rateLimit as syncBucket } from "./rateLimit";

export type RateLimitStore = {
  /** Atomically increments the window counter; returns the new count. */
  incr(key: string, windowMs: number): Promise<number>;
};

class MemoryStore implements RateLimitStore {
  private buckets = new Map<string, number[]>();
  async incr(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const hits = (this.buckets.get(key) ?? []).filter((t) => now - t < windowMs);
    hits.push(now);
    this.buckets.set(key, hits);
    if (this.buckets.size > 10_000) {
      for (const [k, v] of this.buckets) {
        if (v.every((t) => now - t >= windowMs)) this.buckets.delete(k);
      }
    }
    return hits.length;
  }
}

class UpstashStore implements RateLimitStore {
  constructor(
    private url: string,
    private token: string
  ) {}
  private async call(path: string, init?: RequestInit): Promise<{ result?: unknown }> {
    const res = await fetch(`${this.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`upstash ${res.status}`);
    return (await res.json()) as { result?: unknown };
  }
  async incr(key: string, windowMs: number): Promise<number> {
    const k = encodeURIComponent(`ptl:rl:${key}`);
    const { result } = await this.call(`/incr/${k}`, { method: "POST" });
    const count = typeof result === "number" ? result : 1;
    if (count === 1) {
      await this.call(`/expire/${k}/${Math.max(1, Math.ceil(windowMs / 1000))}`, { method: "POST" }).catch(
        () => undefined
      );
    }
    return count;
  }
}

let sharedStore: RateLimitStore | null = null;
let warnedNoUpstash = false;

export function sharedRateLimitStore(): RateLimitStore {
  if (sharedStore) return sharedStore;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    sharedStore = new UpstashStore(url.replace(/\/$/, ""), token);
  } else {
    sharedStore = new MemoryStore();
    if (process.env.NODE_ENV === "production" && !warnedNoUpstash) {
      warnedNoUpstash = true;
      // Once per process, and at `warn`: the limits still hold, they just hold
      // per instance (R14-2), which is a degraded guarantee rather than a broken
      // one. Only in production — in dev the memory store is the intended one.
      logWarn("ratelimit", "no-shared-store", { fallback: "instance-local-memory" });
    }
  }
  return sharedStore;
}

/** Test hook: swap the shared store (restored per test). */
export function setSharedRateLimitStore(store: RateLimitStore | null): void {
  sharedStore = store;
  warnedNoUpstash = false;
}

/** How a limiter treats an unusable store: `open` lets the request through,
 *  `closed` refuses it. */
export type StoreErrorPolicy = "open" | "closed";

/** R14-2: store failures are counted, and the count is what the log says. Before
 *  this the only trace of an outage was one console.error per request carrying
 *  the raw driver error — indistinguishable in a log stream from a single bad
 *  request, and silent about the fact that every limiter in the app had stopped
 *  working. Per process, because an outage is per process. */
const STORE_FAILURE_WINDOW_MS = 3_600_000;
let storeFailureWindow = 0;
let storeFailureCount = 0;

function noteStoreFailure(): number {
  const window = Math.floor(Date.now() / STORE_FAILURE_WINDOW_MS);
  if (window !== storeFailureWindow) {
    storeFailureWindow = window;
    storeFailureCount = 0;
  }
  storeFailureCount += 1;
  return storeFailureCount;
}

/**
 * Async fixed-window check: true when under the limit.
 *
 * A store error is fail-OPEN by default: an Upstash outage must not 500 the
 * site, and most callers are plain abuse controls whose absence is a
 * degradation (doc 20 §R20-8 accepts exactly that for the public surface).
 *
 * Outbound mail and money are the exception (R14-2). `/api/waitlist`,
 * `/api/checkout`, `/api/report` and the Resend webhook pass
 * `onStoreError: "closed"`, because each of them *sends something* (mail, a
 * provider session, a webhook-driven suppression) on the strength of the
 * limiter: an outage that silently lifts their cap turns a capacity control into
 * an open relay. Their honest answer during an outage is a retryable 429 — the
 * caller loses a request, nobody loses money — and the failure is loud in the
 * log with its running count, so an outage cannot look like calm.
 */
export async function rateLimitAsync(
  key: string,
  limit: number,
  windowMs: number,
  opts: { onStoreError?: StoreErrorPolicy } = {}
): Promise<boolean> {
  try {
    return (await sharedRateLimitStore().incr(key, windowMs)) <= limit;
  } catch (e) {
    const failures = noteStoreFailure();
    const policy = opts.onStoreError ?? "open";
    // Only the key's prefix is logged: the rest is a credential hash or an
    // address, and neither belongs in a log line.
    logError("ratelimit", "store-failed", {
      failures,
      policy,
      // The key's prefix only: the rest is a credential hash or an address, and
      // neither belongs in a log line.
      bucket: key.split(":")[0],
      error: describeError(e),
    });
    return policy === "open";
  }
}

/** Sync in-memory check (unchanged legacy behavior). */
export function rateLimitSync(key: string, limit: number, windowMs: number): boolean {
  return syncBucket(key, limit, windowMs);
}
