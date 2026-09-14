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

function isRetryableTxnError(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  if (code === "P2034") return true; // Prisma: write conflict / deadlock
  const pg = (e as { meta?: { code?: string } }).meta?.code;
  return pg === "40001" || pg === "40P01";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withTxnRetry<T>(fn: () => Promise<T>, maxAttempts = TXN_MAX_ATTEMPTS): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt >= maxAttempts || !isRetryableTxnError(e)) throw e;
      console.warn(JSON.stringify({ scope: "txn", msg: "retryable-txn-error", attempt }));
      // Jittered backoff so contenders stop re-colliding on the same beat.
      await sleep(20 + Math.floor(Math.random() * 80) * attempt);
    }
  }
}
