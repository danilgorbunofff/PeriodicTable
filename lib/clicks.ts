/** Click attribution helpers (spec 03-clicks-attribution.md).
 * Pure logic extracted from app/go/[stakeId]/route.ts so it is unit-testable.
 * Counter = verified redirects only; never increment client-side.
 */
import { createHash } from "crypto";
import { rateLimitAsync } from "./rateStore";

const BOTS = /bot|crawl|spider|slurp|headless|preview|curl|wget|python-requests/i;

export function isBotUa(ua: string): boolean {
  return BOTS.test(ua);
}

export function hashIp(ip: string, salt = process.env.CLICK_SALT ?? "ptl-dev-salt"): string {
  return createHash("sha256").update(`${ip}:${salt}`).digest("hex");
}

/** MVP anti-fraud gate: 1/IP/stake/10s + 30/IP/hr. Returns true when the click should count. */
export async function shouldCountClick(stakeId: string, ip: string, ua: string): Promise<boolean> {
  if (isBotUa(ua)) return false;
  const perStakeOk = await rateLimitAsync(`s:${stakeId}:${ip}`, 1, 10_000);
  const perIpOk = await rateLimitAsync(`ip:${ip}`, 30, 3_600_000);
  return perStakeOk && perIpOk;
}
