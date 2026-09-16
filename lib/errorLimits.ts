/**
 * Error-report shape limits (Phase 18, R18-1, R18-10).
 *
 * Split out from `lib/errorReport.ts` on purpose: the client reporter
 * (`lib/clientError.ts`) runs in the browser, and the funnel next to this file
 * imports `node:crypto` (fingerprints) and pulls the Prisma client in lazily.
 * A client component importing the funnel to borrow one constant would drag both
 * into the browser bundle, so the ceilings live here — a module with no imports
 * at all — and the two ends read the same numbers instead of restating them.
 */

/** Field caps. Anything larger than one of these is a payload, not a message. */
export const ERROR_REPORT_LIMITS = {
  /** The whole JSON body the write route accepts. */
  bodyBytes: 4_096,
  message: 500,
  kind: 120,
  route: 300,
  digest: 200,
  stack: 2_000,
  requestId: 128,
  deploy: 64,
  env: 32,
} as const;

/** Trim, drop empties, cap. `null` means "this field is absent", never "". */
export function cap(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Apply the field caps to something that is not an `ErrorReportRow` yet — the
 * browser's payload (`lib/clientError.ts`) is the caller. Shared so the two ends
 * cannot disagree about how long a stack may be: the client trims to what the
 * server would accept anyway, and the server still trims again.
 */
export function capFields<T extends Record<string, unknown>>(
  fields: T,
  limits: Record<string, number>
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const limit = limits[key];
    out[key] = typeof limit === "number" ? (cap(value, limit) ?? undefined) : value;
  }
  return out as Partial<T>;
}
