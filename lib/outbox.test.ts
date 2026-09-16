/* Outbox row lifecycle (Phase 6 item 3) — local test DB only.
   The pieces that were only asserted indirectly elsewhere: attempts/backoff
   progression on failure, lastError persistence + truncation, the terminal
   attempts>=5 gate, claim/lease semantics, and the operator retry actually
   handing the row back to the worker.

   Fixture timing note: `nextAttemptAt` is chosen relative to whatever is
   already in the table (see earlySlot) rather than as a fixed offset, because
   the worker's claim query is FIFO and the suite leaves undrained settlePayment
   residue behind. A hardcoded "10 minutes ago" is not early enough. */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  OUTBOX_MAX_ATTEMPTS,
  claimDueOutbox,
  drainDue,
  failedMailHealth,
  processOutboxRowById,
} from "./outbox";
import { POST as outboxRetryPOST } from "../app/api/admin/outbox/retry/route";

const prisma = testPrisma();
const hasDb = hasTestDb;
const TAG = "p6-ob-";
/** Mail fixtures live under their own address so the EmailLog rows a send writes
 *  can be cleaned without touching any other file's. */
const MAIL_TO = `${TAG}receipt@example.com`;
let keyN = 0;
const key = () => `${TAG}${Date.now()}-${keyN++}`;

const ADMIN = "test-outbox-admin-token";
const penv = process.env as unknown as Record<string, string | undefined>;
const req = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => new NextRequest(`http://localhost${url}`, init);

/** A row that fails deterministically and offline: handleOne has no case for an
 * unknown type and throws before touching the network. */
const BAD_TYPE = "NO_SUCH_OUTBOX_TYPE";

/** The worker claims `ORDER BY nextAttemptAt ASC`, so a fixture only proves
 * anything if it sorts ahead of the rows already there. `rank` separates
 * fixtures that need a defined order among themselves. */
async function earlySlot(rank = 0): Promise<Date> {
  const oldest = await prisma.outboxEvent.findFirst({
    where: { completedAt: null, attempts: { lt: OUTBOX_MAX_ATTEMPTS } },
    orderBy: { nextAttemptAt: "asc" },
    select: { nextAttemptAt: true },
  });
  return new Date(
    (oldest?.nextAttemptAt.getTime() ?? Date.now()) - 60_000 - rank * 1_000,
  );
}

function mk(data: {
  type?: string;
  attempts?: number;
  nextAttemptAt?: Date;
  completedAt?: Date | null;
  lastError?: string | null;
  payload?: object;
}) {
  return prisma.outboxEvent.create({
    data: {
      type: data.type ?? "STAKE_ANALYTICS",
      dedupeKey: key(),
      payload: data.payload ?? {},
      attempts: data.attempts ?? 0,
      nextAttemptAt: data.nextAttemptAt ?? new Date(Date.now() - 600_000),
      completedAt: data.completedAt ?? null,
      lastError: data.lastError ?? null,
    },
  });
}

const secsUntil = (d: Date) => (d.getTime() - Date.now()) / 1000;

beforeAll(async () => {
  if (!hasDb) return;
  penv.ADMIN_TOKEN = ADMIN;
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
  delete penv.ADMIN_TOKEN;
  await prisma.auditLog.deleteMany({
    where: { action: "OUTBOX_RETRY", detail: { contains: TAG } },
  });
  await prisma.outboxEvent.deleteMany({
    where: { dedupeKey: { contains: TAG } },
  });
  await prisma.emailLog.deleteMany({ where: { dedupeKey: { contains: TAG } } });
  await prisma.emailLog.deleteMany({ where: { to: { contains: TAG } } });
  await prisma.emailAddress.deleteMany({ where: { email: { contains: TAG } } });
  await prisma.$disconnect();
});

describe("outbox contract", () => {
  it("caps delivery attempts at 5", () => {
    expect(OUTBOX_MAX_ATTEMPTS).toBe(5);
  });
});

