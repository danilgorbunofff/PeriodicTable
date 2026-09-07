/** Abuse guards (Phase 4, spec 03-abuse-legal-perf.md).
 * Turnstile is env-gated like Whop/Resend: when TURNSTILE_SECRET is absent,
 * verification passes locally so dev/E2E still works; production must set it.
 */
export function turnstileEnabled(): boolean {
  return !!process.env.TURNSTILE_SECRET;
}

export async function verifyTurnstile(token: string | null | undefined, ip?: string | null): Promise<boolean> {
  if (!turnstileEnabled()) return true;
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET as string,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }),
    });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}

/** Honeypot: bots fill the hidden field, humans don't. */
export function honeypotCaught(value: string | null | undefined): boolean {
  return !!value && value.trim().length > 0;
}

/** Checkout self-attest checkbox (ownership verify lands in V2). */
export function attestValid(value: unknown): boolean {
  return value === true || value === "on" || value === "true";
}
