/**
 * Durable outbox (Phase 2 writes, Phase 6 processes at scale).
 *
 * Financial transactions enqueue notification/preview/analytics work with a
 * dedupe key IN the same transaction as the stake. Delivery runs AFTER commit
 * via drainDue() (best-effort inline for now; Phase 6 moves it to an
 * authenticated worker with bounded batches). A failed delivery never rolls
 * back a paid stake — the row stays due with exponential backoff.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { sendOutbidEmail, sendReceiptEmail } from "./email";
import { persistPreview } from "./screenshots";

export const OUTBOX_MAX_ATTEMPTS = 5;

export type OutboxType = "RECEIPT_EMAIL" | "OUTBID_EMAIL" | "PREVIEW_GENERATE" | "STAKE_ANALYTICS";

export type ReceiptPayload = {
  to: string;
  unsubToken: string;
  elementSymbol: string;
  elementName: string;
  amountUsd: number;
  rank: number;
  domain: string;
};

export type OutbidPayload = {
  to: string;
  unsubToken: string;
  elementSymbol: string;
  victimTotal: number;
  winnerDomain: string;
  winnerAmount: number;
};

export type PreviewPayload = { startupId: string; url: string };
export type AnalyticsPayload = { paymentId: string; elementSymbol: string; amountUsd: number; kind: string };

/** Idempotent enqueue (atomicity note): implemented as upsert, NOT
 * create-catch-P2002 — a unique violation inside an interactive transaction
 * poisons the whole Postgres transaction, so catching it would roll back the
 * payment + stake along with the duplicate. Upsert never raises. */
export async function enqueueOutbox(
  db: Prisma.TransactionClient,
  event: { type: OutboxType; payload: object; dedupeKey: string }
): Promise<void> {
  await db.outboxEvent.upsert({
    where: { dedupeKey: event.dedupeKey },
    create: { type: event.type, payload: event.payload, dedupeKey: event.dedupeKey },
    update: {},
  });
}

function backoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 30_000 * 2 ** attempts);
}

/** Attach a generated preview, but only while the listing is publicly visible.
 *
 * The Microlink probe takes seconds, so this write can land AFTER a moderator
 * hid the listing — an unconditional update would silently undo the takedown's
 * retention clear of `previewImgUrl`. Moderation wins: hidden/unlisted rows are
 * left untouched (0 rows updated) and the outbox row completes without retry. */
export function attachPreview(startupId: string, previewImgUrl: string) {
  return prisma.startup.updateMany({
    where: { id: startupId, moderationState: "VISIBLE" },
    data: { previewImgUrl },
  });
}

async function handleOne(type: string, payload: Record<string, unknown>): Promise<void> {
  switch (type) {
    case "RECEIPT_EMAIL":
      await sendReceiptEmail(payload as unknown as ReceiptPayload);
      return;
    case "OUTBID_EMAIL":
      await sendOutbidEmail(payload as unknown as OutbidPayload);
      return;
    case "PREVIEW_GENERATE": {
      const p = payload as unknown as PreviewPayload;
      await persistPreview({
        startupId: p.startupId,
        url: p.url,
        store: attachPreview,
      });
      return;
    }
    case "STAKE_ANALYTICS":
      // No analytics sink in MVP (Plausible is client-side); the row is the
      // durable record Phase 6 forwards. Marking complete = recorded.
      return;
    default:
      throw new Error(`unknown outbox type: ${type}`);
  }
}

/** Process a single row by id (shared by inline drain + job worker).
 * Returns "completed" | "failed" | "skipped" (already done/gone). Never throws. */
export async function processOutboxRowById(id: string): Promise<"completed" | "failed" | "skipped"> {
  const row = await prisma.outboxEvent.findUnique({ where: { id } });
  if (!row || row.completedAt || row.attempts >= OUTBOX_MAX_ATTEMPTS) return "skipped";
  try {
    await handleOne(row.type, row.payload as Record<string, unknown>);
    await prisma.outboxEvent.update({ where: { id: row.id }, data: { completedAt: new Date() } });
    return "completed";
  } catch (e) {
    await prisma.outboxEvent
      .update({
        where: { id: row.id },
        data: {
          attempts: row.attempts + 1,
          nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts)),
          lastError: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500),
        },
      })
      .catch(() => undefined);
    return "failed";
  }
}

/**
 * Atomically claim a bounded batch of due rows (Phase 6 worker item 2).
 * Single UPDATE...RETURNING with SKIP LOCKED — concurrent workers never
 * share a row. Claims push nextAttemptAt out by a lease (crashed workers
 * release automatically); failures still bump attempts + backoff.
 */
export async function claimDueOutbox(limit: number, leaseMs = 5 * 60_000): Promise<{ id: string }[]> {
  return prisma.$queryRaw<{ id: string }[]>`
    UPDATE "OutboxEvent" SET "nextAttemptAt" = NOW() + (${leaseMs} * INTERVAL '1 millisecond')
    WHERE id IN (
      SELECT id FROM "OutboxEvent"
      WHERE "completedAt" IS NULL AND "nextAttemptAt" <= NOW() AND attempts < ${OUTBOX_MAX_ATTEMPTS}
      ORDER BY "nextAttemptAt" ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
}

/** Process due events (bounded). Returns {completed, failed}. Never throws.
 * Claims first so the inline post-settle drain honours the same lease as the
 * job worker: reading without claiming would let a row this drain is holding
 * be delivered a second time by a worker that claims it mid-flight. */
export async function drainDue(limit = 10): Promise<{ completed: number; failed: number }> {
  let completed = 0;
  let failed = 0;
  try {
    const claimed = await claimDueOutbox(limit);
    for (const row of claimed) {
      const out = await processOutboxRowById(row.id);
      if (out === "completed") completed++;
      else if (out === "failed") failed++;
    }
  } catch (e) {
    console.error("outbox drain failed (non-blocking):", e);
  }
  return { completed, failed };
}
