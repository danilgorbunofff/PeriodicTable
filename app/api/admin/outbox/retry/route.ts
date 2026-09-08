import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminAuth } from "@/lib/jobs";
import { apiJson, apiError } from "@/lib/route";

export const dynamic = "force-dynamic";

/**
 * Operator retry for a terminally-failed outbox delivery (Phase 6 item 3):
 * resets attempts/backoff so the next worker pass redelivers. Refuses rows
 * that are already complete or never failed.
 */
export async function POST(req: NextRequest) {
  const denied = adminAuth(req);
  if (denied) return denied;
  let body: { dedupeKey?: string };
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body.", { status: 400 });
  }
  if (!body.dedupeKey) return apiError("dedupeKey is required.", { status: 400 });
  const row = await prisma.outboxEvent.findUnique({ where: { dedupeKey: body.dedupeKey } });
  if (!row) return apiError("Outbox event not found.", { status: 404, code: "NOT_FOUND" });
  if (row.completedAt) return apiError("Already delivered.", { status: 409, code: "ALREADY_DONE" });
  const reset = await prisma.outboxEvent.update({
    where: { dedupeKey: body.dedupeKey },
    data: { attempts: 0, nextAttemptAt: new Date(), lastError: null },
  });
  return apiJson({ ok: true, dedupeKey: reset.dedupeKey, type: reset.type });
}
