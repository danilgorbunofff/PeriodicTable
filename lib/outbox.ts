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
import { sendOutbidEmail, sendReceiptEmail, sendRefundEmail, sendReportEmail, sendWaitlistEmail } from "./email";
import { persistPreview } from "./screenshots";

export const OUTBOX_MAX_ATTEMPTS = 5;

export type OutboxType =
  | "RECEIPT_EMAIL"
  | "OUTBID_EMAIL"
  | "REFUND_EMAIL"
  | "REPORT_EMAIL"
  | "WAITLIST_EMAIL"
  | "PREVIEW_GENERATE"
  | "STAKE_ANALYTICS";

export type ReceiptPayload = {
  to: string;
  unsubToken: string;
  elementSymbol: string;
  elementName: string;
  amountUsd: number;
  rank: number;
  domain: string;
  /** R09-2: set when the take quote had lapsed before settlement. */
  lapsedTakeTotal?: number | null;
};

/** R08-2: the buyer's notice that their payment was reversed. Separate type
 * from RECEIPT_EMAIL because it is a different document, not a different
 * wording of the same one — a refund is not a receipt. */
export type RefundPayload = {
  to: string;
  unsubToken: string;
  elementSymbol: string;
  elementName: string;
  amountUsd: number;
  domain: string;
  providerRef: string | null;
};

export type OutbidPayload = {
  to: string;
  unsubToken: string;
  elementSymbol: string;
  victimDomain: string;
  victimTotal: number;
  winnerDomain: string;
  winnerAmount: number;
};

export type PreviewPayload = { startupId: string; url: string };
export type AnalyticsPayload = { paymentId: string; elementSymbol: string; amountUsd: number; kind: string };
/** R05-7 intake mail: the operator report notice and the waitlist confirmation. */
export type ReportEmailPayload = {
  to: string;
  id: string;
  domain: string | null;
  stakeId: string | null;
  reason: string;
  createdAt: string;
};
export type WaitlistEmailPayload = { to: string; domain: string | null; source: string };

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
    case "REFUND_EMAIL":
      await sendRefundEmail(payload as unknown as RefundPayload);
      return;
    case "REPORT_EMAIL": {
      const p = payload as unknown as ReportEmailPayload;
      await sendReportEmail({ ...p, createdAt: new Date(p.createdAt) });
      return;
    }
    case "WAITLIST_EMAIL":
      await sendWaitlistEmail(payload as unknown as WaitlistEmailPayload);
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
export async function claimDueOutbox(
  limit: number,
  leaseMs = 5 * 60_000,
  types?: OutboxType[]
): Promise<{ id: string }[]> {
  // "type" is cast to text so the parameterised list works whether the column
  // is a Postgres enum or a plain string.
  const typeFilter = types?.length ? Prisma.sql`AND "type"::text IN (${Prisma.join(types)})` : Prisma.empty;
  return prisma.$queryRaw<{ id: string }[]>`
    UPDATE "OutboxEvent" SET "nextAttemptAt" = NOW() + (${leaseMs} * INTERVAL '1 millisecond')
    WHERE id IN (
      SELECT id FROM "OutboxEvent"
      WHERE "completedAt" IS NULL AND "nextAttemptAt" <= NOW() AND attempts < ${OUTBOX_MAX_ATTEMPTS}
        ${typeFilter}
      ORDER BY "nextAttemptAt" ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
}

/** Process due events (bounded). Returns {completed, failed}. Never throws.
 * Claims first so the inline post-settle drain honours the same lease as the
 * job worker: reading without claiming would let a row this drain is holding
 * be delivered a second time by a worker that claims it mid-flight. */
export async function drainDue(limit = 10, types?: OutboxType[]): Promise<{ completed: number; failed: number }> {
  let completed = 0;
  let failed = 0;
  try {
    const claimed = await claimDueOutbox(limit, undefined, types);
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

/**
 * Await a drain, but never longer than `budgetMs`.
 *
 * The inline post-settle path MUST wait for delivery: a fire-and-forget drain
 * is killed the moment the serverless response is flushed, which left the
 * receipt/outbid mail sitting on its 5-minute claim lease until some later
 * external tick picked it up. Bounded so a slow delivery cannot stall the
 * webhook response — rows unfinished at the deadline keep their lease and are
 * retried by the authenticated worker, exactly as before.
 */
export async function drainDueWithin(
  budgetMs: number,
  limit = 10,
  types?: OutboxType[]
): Promise<{ completed: number; failed: number; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), budgetMs);
    });
    const outcome = await Promise.race([drainDue(limit, types), deadline]);
    if (outcome === "deadline") return { completed: 0, failed: 0, timedOut: true };
    return { ...outcome, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
