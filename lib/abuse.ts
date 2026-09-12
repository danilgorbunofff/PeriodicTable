/** Abuse guards (Phase 4, spec 03-abuse-legal-perf.md).
 * Turnstile is env-gated like Whop/Resend: when TURNSTILE_SECRET is absent,
 * verification passes locally so dev/E2E still works; production must set it.
 */
export function turnstileEnabled(): boolean {
  return !!process.env.TURNSTILE_SECRET;
}

export async function verifyTurnstile(token: string | null | undefined, ip?: string | null): Promise<boolean> {
  if (!turnstileEnabled()) return true;
  if (!token) {
    // The widget is the only source of this token, so a missing one means the
    // form never produced it. That is a bug in our own page, not a bot.
    console.warn("turnstile: no token on request — checkout blocked");
    return false;
  }
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
    const json = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (json.success !== true) {
      // Cloudflare's code is the only thing that separates a duplicate token from
      // a stale one from a wrong `remoteip` — and the buyer sees the same 400 for
      // all of them. Codes plus an ip presence flag only: never the token, never
      // the secret, never the raw address.
      console.warn(
        `turnstile: siteverify rejected (${json["error-codes"]?.join(",") ?? "no error-codes"}) remoteip=${ip ? "sent" : "omitted"}`
      );
    }
    return json.success === true;
  } catch (err) {
    // Fail closed, but audibly: a broken siteverify is a dead payment path.
    console.warn(`turnstile: siteverify unreachable — ${err instanceof Error ? err.message : "unknown error"}`);
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
