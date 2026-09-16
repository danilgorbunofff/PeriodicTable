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
import { describeError, logError, logWarn } from "./log";
import { prisma } from "./prisma";
import {
  mailDriver,
  sendOutbidEmail,
  sendReceiptEmail,
  sendRefundEmail,
  sendReportEmail,
  sendWaitlistEmail,
  type SendOutcome,
} from "./email";
import { persistPreview } from "./screenshots";
import { canStartRow } from "./jobBudget";

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
  elementSymbol: string;
  elementName: string;
  /** R10-4: the applied stake total — the number the rank came from. */
  amountUsd: number;
  rank: number;
  domain: string;
  /** R09-2: set when the take quote had lapsed before settlement. */
  lapsedTakeTotal?: number | null;
  /** R10-4: set when the payment was only an increment on a stake the buyer
   * already held (reclaim), so the charge and the resulting total are stated
   * as the two different facts they are. */
  topUpUsd?: number | null;
  /** R16-5: the provider reference the receipt prints so a payer can quote it
   * instead of their card. */
  reference?: string | null;
  /** R16-7: when the checkout recorded the consent this payment rests on, so
   * the receipt can name the revision that was actually accepted. */
  consentAt?: string | null;
};

/** R08-2: the buyer's notice that their payment was reversed. Separate type
 * from RECEIPT_EMAIL because it is a different document, not a different
 * wording of the same one — a refund is not a receipt. */
export type RefundPayload = {
  to: string;
  elementSymbol: string;
  elementName: string;
  amountUsd: number;
  domain: string;
  providerRef: string | null;
};

export type OutbidPayload = {
  to: string;
  elementSymbol: string;
  victimDomain: string;
  victimTotal: number;
  winnerDomain: string;
  winnerAmount: number;
};

export type PreviewPayload = { startupId: string; url: string };
export type AnalyticsPayload = {
  paymentId: string;
  elementSymbol: string;
  amountUsd: number;
  kind: string;
};
/** R05-7 intake mail: the operator report notice and the waitlist confirmation. */
export type ReportEmailPayload = {
  to: string;
  id: string;
  domain: string | null;
  stakeId: string | null;
  reason: string;
  createdAt: string;
};
export type WaitlistEmailPayload = {
  to: string;
  domain: string | null;
  source: string;
};

/** Idempotent enqueue (atomicity note): implemented as upsert, NOT
 * create-catch-P2002 — a unique violation inside an interactive transaction
 * poisons the whole Postgres transaction, so catching it would roll back the
 * payment + stake along with the duplicate. Upsert never raises. */
/**
 * Queue one unit of work, keyed.
 *
 * The key is the contract: it makes the queue idempotent, it is how a failed
 * send is named in the mail health report, and it is the handle an operator
 * retries. A blank key is therefore refused rather than stored — every keyless
 * row would collide on the same `dedupeKey` (the column is non-null and unique)
 * and quietly disappear into the first one, which is a lost delivery that no
 * surface can show.
 */