describe.skipIf(!hasDb)("outbox row lifecycle", () => {
  it("a deliverable row completes once, and re-processing is a no-op", async () => {
    const row = await mk({ type: "STAKE_ANALYTICS" });
    expect(await processOutboxRowById(row.id)).toBe("completed");
    const done = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(done.completedAt).not.toBeNull();
    expect(done.attempts).toBe(0);

    // A concurrent worker that also picked this row up must not re-deliver it.
    expect(await processOutboxRowById(row.id)).toBe("skipped");
    const again = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(again.completedAt?.getTime()).toBe(done.completedAt?.getTime());
  });

  it("a failure records the reason and schedules a backoff instead of completing", async () => {
    const row = await mk({ type: BAD_TYPE });
    expect(await processOutboxRowById(row.id)).toBe("failed");
    const after = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.completedAt).toBeNull();
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain("unknown outbox type");
    // First retry is 30_000 * 2^0 = 30s out, not immediate.
    expect(secsUntil(after.nextAttemptAt)).toBeGreaterThan(28);
    expect(secsUntil(after.nextAttemptAt)).toBeLessThan(35);
  });

  it("doubles the backoff per attempt until the row is terminal", async () => {
    const expected = [30, 60, 120, 240]; // backoffMs(attempts) = 30_000 * 2^attempts
    for (let attempt = 0; attempt < expected.length; attempt++) {
      const row = await mk({ type: BAD_TYPE, attempts: attempt });
      expect(await processOutboxRowById(row.id)).toBe("failed");
      const after = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(after.attempts).toBe(attempt + 1);
      // nextAttemptAt is stamped a moment before we read it back, so the
      // observed delay sits a hair under the nominal backoff — never over it.
      const delay = secsUntil(after.nextAttemptAt);
      expect(delay).toBeGreaterThan(expected[attempt] - 2);
      expect(delay).toBeLessThan(expected[attempt] + 5);
    }
  });

  it("stops retrying at the attempt cap and leaves the row for an operator", async () => {
    const row = await mk({
      type: BAD_TYPE,
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError: "kept",
      nextAttemptAt: await earlySlot(),
    });
    // Never handed to the handler again — the failure reason must survive.
    expect(await processOutboxRowById(row.id)).toBe("skipped");
    const after = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(after.lastError).toBe("kept");
    expect(after.completedAt).toBeNull();

    // The worker's own query agrees: exhausted rows are not claimable however
    // far in the past their nextAttemptAt sits, so the batch never starves on one.
    const claimed = (await claimDueOutbox(1)).map((r) => r.id);
    expect(claimed).not.toContain(row.id);
  });

  it("truncates the stored error so a runaway message cannot fill the column", async () => {
    const row = await mk({ type: `x${"y".repeat(600)}` });
    expect(await processOutboxRowById(row.id)).toBe("failed");
    const after = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.lastError?.length).toBe(500);
    expect(after.lastError?.startsWith("unknown outbox type:")).toBe(true);
  });

  it("claims only due, unexhausted, incomplete rows — and leases what it takes", async () => {
    const due = await mk({
      type: "STAKE_ANALYTICS",
      nextAttemptAt: await earlySlot(),
    });
    const notYet = await mk({
      type: "STAKE_ANALYTICS",
      nextAttemptAt: new Date(Date.now() + 3_600_000),
    });
    const done = await mk({ type: "STAKE_ANALYTICS", completedAt: new Date() });
    const burned = await mk({ type: BAD_TYPE, attempts: OUTBOX_MAX_ATTEMPTS });

    const first = (await claimDueOutbox(1)).map((r) => r.id);
    expect(first).toEqual([due.id]);
    expect(first).not.toContain(notYet.id);
    expect(first).not.toContain(done.id);
    expect(first).not.toContain(burned.id);

    // Claiming is a lease: a second worker must not get the same row while the
    // first is still working, so a crash releases the row by expiry, not by luck.
    const second = (await claimDueOutbox(5)).map((r) => r.id);
    expect(second).not.toContain(due.id);
    const leased = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: due.id },
    });
    expect(secsUntil(leased.nextAttemptAt)).toBeGreaterThan(60);
    expect(leased.attempts).toBe(0);
    expect(leased.completedAt).toBeNull();
  });

  it("bounds the claimed batch and keeps the inline drain on the claim predicate", async () => {
    expect((await claimDueOutbox(2)).length).toBeLessThanOrEqual(2);
    // drainDue is the inline post-commit path; with no rows in scope it must
    // report an idle pass rather than throwing.
    expect(await drainDue(0)).toEqual({ completed: 0, failed: 0, errors: 0 });

    // The inline drain runs alongside the job worker and must share the worker's
    // claim predicate: an exhausted row stays parked, and a live row behind it
    // still runs.
    const base = await earlySlot();
    const burned = await mk({
      type: BAD_TYPE,
      attempts: OUTBOX_MAX_ATTEMPTS,
      nextAttemptAt: new Date(base.getTime() - 1000),
    });
    const live = await mk({ type: "STAKE_ANALYTICS", nextAttemptAt: base });

    expect(await drainDue(1)).toEqual({ completed: 1, failed: 0, errors: 0 });
    const ranLive = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: live.id },
    });
    expect(ranLive.completedAt).not.toBeNull();
    const parked = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: burned.id },
    });
    expect(parked.completedAt).toBeNull();
    expect(parked.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
  });

  it("operator retry clears the terminal state so the worker picks the row up again", async () => {
    const row = await mk({
      type: BAD_TYPE,
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError: "exhausted",
    });
    expect((await claimDueOutbox(1)).map((r) => r.id)).not.toContain(row.id);

    const res = await outboxRetryPOST(
      req("/api/admin/outbox/retry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${ADMIN}`,
        },
        body: JSON.stringify({ dedupeKey: row.dedupeKey }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { type?: string }).toMatchObject({
      ok: true,
      type: BAD_TYPE,
    });

    // The reset must satisfy the worker's own claim predicate: incomplete,
    // under the attempt cap, and due — those three are the whole gate.
    const reset = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(reset.attempts).toBe(0);
    expect(reset.lastError).toBeNull();
    expect(reset.completedAt).toBeNull();
    expect(reset.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    // And it is genuinely live again: the handler runs instead of short-circuiting.
    expect(await processOutboxRowById(row.id)).toBe("failed");
  });

  it("operator retry rejects a missing key and an unknown one", async () => {
    const post = (body: object) =>
      outboxRetryPOST(
        req("/api/admin/outbox/retry", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${ADMIN}`,
          },
          body: JSON.stringify(body),
        }),
      );
    expect((await post({})).status).toBe(400);
    expect((await post({ dedupeKey: `${TAG}does-not-exist` })).status).toBe(
      404,
    );
  });

  /* R10-1, the bug's own signature: a row stamped complete with `attempts === 0`
     — nothing ever failed it — while the log holds the provider's refusal. That
     pair is what the operator retries; sending the mail twice would be worse than
     not at all, which is why the "delivered" direction is asserted too. */
  const receiptPayload = () => ({
    to: MAIL_TO,
    elementSymbol: "TST1",
    elementName: "Test One",
    amountUsd: 7,
    rank: 1,
    domain: "p6-ob.dev",
  });
  const postRetry = (dedupeKey: string, operator?: string) =>
    outboxRetryPOST(
      req("/api/admin/outbox/retry", {
        method: "POST",
        // Spelled out rather than interpolated: this suite's copy of the header
        // must read exactly like the ones above it.
        headers: {
          "Content-Type": "application/json",
          authorization: "Bearer " + ADMIN,
        },
        body: JSON.stringify(operator ? { dedupeKey, operator } : { dedupeKey }),
      }),
    );

  /* R14-9: this is the one privileged action whose effect is that mail goes out
     — a leaked ADMIN_TOKEN could otherwise use it to resend receipts with nothing
     in the trail to show it happened. The audit row is written after the reset, so
     a refusal records no retry that did not occur. */
  it("audits the retry with the operator's name, and nothing on a refusal", async () => {
    const retries = () => prisma.auditLog.count({ where: { action: "OUTBOX_RETRY" } });
    const before = await retries();
    const row = await mk({ attempts: OUTBOX_MAX_ATTEMPTS, lastError: "exhausted" });

    expect((await postRetry(row.dedupeKey, "dana@ops.test")).status).toBe(200);
    expect(await retries()).toBe(before + 1);
    const written = await prisma.auditLog.findFirstOrThrow({
      where: { action: "OUTBOX_RETRY" },
      orderBy: { createdAt: "desc" },
    });
    expect(written).toMatchObject({ actorType: "operator", actorRef: "dana@ops.test" });
    // The key is what an operator greps for, so it leads the detail; the type
    // follows because a queue row with no type is not actionable.
    expect(written.detail).toBe(`${row.dedupeKey} ${row.type}`);

    // A caller who sends no name is still recorded as the operator surface.
    const second = await mk({ attempts: OUTBOX_MAX_ATTEMPTS, lastError: "exhausted" });
    expect((await postRetry(second.dedupeKey)).status).toBe(200);
    const unnamed = await prisma.auditLog.findFirstOrThrow({
      where: { action: "OUTBOX_RETRY" },
      orderBy: { createdAt: "desc" },
    });
    expect(unnamed.actorRef).toBe("operator");

    // Both refusals: a key that does not exist, and a row the log calls sent.
    const delivered = await mk({ type: "RECEIPT_EMAIL", payload: receiptPayload(), completedAt: new Date() });
    await prisma.emailLog.create({
      data: { to: MAIL_TO, template: "receipt", status: "sent", dedupeKey: delivered.dedupeKey },
    });
    expect((await postRetry(`${TAG}no-such-key`)).status).toBe(404);
    expect((await postRetry(delivered.dedupeKey)).status).toBe(409);
    expect(await retries()).toBe(before + 2);
  });

  /* R17-6: the same precedence the two moderation routes use. A named token is
     a fact about the credential; the body's `operator` is a claim about the
     caller — so when the deployment has names, the name wins. */
  it("records the named token's holder over the name in the body", async () => {
    penv.ADMIN_TOKENS = "dana:tok-outbox-dana";
    try {
      const row = await mk({ attempts: OUTBOX_MAX_ATTEMPTS, lastError: "exhausted" });
      const res = await outboxRetryPOST(
        req("/api/admin/outbox/retry", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: "Bearer tok-outbox-dana",
          },
          body: JSON.stringify({ dedupeKey: row.dedupeKey, operator: "someone-else" }),
        }),
      );
      expect(res.status).toBe(200);
      const written = await prisma.auditLog.findFirstOrThrow({
        where: { action: "OUTBOX_RETRY", detail: { contains: row.dedupeKey } },
      });
      expect(written).toMatchObject({ actorType: "operator", actorRef: "dana" });
    } finally {
      delete penv.ADMIN_TOKENS;
    }
  });

  it("a provider refusal fails its row, and the operator retry puts it back in flight", async () => {
    const row = await mk({
      type: "RECEIPT_EMAIL",
      payload: receiptPayload(),
      completedAt: new Date(),
    });
    const logged = await prisma.emailLog.create({
      data: {
        to: MAIL_TO,
        template: "receipt",
        status: "error",
        dedupeKey: row.dedupeKey,
        error: "resend 403: domain is not verified",
      },
    });

    // The log agrees that the mail never arrived, so the row is revived...
    expect((await postRetry(row.dedupeKey)).status).toBe(200);
    const revived = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(revived.completedAt).toBeNull(); // still completed ⇒ the worker skips it
    expect(revived.attempts).toBe(0);
    expect(revived.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());

    // ...and the retry is a retry: with the provider still refusing, the send
    // fails *the row* instead of being logged as an error and stamped complete.
    penv.RESEND_API_KEY = "re_test";
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response('{"message":"domain is not verified"}', { status: 403 }),
    );
    try {
      expect(await processOutboxRowById(row.id)).toBe("failed");
    } finally {
      vi.unstubAllGlobals();
      delete penv.RESEND_API_KEY;
    }
    const failed = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(failed.attempts).toBe(1);
    expect(failed.completedAt).toBeNull();
    expect(failed.lastError).toContain("not verified");

    const attempt = await prisma.emailLog.findFirstOrThrow({
      where: { dedupeKey: row.dedupeKey },
      orderBy: { createdAt: "desc" },
    });
    expect(attempt.id).not.toBe(logged.id);
    expect(attempt.status).toBe("error");
    expect(attempt.providerStatus).toBe(403); // the operator's next clue
  });

  it("does not revive a completed row the log calls delivered", async () => {
    // The other half of the gate: a delivered mail is also completed with zero
    // attempts, so without this check the retry would be a way to send a receipt
    // (or an outbid notice) twice.
    const delivered = await mk({
      type: "RECEIPT_EMAIL",
      payload: receiptPayload(),
      completedAt: new Date(),
    });
    await prisma.emailLog.create({
      data: {
        to: MAIL_TO,
        template: "receipt",
        status: "sent",
        dedupeKey: delivered.dedupeKey,
      },
    });

    const res = await postRetry(delivered.dedupeKey);
    expect(res.status).toBe(409);
    expect((await res.json()) as { code?: string }).toMatchObject({
      code: "ALREADY_DONE",
      delivery: "sent",
    });
    const untouched = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: delivered.id },
    });
    expect(untouched.completedAt).not.toBeNull();
  });

  it("names the log's verdict when it refuses a completed row (R13-1)", async () => {
    // The two refusals that look identical from the queue's side. A rehearsed
    // send — no RESEND_API_KEY, so `deliver()` returned `logged` and the row was
    // completed anyway — means the buyer got nothing while the operator asking
    // "did the retry actually go out?" is told only "already delivered". The
    // verdict is what makes that answer usable, and it must not be guessed from
    // the row.
    const rehearsed = await mk({
      type: "RECEIPT_EMAIL",
      payload: receiptPayload(),
      completedAt: new Date(),
    });
    await prisma.emailLog.create({
      data: {
        to: MAIL_TO,
        template: "receipt",
        status: "logged",
        dedupeKey: rehearsed.dedupeKey,
      },
    });
    const loggedRes = await postRetry(rehearsed.dedupeKey);
    expect(loggedRes.status).toBe(409);
    expect((await loggedRes.json()) as { code?: string }).toMatchObject({
      code: "ALREADY_DONE",
      delivery: "logged",
    });

    // A completed row whose key has no log row at all: also a refusal, also
    // named — this is the case that used to be indistinguishable from a
    // successful delivery.
    const silent = await mk({
      type: "RECEIPT_EMAIL",
      payload: receiptPayload(),
      completedAt: new Date(),
    });
    const silentRes = await postRetry(silent.dedupeKey);
    expect(silentRes.status).toBe(409);
    expect((await silentRes.json()) as { delivery?: string }).toMatchObject({
      delivery: "none",
    });

    // Neither refusal may disturb the row it refused.
    for (const id of [rehearsed.id, silent.id]) {
      const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
      expect(row.completedAt).not.toBeNull();
      expect(row.attempts).toBe(0);
    }
  });

  it("counts the mail failures nobody has resolved, and names the oldest", async () => {
    const before = await failedMailHealth();
    const stuck = `${TAG}stuck-${Date.now()}`;
    const newer = `${TAG}newer-${Date.now()}`;
    await prisma.emailLog.createMany({
      data: [
        // Dated to the epoch so the naming rule is deterministic: it is the
        // oldest *named* failure that gets handed to the operator.
        {
          to: MAIL_TO,
          template: "receipt",
          status: "error",
          dedupeKey: stuck,
          error: "resend 422: no mailbox",
          createdAt: new Date(0),
        },
        {
          to: MAIL_TO,
          template: "waitlist",
          status: "error",
          dedupeKey: newer,
          error: "socket hang up",
        },
      ],
    });

    const withFailures = await failedMailHealth();
    expect(withFailures.failed).toBe(before.failed + 2);
    expect(withFailures.oldestKey).toBe(stuck);

    // A failure stops being unresolved the moment something for that key was
    // delivered: the health number is about mail the buyer never received.
    await prisma.emailLog.create({
      data: {
        to: MAIL_TO,
        template: "receipt",
        status: "sent",
        dedupeKey: stuck,
      },
    });
    const recovered = await failedMailHealth();
    expect(recovered.failed).toBe(before.failed + 1);
    expect(recovered.oldestKey).not.toBe(stuck);
  });
});
