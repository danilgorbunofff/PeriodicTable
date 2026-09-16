/**
 * Destructive-seed guard (Phase 17, R17-5).
 *
 * `prisma/launch-seed.ts --fresh` deletes twelve tables — including `Payment`,
 * `ProviderEvent`, `AuditLog` and `Stake` — and then zeroes every element
 * aggregate. Until this module existed, the only thing standing between a
 * production `DATABASE_URL` and that wipe was the comment above the loop
 * ("Never used in production flows"), which asserts intent and enforces
 * nothing: no host check, no confirmation, no record of which database the
 * command was pointed at. The rows it deletes are exactly the material a
 * dispute or an incident review needs, and the only recovery is a Neon branch
 * restore inside a window nobody has documented (R17-12).
 *
 * The guard is a pure decision so it can be tested without a database, and the
 * script is the only caller. Three rules, in the order a responder would meet
 * them:
 *
 * 1. A bare run (no `--fresh`) never reaches it — appending is the documented
 *    production seed step (`ops/rollback.md`), it deletes nothing, and refusing
 *    it would break the deploy order for no gain. The target host is still
 *    returned so the caller can print where it is about to write.
 * 2. `--fresh` against a *local* database is the development case and needs no
 *    ceremony.
 * 3. `--fresh` against anything else needs two flags, not one: `--allow-remote`
 *    says "I know this is not my machine", and `--confirm=<host>` repeats back
 *    the host being wiped. One flag is a typo away from a wipe; two are not,
 *    and the second one cannot be produced without reading the host first.
 *
 * The consequence is the point: with the guard in place, the destructive run
 * is a deliberate, double-signed command whose target is printed by the same
 * line that asks for it — and a leaked `DATABASE_URL` alone is not enough.
 */
import { isLocalDatabase } from "./env";

export const REMOTE_FLAG = "--allow-remote";
export const CONFIRM_PREFIX = "--confirm=";

export type SeedGuardDecision =
  | {
      ok: true;
      /** The host the run will write to, for the banner the caller prints. */
      host: string;
      local: boolean;
      fresh: boolean;
    }
  | { ok: false; code: SeedRefusal; message: string };

export type SeedRefusal =
  | "NO_DATABASE_URL"
  | "UNPARSEABLE_DATABASE_URL"
  | "REMOTE_FLAG_REQUIRED"
  | "CONFIRM_REQUIRED";

/** The host of a connection string, or null when it is absent or unparseable. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.host || null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a `launch-seed` invocation may proceed. `argv` is the
 * script's own arguments (`process.argv.slice(2)`); `localCheck` is injectable
 * so the three arms are testable against a loopback URL without a database.
 */
export function seedGuard(opts: {
  fresh: boolean;
  databaseUrl: string | undefined;
  argv: readonly string[];
  localCheck?: (url: string | undefined) => boolean;
}): SeedGuardDecision {
  const host = hostOf(opts.databaseUrl);
  if (!host) {
    return {
      ok: false,
      code: opts.databaseUrl ? "UNPARSEABLE_DATABASE_URL" : "NO_DATABASE_URL",
      message: opts.databaseUrl
        ? "DATABASE_URL is not a URL this guard can read; refusing to guess what it points at."
        : "DATABASE_URL is not set.",
    };
  }
  const local = (opts.localCheck ?? isLocalDatabase)(opts.databaseUrl);
  if (!opts.fresh || local) return { ok: true, host, local, fresh: opts.fresh };

  if (!opts.argv.includes(REMOTE_FLAG)) {
    return {
      ok: false,
      code: "REMOTE_FLAG_REQUIRED",
      message:
        `--fresh would delete payments, provider events and the audit log on ${host}, ` +
        `which is not a loopback database. Re-run with ${REMOTE_FLAG} ` +
        `--confirm=${host} if that is really the database to wipe.`,
    };
  }
  const confirm = opts.argv.find((a) => a.startsWith(CONFIRM_PREFIX));
  const confirmed = confirm?.slice(CONFIRM_PREFIX.length);
  if (confirmed !== host) {
    return {
      ok: false,
      code: "CONFIRM_REQUIRED",
      message: confirm
        ? `--confirm=${confirmed} does not name the target host (${host}); refusing.`
        : `--fresh on ${host} also needs --confirm=${host} — repeat the host back to show it was read.`,
    };
  }
  return { ok: true, host, local: false, fresh: true };
}
