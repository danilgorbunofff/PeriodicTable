import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminAuth } from "@/lib/jobs";
import { apiJson, apiError } from "@/lib/route";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const STATES = ["VISIBLE", "HIDDEN", "UNLISTED"] as const;

/**
 * Hide / unlist / restore a listing (takedown runbook: contain first).
 * Financial history is NEVER touched — stakes, payments, and aggregates
 * stay; only public visibility changes. Hiding also clears the stored
 * preview (retention policy) and is fully audited with operator + reason.
 */
export async function POST(req: NextRequest, { params }: { params: { domain: string } }) {
  const denied = adminAuth(req);
  if (denied) return denied;
  const domain = decodeURIComponent(params.domain).trim().toLowerCase();
  let body: { state?: string; reason?: string; operator?: string };
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body.", { status: 400 });
  }
  if (!body.state || !(STATES as readonly string[]).includes(body.state)) {
    return apiError("state must be VISIBLE, HIDDEN, or UNLISTED.", { status: 400, code: "BAD_STATE" });
  }
  if ((body.state === "HIDDEN" || body.state === "UNLISTED") && !body.reason) {
    return apiError("A reason is required to hide or unlist.", { status: 400, code: "REASON_REQUIRED" });
  }
  const startup = await prisma.startup.findUnique({ where: { domain } });
  if (!startup) return apiError("Startup not found.", { status: 404, code: "NOT_FOUND" });
  const operator = typeof body.operator === "string" ? body.operator.slice(0, 120) : "operator";
  const now = new Date();
  const updated = await prisma.startup.update({
    where: { domain },
    data: {
      moderationState: body.state as (typeof STATES)[number],
      moderatedBy: body.state === "VISIBLE" ? startup.moderatedBy : operator,
      moderatedReason: body.state === "VISIBLE" ? startup.moderatedReason : String(body.reason ?? "").slice(0, 300),
      moderatedAt: body.state === "VISIBLE" ? startup.moderatedAt : now,
      restoredAt: body.state === "VISIBLE" ? now : null,
      ...(body.state === "HIDDEN" ? { previewImgUrl: null } : {}),
    },
  });
  await audit({
    action: "PROFILE_MODERATED",
    startupId: startup.id,
    actorType: "operator",
    actorRef: operator,
    detail: `${startup.moderationState} → ${updated.moderationState}: ${updated.moderatedReason ?? "restored"}`.slice(0, 300),
  });
  return apiJson({ ok: true, domain, state: updated.moderationState });
}

export async function GET(req: NextRequest, { params }: { params: { domain: string } }) {
  const denied = adminAuth(req);
  if (denied) return denied;
  const domain = decodeURIComponent(params.domain).trim().toLowerCase();
  const startup = await prisma.startup.findUnique({
    where: { domain },
    select: { domain: true, moderationState: true, moderatedBy: true, moderatedReason: true, moderatedAt: true, restoredAt: true },
  });
  if (!startup) return apiError("Startup not found.", { status: 404, code: "NOT_FOUND" });
  return apiJson(startup);
}
