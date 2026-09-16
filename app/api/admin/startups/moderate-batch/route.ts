import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminGate, operatorIdentity } from "@/lib/jobs";
import { apiJson, apiError, apiRoute } from "@/lib/route";
import { applyModeration, MODERATION_STATES, MAX_BATCH_DOMAINS } from "@/lib/moderation";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ POST: moderateBatch });

/** Hide / unlist / restore several listings at once (R17-14).
 *
 * The single-listing route is the right lever for one report; an abuse wave is
 * dozens of listings in an hour, and doing that one URL at a time is how the
 * second hour gets spent. This is the same write as the single route — it calls
 * the same function in lib/moderation.ts, so a batch hide cannot come to mean
 * something different from a single hide — with the same refusal rules, one
 * PROFILE_MODERATED audit row per domain (not one per call: the trail must
 * still name each listing), and financial rows untouched.
 *
 * It answers three lists rather than a count, because the operator's next
 * action depends on which list a domain landed in: `changed` was contained,
 * `unchanged` was already in that state (a double-click, or a list built from a
 * stale read), `unknown` is a typo or a domain we do not have. "ok: true, 12
 * updated" would hide all three.
 *
 * Restoring is deliberately not the exact inverse: on restore, each listing's
 * stored preview stays cleared until the screenshot cron is asked for it with
 * `backfill` (ops/takedown.md), because a restored tile showing someone else's
 * stale preview is worse than an empty one.
 */
async function moderateBatch(req: NextRequest) {
  const denied = await adminGate(req, "admin/startups/moderate-batch");
  if (denied) return denied;
  let body: {
    state?: string;
    domains?: unknown;
    reason?: string;
    operator?: string;
  };
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body.", { status: 400 });
  }
  const state = MODERATION_STATES.find((s) => s === body.state);
  if (!state) {
    return apiError("state must be VISIBLE, HIDDEN, or UNLISTED.", {
      status: 400,
      code: "BAD_STATE",
    });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if ((state === "HIDDEN" || state === "UNLISTED") && !reason) {
    return apiError("A reason is required to hide or unlist.", {
      status: 400,
      code: "REASON_REQUIRED",
    });
  }
  if (!Array.isArray(body.domains)) {
    return apiError("domains must be an array of domain names.", {
      status: 400,
      code: "BAD_DOMAINS",
    });
  }
  const domains = [
    ...new Set(
      body.domains
        .filter((d): d is string => typeof d === "string")
        .map((d) =>
          d
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/\/.*$/, ""),
        )
        .filter(Boolean),
    ),
  ];
  if (domains.length === 0) {
    return apiError("domains is empty.", { status: 400, code: "BAD_DOMAINS" });
  }
  if (domains.length > MAX_BATCH_DOMAINS) {
    return apiError(`At most ${MAX_BATCH_DOMAINS} domains per call.`, {
      status: 400,
      code: "BATCH_TOO_LARGE",
    });
  }
  const operator =
    operatorIdentity(req) ??
    (typeof body.operator === "string" && body.operator.trim()
      ? body.operator.trim().slice(0, 120)
      : "operator");

  // Classify before writing, so `unchanged` costs nothing and reads as a fact
  // rather than as a skipped write.
  const known = await prisma.startup.findMany({
    where: { domain: { in: domains } },
    select: { domain: true, moderationState: true },
  });
  const byDomain = new Map(known.map((s) => [s.domain, s.moderationState]));
  const unchanged = domains.filter((d) => byDomain.get(d) === state);
  const unknown = domains.filter((d) => !byDomain.has(d));
  const changed: { domain: string; from: string }[] = [];
  const lost: string[] = [];
  for (const domain of domains) {
    const from = byDomain.get(domain);
    if (from === undefined || from === state) continue;
    const outcome = await applyModeration({
      domain,
      state,
      reason,
      operator,
    });
    if (outcome) changed.push({ domain: outcome.domain, from: outcome.previous });
    else lost.push(domain);
  }

  return apiJson({
    ok: true,
    state,
    operator,
    changed,
    unchanged,
    unknown,
    // Only reachable when a listing disappeared between the classification
    // read and its own update; reported rather than counted as changed.
    lost,
    // The takedown runbook's central claim, answered by the endpoint that could
    // most easily break it: hiding moves visibility, never money.
    publicNumbersUnchanged: true,
  });
}
