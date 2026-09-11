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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import {
  OUTBOX_MAX_ATTEMPTS,
  claimDueOutbox,
  drainDue,
  processOutboxRowById,
} from "./outbox";
import { POST as outboxRetryPOST } from "../app/api/admin/outbox/retry/route";

const prisma = testPrisma();
const hasDb = hasTestDb;
const TAG = "p6-ob-";
let keyN = 0;
const key = () => `${TAG}${Date.now()}-${keyN++}`;

const ADMIN = "test-outbox-admin-token";
const penv = process.env as unknown as Record<string, string | undefined>;
const req = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  new NextRequest(`http://localhost${url}`, init);

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
  return new Date((oldest?.nextAttemptAt.getTime() ?? Date.now()) - 60_000 - rank * 1_000);
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
  await prisma.outboxEvent.deleteMany({ where: { dedupeKey: { contains: TAG } } });
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
    const done = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(done.completedAt).not.toBeNull();
    expect(done.attempts).toBe(0);

    // A concurrent worker that also picked this row up must not re-deliver it.
    expect(await processOutboxRowById(row.id)).toBe("skipped");
    const again = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(again.completedAt?.getTime()).toBe(done.completedAt?.getTime());
  });

  it("a failure records the reason and schedules a backoff instead of completing", async () => {
    const row = await mk({ type: BAD_TYPE });
    expect(await processOutboxRowById(row.id)).toBe("failed");
    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
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
      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
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
    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
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
    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.lastError?.length).toBe(500);
    expect(after.lastError?.startsWith("unknown outbox type:")).toBe(true);
  });

  it("claims only due, unexhausted, incomplete rows — and leases what it takes", async () => {
    const due = await mk({ type: "STAKE_ANALYTICS", nextAttemptAt: await earlySlot() });
    const notYet = await mk({ type: "STAKE_ANALYTICS", nextAttemptAt: new Date(Date.now() + 3_600_000) });
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
    const leased = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: due.id } });
    expect(secsUntil(leased.nextAttemptAt)).toBeGreaterThan(60);
    expect(leased.attempts).toBe(0);
    expect(leased.completedAt).toBeNull();
  });

  it("bounds the claimed batch and keeps the inline drain on the claim predicate", async () => {
    expect((await claimDueOutbox(2)).length).toBeLessThanOrEqual(2);
    // drainDue is the inline post-commit path; with no rows in scope it must
    // report an idle pass rather than throwing.
    expect(await drainDue(0)).toEqual({ completed: 0, failed: 0 });

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

    expect(await drainDue(1)).toEqual({ completed: 1, failed: 0 });
    const ranLive = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: live.id } });
    expect(ranLive.completedAt).not.toBeNull();
    const parked = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: burned.id } });
    expect(parked.completedAt).toBeNull();
    expect(parked.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
  });

  it("operator retry clears the terminal state so the worker picks the row up again", async () => {
    const row = await mk({ type: BAD_TYPE, attempts: OUTBOX_MAX_ATTEMPTS, lastError: "exhausted" });
    expect((await claimDueOutbox(1)).map((r) => r.id)).not.toContain(row.id);

    const res = await outboxRetryPOST(
      req("/api/admin/outbox/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify({ dedupeKey: row.dedupeKey }),
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { type?: string }).toMatchObject({ ok: true, type: BAD_TYPE });

    // The reset must satisfy the worker's own claim predicate: incomplete,
    // under the attempt cap, and due — those three are the whole gate.
    const reset = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
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
          headers: { "Content-Type": "application/json", authorization: `Bearer ${ADMIN}` },
          body: JSON.stringify(body),
        })
      );
    expect((await post({})).status).toBe(400);
    expect((await post({ dedupeKey: `${TAG}does-not-exist` })).status).toBe(404);
  });
});
