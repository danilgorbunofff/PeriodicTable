/**
 * Deep links the app hands back to itself. Kept out of the email templates so
 * the URL shapes are unit-tested and stay in sync with the homepage parsers
 * in app/page.tsx.
 */

/**
 * Reclaim link sent by the outbid email: `?el=SYM&stake=N` prefilled the
 * element and the amount; `r=<domain>` additionally lets the homepage fill the
 * holder's own listing back in (URL, name, pitch) from the live element
 * payload, so a returning staker never retypes what we already know.
 *
 * No email address in URLs (P1-18): the receipt address is addressed by the
 * envelope. `r` is omitted when the domain is unknown so previously sent or
 * queued links keep working unchanged.
 */
export function outbidReclaimUrl(
  appUrl: string,
  p: { elementSymbol: string; reclaim: number; domain?: string | null }
): string {
  const r = p.domain ? `&r=${encodeURIComponent(p.domain)}` : "";
  return `${appUrl}/?el=${encodeURIComponent(p.elementSymbol)}&stake=${p.reclaim}${r}`;
}
