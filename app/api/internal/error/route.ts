import { NextRequest } from "next/server";
import { clientIp } from "@/lib/ip";
import { rateLimitAsync } from "@/lib/rateStore";
import { ERROR_REPORT_LIMITS, reportError } from "@/lib/errorReport";
import { apiError, apiJson, apiRoute } from "@/lib/route";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ POST: postError });

/**
 * The error sink's write end (Phase 18, R18-1, R18-10).
 *
 * `POST /api/internal/error` is the one route in the tree that is *deliberately*
 * public and writes a row, because the client error boundaries
 * (`app/error.tsx`, `app/global-error.tsx`) have no other way to reach a server:
 * a crash in a user's browser was previously reported to that user's own console
 * and to nobody else. The name says "internal" because it is not part of the
 * product's API — nothing in the app calls it on a visitor path, it is absent
 * from the client TypeScript surface, and its body shape is whatever
 * `lib/errorReport.ts` accepts.
 *
 * Being public, it treats its input as hostile the whole way down:
 *
 *  · the body is capped at `ERROR_REPORT_LIMITS.bodyBytes` before it is parsed,
 *    so a 10 MB "report" costs one read and no database work;
 *  · `reportError()` normalizes and truncates every field, drops unknown ones,
 *    and requires a `source` from a fixed vocabulary — the deploy and env stamps
 *    it *fills in* rather than trusting, so a stranger cannot file an incident
 *    against a deployment they are not part of;
 *  · it is rate limited per IP with a generous ceiling: a crash loop in one
 *    browser tab is already collapsed to one row per minute by the funnel, so
 *    this limit is for the other kind of caller.
 *
 * The answer is 202 with `{recorded, reason}` — never an id and never the row. A
 * client has no use for either, and echoing the stored row would make this an
 * arbitrary-read oracle for whatever the funnel kept. A refused report is a 400;
 * the boundary that sends client errors ignores the response either way, so the
 * only reader of that code is a test.
 */
async function postError(req: NextRequest) {
  const ip = clientIp(req.headers);
  if (!(await rateLimitAsync(`errors:${ip}`, 60, 60_000))) {
    return apiError("Too many requests. Try again later.", { status: 429, code: "RATE_LIMITED" });
  }

  const raw = await req.text();
  if (raw.length > ERROR_REPORT_LIMITS.bodyBytes) {
    return apiError("Report too large.", { status: 413, code: "PAYLOAD_TOO_LARGE" });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return apiError("Invalid JSON.", { status: 400, code: "BAD_REQUEST" });
  }

  // Never throws and never rejects: a sink failure is a `recorded: false`, and
  // the caller is a browser that is already showing an error page.
  const result = await reportError(body);
  if (result.reason === "invalid") {
    return apiError("A report needs a source from api|server|client|process and a message.", {
      status: 400,
      code: "BAD_REQUEST",
    });
  }
  return apiJson({ recorded: result.recorded, reason: result.reason ?? null }, { status: 202 });
}
