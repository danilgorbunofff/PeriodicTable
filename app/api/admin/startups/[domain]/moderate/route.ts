import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminGate, operatorIdentity } from "@/lib/jobs";
import { apiJson, apiError, apiRoute } from "@/lib/route";
import { applyModeration, MODERATION_STATES } from "@/lib/moderation";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: getModerationState, POST: moderateStartup });

/**
 * Hide / unlist / restore a listing (takedown runbook: contain first).
 * Financial history is NEVER touched — stakes, payments, and aggregates
 * stay; only public visibility changes. Hiding also clears the stored
 * preview (retention policy) and is fully audited with operator + reason.
 *
 * Phase 17: the write itself lives in lib/moderation.ts so the bulk lever
 * (`admin/startups/moderate-batch`) shares it, and `operator` defaults to the
 * name the presented token proves (R17-6) rather than to a body string.
 */
async function moderateStartup(req: NextRequest, { params }: { params: { domain: string } }) {
  const denied = await adminGate(req, "admin/startups/[domain]/moderate");
  if (denied) return denied;
  const domain = decodeURIComponent(params.domain).trim().toLowerCase();
  let body: { state?: string; reason?: string; operator?: string };
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body.", { status: 400 });
  }
  const state = MODERATION_STATES.find((s) => s === body.state);
  if (!state) {
    return apiError("state must be VISIBLE, HIDDEN, or UNLISTED.", { status: 400, code: "BAD_STATE" });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if ((state === "HIDDEN" || state === "UNLISTED") && !reason) {
    return apiError("A reason is required to hide or unlist.", { status: 400, code: "REASON_REQUIRED" });
  }
  const operator =
    operatorIdentity(req) ??
    (typeof body.operator === "string" && body.operator.trim()
      ? body.operator.trim().slice(0, 120)
      : "operator");
  const outcome = await applyModeration({
    domain,
    state,
    reason,
    operator,
  });
  if (!outcome) return apiError("Startup not found.", { status: 404, code: "NOT_FOUND" });
  return apiJson({ ok: true, domain: outcome.domain, state: outcome.state });
}

async function getModerationState(req: NextRequest, { params }: { params: { domain: string } }) {
  const denied = await adminGate(req, "admin/startups/[domain]/moderate");
  if (denied) return denied;
  const domain = decodeURIComponent(params.domain).trim().toLowerCase();
  const startup = await prisma.startup.findUnique({
    where: { domain },
    select: { domain: true, moderationState: true, moderatedBy: true, moderatedReason: true, moderatedAt: true, restoredAt: true },
  });
  if (!startup) return apiError("Startup not found.", { status: 404, code: "NOT_FOUND" });
  // R17-6: the caller's own identity, so an operator can tell a named token
  // from the shared one before acting — and know what the audit trail will say.
  return apiJson({ ...startup, operatorIdentity: operatorIdentity(req) });
}
