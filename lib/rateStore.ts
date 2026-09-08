/**
 * Rate limiting with pluggable storage (Phase 6, shared abuse controls).
 *
 * - `rateLimit()` keeps the historical sync in-memory behavior (dev tools,
 *   unit tests, and the click path's fast pre-check).
 * - `rateLimitAsync()` uses shared atomic storage when Upstash is configured
 *   (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) and the same memory
 *   store otherwise. All request routes use the async variant.
 * - The shared store fails OPEN (allows the request, logs once): abuse
 *   controls must degrade, never 500 traffic. Production without Upstash
 *   logs a loud warning at first use.
 */
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
      console.warn("rate-limit: no shared store configured (UPSTASH_REDIS_REST_URL/TOKEN) — using instance-local memory");
    }
  }
  return sharedStore;
}

/** Test hook: swap the shared store (restored per test). */
export function setSharedRateLimitStore(store: RateLimitStore | null): void {
  sharedStore = store;
  warnedNoUpstash = false;
}

/** Async fixed-window check: true when under the limit. Fails open on store errors. */
export async function rateLimitAsync(key: string, limit: number, windowMs: number): Promise<boolean> {
  try {
    return (await sharedRateLimitStore().incr(key, windowMs)) <= limit;
  } catch (e) {
    console.error("rate-limit store failed open:", e);
    return true;
  }
}

/** Sync in-memory check (unchanged legacy behavior). */
export function rateLimitSync(key: string, limit: number, windowMs: number): boolean {
  return syncBucket(key, limit, windowMs);
}
