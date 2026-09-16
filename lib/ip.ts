/**
 * Client IP extraction (Phase 6, shared abuse controls item 2).
 *
 * Trust order (rewritten for R14-2). Until the phase-14 pass the order was
 * cf-connecting-ip → x-real-ip → leftmost x-forwarded-for, and the first of
 * those is written by *the caller* unless something in front of the app
 * overwrites it. The review rotated one header per request against production
 * and every request landed in a fresh bucket, which voids every limiter that
 * keys on this function at once. A header can only be trusted when the hop that
 * writes it is known to be in the path, so:
 *
 * 1. `cf-ray` present → the request really did pass through Cloudflare, which
 *    overwrites `cf-connecting-ip`; use it.
 * 2. otherwise the *rightmost* x-forwarded-for entry: an edge appends the
 *    address of the peer it actually saw, so the rightmost hop is the one the
 *    caller cannot choose (the leftmost is the caller's own text).
 * 3. `x-real-ip` — the same edge-written value on Vercel, kept as the fallback
 *    for an edge that does not populate x-forwarded-for.
 * 4. `0.0.0.0` — one shared bucket for header-less requests, so a missing header
 *    throttles instead of erroring.
 *
 * Which header this deployment's edge really writes is U14-5 in doc 14 and is
 * still open; the order above is safe either way, because the rightmost hop is
 * edge-appended whichever edge is in front. The cost of guessing wrong is a
 * coarser bucket (a proxy's address instead of the client's), never a
 * caller-chosen one.
 */
const MAX_IP_LENGTH = 45;

/** An address-shaped hop: hex digits, dots and colons only, with something
 *  numeric in it. Anything else (an empty field, `unknown`, a fragment of a
 *  comma-mangled chain) is treated as absent rather than used as a bucket. */
function usableHop(value: string | null | undefined): string | null {
  const hop = (value ?? "").trim().replace(/^\[|\]$/g, "");
  if (hop.length < 2 || hop.length > MAX_IP_LENGTH) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(hop)) return null;
  return /\d/.test(hop) ? hop : null;
}

export function clientIp(headers: Headers): string {
  if (headers.get("cf-ray")) {
    // Behind Cloudflare the pair travels together, so a junk
    // cf-connecting-ip means a junk request, not a different source.
    return usableHop(headers.get("cf-connecting-ip")) ?? "0.0.0.0";
  }
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",");
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = usableHop(hops[i]);
      if (hop) return hop;
    }
  }
  return usableHop(headers.get("x-real-ip")) ?? "0.0.0.0";
}
