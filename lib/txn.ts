/**
 * Bounded transaction retry (Phase 3 item 2). Retries ONLY recognized
 * serialization/deadlock failures (Postgres 40001/40P01, Prisma P2034);
 * everything else (including ledger-invariant throws and P2002) fails fast
 * Budget note: same-element work is already serialized by advisory locks, so
 * production retries are rare. Parallel test spikes on shared tables can
 * still draw SSI false positives — the budget below absorbs those while
 * staying bounded and logged (observable).
 */
export const TXN_MAX_ATTEMPTS = 10;

/**
 * Wall-clock budget for one `withTxnRetry` call (R15-7).
 *
 * The arithmetic the doc measured (2026-09-15): 13-way contention on one
 * element produced a 3.8 s settlement tail, and `TXN_MAX_ATTEMPTS = 10` with
 * the backoff below allows ten attempts of up to `MONEY_TX.timeout` each — a
 * ~250 s worst case inside routes that declare `maxDuration = 60`
 * (`app/api/checkout/route.ts`, `app/api/webhooks/stripe/route.ts`). Past that
 * ceiling the platform kills the function mid-flight, which is strictly worse
 * than failing fast: no JSON body, no `code`, no `x-request-id` — the exact
 * gap phase 11 and doc 15 §5.10 closed for *handled* failures — and an operator
 * cannot tell a kill from a deploy.
 *
 * So the loop now stops before the platform does and rethrows the last
 * retryable error. That is the error every caller already handles (checkout
 * answers 502 with a code, Stripe redelivers the webhook and `settlePayment`'s
 * duplicate guard lets the ERROR record be re-run), so the refusal needs no new
 * handling anywhere. 40 s leaves 20 s of the 60 s function budget for the work
 * around the transaction: the quote, the audit rows, the outbox rows a settle
 * enqueues, and the receipt.
 */
export const TXN_BUDGET_MS = 40_000;

export type TxnRetryOptions = {
  maxAttempts?: number;
  budgetMs?: number;
  /** Injectable clock (tests only): the budget is wall-clock, so a test that
   *  proved the refusal honestly would otherwise have to sleep for 40 s. */
  now?: () => number;
};

/**
 * Interactive-transaction budget for the money paths (checkout take, settle,
 * reverse). Prisma's defaults (2 s `maxWait`, 5 s `timeout`) are sized for a
 * warm local database; production runs the ledger against Neon (eu-west-2)
 * from Vercel (iad1), where the first query after an idle period pays a
 * compute-resume, and a cold settle can exceed 5 s mid-transaction. That
 * surfaces as P2028 ("Transaction already closed") on the provider's request —
 * the whole ledger write rolls back and the payment stays PENDING. The budget
 * below is generous enough to absorb that resume while still fitting inside
 * the 60 s function limit these routes declare.
 *
 * Not retried in-process: a timeout that fires after the server committed
 * would rematerialize as a duplicate apply, and stacking attempts would blow
 * the function budget. Redelivery is the retry mechanism instead (see
 * settlePayment's duplicate guard, which deliberately lets an ERROR record be
 * re-run).
 */
export const MONEY_TX = { isolationLevel: "Serializable", maxWait: 15_000, timeout: 25_000 } as const;

/**
 * How much of `TXN_BUDGET_MS` must still be unspent before another attempt may
 * start. A retry is refused only when *a whole attempt* no longer fits, so the
 * bound is the budget rather than the budget plus one attempt: with a 25 s
 * statement timeout and a 40 s budget, retries start only inside the first
 * 15 s. The retry storm this loop exists for still happens — the backoff is
 * sub-second per attempt, so eight or nine attempts fit in that window — while
 * the pathological tail cannot.
 */
const ATTEMPT_RESERVE_MS = MONEY_TX.timeout;

function isRetryableTxnError(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  if (code === "P2034") return true; // Prisma: write conflict / deadlock
  const pg = (e as { meta?: { code?: string } }).meta?.code;
  return pg === "40001" || pg === "40P01";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry `fn` on serialization/deadlock failures, inside a wall-clock budget
 * (R15-7). `attemptsOrOptions` stays a number for the call sites that already
 * pass an attempt cap; the object form exists for the budget and for the clock
 * the tests inject.
 */
export async function withTxnRetry<T>(
  fn: () => Promise<T>,
  attemptsOrOptions: number | TxnRetryOptions = TXN_MAX_ATTEMPTS
): Promise<T> {
  const opts: TxnRetryOptions =
    typeof attemptsOrOptions === "number" ? { maxAttempts: attemptsOrOptions } : attemptsOrOptions;
  const maxAttempts = opts.maxAttempts ?? TXN_MAX_ATTEMPTS;
  const budgetMs = opts.budgetMs ?? TXN_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt >= maxAttempts || !isRetryableTxnError(e)) throw e;
      const elapsed = now() - startedAt;
      if (elapsed + ATTEMPT_RESERVE_MS > budgetMs) {
        // Refused, not retried: the caller gets the error it already handles
        // rather than the platform killing the function mid-transaction.
        console.warn(
          JSON.stringify({ scope: "txn", msg: "budget-exhausted", attempt, elapsedMs: elapsed, budgetMs })
        );
        throw e;
      }
      console.warn(JSON.stringify({ scope: "txn", msg: "retryable-txn-error", attempt }));
      // Jittered backoff so contenders stop re-colliding on the same beat.
      await sleep(20 + Math.floor(Math.random() * 80) * attempt);
    }
  }
}
