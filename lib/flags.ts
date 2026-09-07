/** Launch flags (Phase 5, spec 02-launch-gate-runbook.md).
 * PAYMENTS_LIVE=false flips checkout to waitlist in <2min (no redeploy of code,
 * just env). Server reads PAYMENTS_LIVE; client reads NEXT_PUBLIC_PAYMENTS_LIVE.
 */
export function paymentsLiveServer(): boolean {
  return (process.env.PAYMENTS_LIVE ?? "true").toLowerCase() !== "false";
}

export function paymentsLiveClient(): boolean {
  return (process.env.NEXT_PUBLIC_PAYMENTS_LIVE ?? "true").toLowerCase() !== "false";
}