export async function enqueueOutbox(
  db: Prisma.TransactionClient,
  event: { type: OutboxType; payload: object; dedupeKey: string },
): Promise<void> {
  const dedupeKey = event.dedupeKey.trim();
  if (!dedupeKey) throw new Error(`${event.type} needs a dedupe key`);
  await db.outboxEvent.upsert({
    where: { dedupeKey },
    create: { type: event.type, payload: event.payload, dedupeKey },
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

/**
 * A mail that failed must fail its row (R10-1).
 *
 * The senders report the provider's answer rather than throwing, because a
 * direct caller wants the same record the log gets. The outbox is where that
 * answer becomes a retryable failure: `processOutboxRowById` stamps
 * `completedAt` only on success, so a completed row can only ever mean a
 * delivered one. A *suppressed* send is not a failure — the address asked us to
 * stop, so retrying would deliver nothing (R10-5).
 */
function assertDelivered(outcome: SendOutcome): void {
  if (outcome.status === "error") {
    throw new Error(
      outcome.error ?? `email delivery failed (${outcome.status})`,
    );
  }
}

async function handleOne(row: {
  type: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
}): Promise<void> {
  // The dedupe key travels into the log so a failed row and its attempts can be
  // reconciled afterwards (R10-11).
  const key = row.dedupeKey;
  switch (row.type) {
    case "RECEIPT_EMAIL": {
      const p = row.payload as unknown as ReceiptPayload;
      assertDelivered(await sendReceiptEmail({ ...p, dedupeKey: key }));
      return;
    }
    case "OUTBID_EMAIL": {
      const p = row.payload as unknown as OutbidPayload;
      assertDelivered(await sendOutbidEmail({ ...p, dedupeKey: key }));
      return;
    }
    case "REFUND_EMAIL": {
      const p = row.payload as unknown as RefundPayload;
      assertDelivered(await sendRefundEmail({ ...p, dedupeKey: key }));
      return;
    }
    case "REPORT_EMAIL": {
      const p = row.payload as unknown as ReportEmailPayload;
      assertDelivered(
        await sendReportEmail({
          ...p,
          createdAt: new Date(p.createdAt),
          dedupeKey: key,
        }),
      );
      return;
    }
    case "WAITLIST_EMAIL": {
      const p = row.payload as unknown as WaitlistEmailPayload;
      assertDelivered(await sendWaitlistEmail({ ...p, dedupeKey: key }));
      return;
    }
    case "PREVIEW_GENERATE": {
      const p = row.payload as unknown as PreviewPayload;
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
      throw new Error(`unknown outbox type: ${row.type}`);
  }
}

/**
 * The operator's view of mail that failed and was never delivered (R10-1).
 *
 * A failure is unresolved while the log holds an `error` row for a dedupe key
 * with no later successful row for the same key: the row an operator would
 * retry, named by that key. Deliberately bounded (the newest `limit` failures
 * are examined): this is a health number, not an audit export.
 */
export async function failedMailHealth(
  limit = 500,
): Promise<{ failed: number; oldestKey: string | null }> {
  const errors = await prisma.emailLog.findMany({
    where: { status: "error" },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { dedupeKey: true },
  });
  if (errors.length === 0) return { failed: 0, oldestKey: null };
  const keys = [
    ...new Set(errors.map((e) => e.dedupeKey).filter((k): k is string => !!k)),
  ];
  const recovered = keys.length
    ? await prisma.emailLog.findMany({
        where: { dedupeKey: { in: keys }, status: { in: ["sent", "logged"] } },
        select: { dedupeKey: true },
      })
    : [];
  const delivered = new Set(recovered.map((r) => r.dedupeKey));
  const unresolved = errors.filter(
    (e) => !e.dedupeKey || !delivered.has(e.dedupeKey),
  );
  // The list is newest-first, so the last entry is the oldest failure. A row
  // with no key cannot be named — only keys are actionable, so the oldest
  // *named* key is what the operator is given.
  const oldestKey =
    unresolved.filter((e) => !!e.dedupeKey).pop()?.dedupeKey ?? null;
  return { failed: unresolved.length, oldestKey };
}

/** Process a single row by id (shared by inline drain + job worker).
 * Returns "completed" | "failed" | "skipped" (already done/gone). Never throws. */
export async function processOutboxRowById(
  id: string,
): Promise<"completed" | "failed" | "skipped"> {
  const row = await prisma.outboxEvent.findUnique({ where: { id } });
  if (!row || row.completedAt || row.attempts >= OUTBOX_MAX_ATTEMPTS)
    return "skipped";
  try {
    await handleOne({
      type: row.type,
      payload: row.payload as Record<string, unknown>,
      dedupeKey: row.dedupeKey,
    });
    await prisma.outboxEvent.update({
      where: { id: row.id },
      data: { completedAt: new Date() },
    });
    return "completed";
  } catch (e) {
    await prisma.outboxEvent
      .update({
        where: { id: row.id },
        data: {
          attempts: row.attempts + 1,
          nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts)),
          lastError:
            e instanceof Error
              ? e.message.slice(0, 500)
              : String(e).slice(0, 500),
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
  types?: OutboxType[],
): Promise<{ id: string }[]> {
  // "type" is cast to text so the parameterised list works whether the column
  // is a Postgres enum or a plain string.
  const typeFilter = types?.length
    ? Prisma.sql`AND "type"::text IN (${Prisma.join(types)})`
    : Prisma.empty;
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

/** Process due events in bounded batches (R13-5). Returns per-batch counts plus
 * the number of rows still due, so a caller with a request budget — the
 * ten-minute tick, the daily Vercel cron — can finish a backlog in one
 * invocation instead of draining a single batch and waiting for a scheduler
 * that may be three hours late.
 *
 * Each iteration *claims*; it never re-uses an earlier claim. claimDueOutbox
 * pushes each claimed row's nextAttemptAt out by the lease, so a second claim
 * returns new rows or nothing — never a row this call is already holding.
 * Rows claimed but not started (the budget ran out) keep that lease and are
 * re-claimed when it expires: slower than starting them, never delivered twice.
 *
 * Nothing is swallowed (R13-6). The claim runs *inside* the try, so a claim that
 * fails outright is counted in `errors` instead of being indistinguishable from
 * an empty queue; `remaining` is measured after the loop from the same
 * predicate the claim uses, so "the queue emptied" and "the batch was short"
 * stop being the same answer; and `deferred` names rows this call started
 * paying for and could not start.
 */
export type OutboxBatchOutcome = {
  claimed: number;
  completed: number;
  failed: number;
  skipped: number;
  /** Claimed, left unstarted: no room left for another row's ceiling. */
  deferred: number;
  batches: number;
  /** Hard failures — a claim or a batch that threw. One per failed iteration. */
  errors: number;
  /** Rows still due after the loop, or null when the count itself failed. */
  remaining: number | null;
};

export async function drainInBatches(opts: {
  limit: number;
  types?: OutboxType[];
  budgetMs: number;
  /** Injection points for tests: a claim that throws must be *reported*. */
  claim?: typeof claimDueOutbox;
  now?: () => number;
}): Promise<OutboxBatchOutcome> {
  const claim = opts.claim ?? claimDueOutbox;
  const now = opts.now ?? Date.now;
  const out: OutboxBatchOutcome = {
    claimed: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    batches: 0,
    errors: 0,
    remaining: null,
  };
  const deadline = now() + opts.budgetMs;
  try {
    for (;;) {
      const batch = await claim(opts.limit, undefined, opts.types);
      out.batches++;
      out.claimed += batch.length;
      let started = 0;
      for (const row of batch) {
        if (!canStartRow(deadline, now())) break;
        started++;
        const result = await processOutboxRowById(row.id);
        if (result === "completed") out.completed++;
        else if (result === "failed") out.failed++;
        else out.skipped++;
      }
      out.deferred += batch.length - started;
      // A short batch means nothing else was claimable. A full one only means
      // "there may be more" — the next claim is what answers that question.
      if (batch.length < opts.limit) break;
      if (!canStartRow(deadline, now())) break;
    }
  } catch (e) {
    out.errors++;
    logError("outbox", "batch-failed", { error: describeError(e) });
  }
  out.remaining = await dueOutboxCount(opts.types).catch(() => null);
  return out;
}

/** Rows the next claim would return, by the claim's own predicate. Bounded work
 *  (`count` over the partial index the claim scans), so it is safe to answer on
 *  every worker call — that number is how a caller knows whether to loop. */
export async function dueOutboxCount(types?: OutboxType[]): Promise<number> {
  const typeFilter = types?.length
    ? Prisma.sql`AND "type"::text IN (${Prisma.join(types)})`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "OutboxEvent"
    WHERE "completedAt" IS NULL AND "nextAttemptAt" <= NOW() AND attempts < ${OUTBOX_MAX_ATTEMPTS}
      ${typeFilter}`;
  return rows[0]?.count ?? 0;
}

/* ------------------------------------------------------------------ *
 * The preview worker's queue (Phase 20, R20-7)
 * ------------------------------------------------------------------ */

/** The preview worker claims these and nothing else (R13-7). Named because two
 *  callers now drain them — the worker route and the composite daily run — and a
 *  queue filter written down twice is a filter that drifts. */
export const PREVIEW_TYPES = ["PREVIEW_GENERATE"] as const;

/** One preview batch, budgeted by the caller: `/api/jobs/screenshot` spends the
 *  whole work budget on it, `/api/jobs/daily` spends what is left after the two
 *  reports it also has to run (lib/jobBudget.ts documents the split). Same rows,
 *  same claim predicate, same response shape below — only the clock differs. */
export async function drainPreviews(opts: {
  limit: number;
  budgetMs: number;
}): Promise<OutboxBatchOutcome> {
  return drainInBatches({
    limit: opts.limit,
    types: [...PREVIEW_TYPES],
    budgetMs: opts.budgetMs,
  });
}

/** What a preview batch did, in the names the worker's response has used since
 *  Phase 6 (`checked` is what it *claimed*). Shared so the composite run cannot
 *  report a different vocabulary than the route it stands in for. */
export function previewCounts(out: OutboxBatchOutcome) {
  return {
    checked: out.claimed,
    updated: out.completed,
    failed: out.failed,
    deferred: out.deferred,
    batches: out.batches,
    remaining: out.remaining,
  };
}

export type OutboxHealth = {
  driver: "resend" | "logged";
  /** Undelivered rows a worker tick would claim right now. */
  due: number;
  /** Every undelivered row, whatever its backoff says (R18-8). `due` alone
   *  cannot answer "is the queue deep": a row at attempt 2 is invisible to it
   *  for up to five minutes, and `pending` is the number that only goes down by
   *  delivering something. Compared between consecutive ticks it is the queue's
   *  trend; `due: 0` with `pending: 40` means waiting, not empty. */
  pending: number;
  /** Undelivered rows by kind (R18-8): which *pipeline* is behind — receipts,
   *  outbid notices, preview renders — because the remedy differs per kind
   *  (ops/email.md vs a screenshot worker), and a mixed backlog's total says
   *  nothing about either. Exhausted rows are included; they are the ones a
   *  person must touch. */
  pendingByType: { type: string; count: number }[];
  /** Age of the oldest undelivered row in minutes (R18-8). `oldestDueHours` is
   *  the same row rounded to hours for a human report; this is the value an
   *  alarm compares against a threshold, where 90 minutes must not read as 2. */
  oldestPendingMinutes: number | null;
  /** Undelivered rows that have spent their attempts: the worker will never
   *  touch them again, so a person must. */
  exhausted: number;
  /** Mail that failed and was never superseded by a success (R10-1). */
  failed: number;
  /** The dedupe key of the oldest unresolved mail failure, or null. */
  oldestKey: string | null;
  /** How long the oldest undelivered row has been waiting, in hours. */
  oldestDueHours: number | null;
  oldestDueAt: string | null;
  /** When a row was last delivered. The liveness floor: with `due: 0` an old
   *  stamp means quiet, and with `due > 0` it means the pipeline is dead. */
  lastDeliveredAt: string | null;
};

/**
 * The one question an operator asks about the mail path (R17-13): is anything
 * stuck, and since when. Answered from `OutboxEvent` (the work queue) plus
 * `EmailLog`'s unresolved failures — two different kinds of stuck, and the
 * difference matters: `due` clears itself, `exhausted` and `failed` do not.
 *
 * `due` is counted by the claim's own predicate rather than by a second WHERE
 * clause, so the number cannot drift from what a worker would actually pick up;
 * `oldestDueHours` is measured from `createdAt` because that is how long the
 * customer has been waiting, not how long the backoff has been running.
 */
export async function outboxHealth(now: Date = new Date()): Promise<OutboxHealth> {
  const [due, exhausted, pending, byType, oldest, last, mail] = await Promise.all([
    dueOutboxCount(),
    prisma.outboxEvent.count({
      where: { completedAt: null, attempts: { gte: OUTBOX_MAX_ATTEMPTS } },
    }),
    prisma.outboxEvent.count({ where: { completedAt: null } }),
    prisma.outboxEvent.groupBy({
      by: ["type"],
      where: { completedAt: null },
      _count: { _all: true },
      orderBy: { _count: { type: "desc" } },
    }),
    prisma.outboxEvent.findFirst({
      where: { completedAt: null },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.outboxEvent.findFirst({
      where: { completedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    }),
    failedMailHealth(),
  ]);
  return {
    driver: mailDriver(),
    due,
    pending,
    pendingByType: byType.map((row) => ({ type: row.type, count: row._count._all })),
    oldestPendingMinutes: oldest
      ? Math.max(0, Math.round((now.getTime() - oldest.createdAt.getTime()) / 60_000))
      : null,
    exhausted,
    failed: mail.failed,
    oldestKey: mail.oldestKey,
    oldestDueHours: oldest
      ? Math.max(0, Math.round((now.getTime() - oldest.createdAt.getTime()) / 36_000) / 100)
      : null,
    oldestDueAt: oldest ? oldest.createdAt.toISOString() : null,
    lastDeliveredAt: last?.completedAt ? last.completedAt.toISOString() : null,
  };
}

/** Process one bounded batch of due events, inline. Returns
 *  {completed, failed, errors}. Never throws.
 * Claims first so the inline post-settle drain honours the same lease as the
 * job worker: reading without claiming would let a row this drain is holding
 * be delivered a second time by a worker that claims it mid-flight.
 *
 * One batch on purpose: the callers here (settle, waitlist, report) have just
 * enqueued the rows they are draining, so there is no backlog to loop over —
 * lib/jobsAndCron's `drainInBatches` is the backlog path. `errors` is 1 when the
 * batch could not be claimed at all, which used to be reported as a drain that
 * found nothing to do. */
export async function drainDue(
  limit = 10,
  types?: OutboxType[],
): Promise<{ completed: number; failed: number; errors: number }> {
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
    logWarn("outbox", "drain-failed", { error: describeError(e) });
    return { completed, failed, errors: 1 };
  }
  return { completed, failed, errors: 0 };
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
 *
 * `timedOut` and `errors` are separate on purpose: the first says the rows are
 * still moving, the second says the batch never started. A deadline reached
 * before a failure could be observed reports `errors: 0` and `timedOut: true`,
 * which is true — the drain is still running — and the caller's next tick
 * re-claims whatever it left.
 */
export async function drainDueWithin(
  budgetMs: number,
  limit = 10,
  types?: OutboxType[],
): Promise<{
  completed: number;
  failed: number;
  errors: number;
  timedOut: boolean;
}> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), budgetMs);
    });
    const outcome = await Promise.race([drainDue(limit, types), deadline]);
    if (outcome === "deadline")
      return { completed: 0, failed: 0, errors: 0, timedOut: true };
    return { ...outcome, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
