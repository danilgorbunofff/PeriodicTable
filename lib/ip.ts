/**
 * Client IP extraction (Phase 6, shared abuse controls item 2).
 *
 * Trust order (most-trusted platform header first):
 * 1. cf-connecting-ip — set by Cloudflare, authoritative behind CF proxying.
 * 2. x-real-ip — connecting IP as seen by Vercel's edge (not client-set).
 * 3. Leftmost x-forwarded-for — client-influenced; last resort, documented.
 *
 * Never trust x-forwarded-for alone: Vercel appends to it, so the leftmost
 * entry is attacker-controlled on direct connections.
 */
export function clientIp(headers: Headers): string {
  const first = (name: string): string | null => {
    const v = headers.get(name);
    if (!v) return null;
    const ip = v.split(",")[0]?.trim();
    return ip && ip.length > 0 && ip.length <= 45 ? ip : null;
  };
  return (
    first("cf-connecting-ip") ?? first("x-real-ip") ?? first("x-forwarded-for") ?? "0.0.0.0"
  );
}
