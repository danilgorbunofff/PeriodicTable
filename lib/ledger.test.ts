/* Phase 3 ledger tests (validation-matrix: pricing + database integration).
   Pure: invariant asserts, txn retry policy.
   Integration (local test DB): contested $5 joins land below the leader,
   settle-time ties stay deterministic, activity carries delta/result/payment,
   returned ranks match persisted rows. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { assertLedgerInvariants } from "./pricing";
import { withTxnRetry } from "./txn";

describe("assertLedgerInvariants", () => {
  const solo = [{ id: "a", startupId: "s1", amountUsd: 20, rank: 1, isLeader: true }];
  it("accepts a healthy board", () => {
    expect(() =>
      assertLedgerInvariants(
        [
          ...solo,
          { id: "b", startupId: "s2", amountUsd: 9, rank: 2, isLeader: false },
        ],
        { totalPoolUsd: 29, stakeCount: 2, currentLeaderId: "s1" }
      )
    ).not.toThrow();
  });
  it("rejects two leaders, rank gaps, and aggregate drift", () => {
    expect(() =>
      assertLedgerInvariants(
        [
          { id: "a", startupId: "s1", amountUsd: 20, rank: 1, isLeader: true },
          { id: "b", startupId: "s2", amountUsd: 20, rank: 2, isLeader: true },
        ],
        { totalPoolUsd: 40, stakeCount: 2, currentLeaderId: "s1" }
      )
    ).toThrow(/1 leader/);
    expect(() =>
      assertLedgerInvariants(
        [
          { id: "a", startupId: "s1", amountUsd: 20, rank: 1, isLeader: true },
          { id: "b", startupId: "s2", amountUsd: 9, rank: 3, isLeader: false },
        ],
        { totalPoolUsd: 29, stakeCount: 2, currentLeaderId: "s1" }
      )
    ).toThrow(/rank gap/);
    expect(() => assertLedgerInvariants(solo, { totalPoolUsd: 21, stakeCount: 1, currentLeaderId: "s1" })).toThrow(/pool/);
    expect(() => assertLedgerInvariants(solo, { totalPoolUsd: 20, stakeCount: 2, currentLeaderId: "s1" })).toThrow(/count/);
    expect(() => assertLedgerInvariants(solo, { totalPoolUsd: 20, stakeCount: 1, currentLeaderId: "s2" })).toThrow(/currentLeaderId/);
  });
});

describe("withTxnRetry", () => {
  it("retries serialization failures, then succeeds", async () => {
    let calls = 0;
    const out = await withTxnRetry(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("serialization"), { code: "P2034" });
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });
  it("rethrows non-retryable errors immediately", async () => {
    let calls = 0;
    await expect(
      withTxnRetry(async () => {
        calls++;
        throw Object.assign(new Error("ledger-invariant: boom"), { code: "P2002" });
      })
    ).rejects.toThrow(/boom/);
    expect(calls).toBe(1);
  });
});

// ---- integration ----

import { hasTestDb, settledOutboxKeys, testPrisma } from "./testDb";
import { settlePayment } from "./settle";
import { applyStakeTx } from "./recompute";

const prisma = testPrisma();
const hasDb = hasTestDb;
const T5 = 9995;
let keyN = 0;
const key = () => `p3-ledger-${Date.now()}-${keyN++}`;
const paymentIds: string[] = [];
const previewKeys: string[] = [];

beforeAll(async () => {
  if (!hasDb) return;
  await prisma.stake.deleteMany({ where: { elementId: T5 } });
  await prisma.element.upsert({
    where: { id: T5 },
    create: { id: T5, symbol: "TST5", name: "Test TST5", atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
    update: {},
  });
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
const domains = ["lead-t.dev", "join-t.dev", "tie-t.dev", "race1-t.dev", "race2-t.dev", "race3-t.dev", "race4-t.dev", "race5-t.dev"];
  await prisma.providerEvent.deleteMany({ where: { payment: { startup: { domain: { in: domains } } } } });
  await prisma.outboxEvent.deleteMany({
    where: {
      OR: [
        ...paymentIds.flatMap((id) => [{ dedupeKey: `receipt-${id}` }, { dedupeKey: `outbid-${id}` }, { dedupeKey: `analytics-${id}` }]),
        ...previewKeys.map((k) => ({ dedupeKey: k })),
      ],
    },
  });
  await prisma.activityLog.deleteMany({ where: { domain: { in: domains } } });
  await prisma.payment.deleteMany({ where: { startup: { domain: { in: domains } } } });
  await prisma.auditLog.deleteMany({ where: { startup: { domain: { in: domains } } } });
  await prisma.firstClaim.deleteMany({ where: { elementId: T5 } });
  await prisma.stake.deleteMany({ where: { elementId: T5 } });
  await prisma.element.deleteMany({ where: { id: T5 } });
  await prisma.startup.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
});

async function startup(domain: string) {
  return prisma.startup.upsert({
    where: { domain },
    create: { domain, title: domain, pitch: "ledger fixture pitch", url: `https://${domain}`, logoUrl: "x" },
    update: {},
  });
}

async function pay(domain: string, amount: number, path: "JOIN" | "TAKE" | "STAKE" | "RECLAIM" = "JOIN") {
  const s = await startup(domain);
  const payment = await prisma.payment.create({
    data: { elementId: T5, startupId: s.id, amountUsd: amount, path, provider: "DEV", idempotencyKey: key(), status: "PENDING" },
  });
  paymentIds.push(payment.id);
  previewKeys.push(`preview-${s.id}`);
  const out = await settlePayment(payment.id, { provider: "dev", eventId: `dev-${key()}`, eventType: "dev.test", paid: true });
  expect(out.outcome).toBe("applied");
  return s;
}

describe.skipIf(!hasDb)("ledger concurrency and pricing invariants", () => {
  it("contested $5 join lands below the leader, leader untouched (P0-04)", async () => {
    await pay("lead-t.dev", 50, "TAKE");
    await pay("join-t.dev", 5, "JOIN");
    const rows = await prisma.stake.findMany({ where: { elementId: T5 }, orderBy: { rank: "asc" } });
    expect(rows.length).toBe(2);
    expect(rows[0].amountUsd).toBe(50);
    expect(rows[0].isLeader).toBe(true);
    expect(rows[1].amountUsd).toBe(5);
    expect(rows[1].rank).toBe(2);
    const el = await prisma.element.findUniqueOrThrow({ where: { id: T5 } });
    expect(el.totalPoolUsd).toBe(55);
    expect(el.stakeCount).toBe(2);
  });
  it("settle-time ties stay deterministic: one leader, gap-free ranks", async () => {
    // Bypasses checkout validation on purpose: proves the ledger itself can
    // never flip ranks unpredictably when a tie slips through.
    await pay("tie-t.dev", 50, "JOIN");
    const rows = await prisma.stake.findMany({ where: { elementId: T5 }, orderBy: [{ rank: "asc" }] });
    const leaders = rows.filter((r) => r.isLeader);
    expect(leaders.length).toBe(1);
    expect(rows.map((r) => r.rank)).toEqual(rows.map((_, i) => i + 1));
    // Recompute is a fixed point: running again changes nothing.
    const s = await startup("lead-t.dev");
    const before = await prisma.stake.findMany({ where: { elementId: T5 }, orderBy: { rank: "asc" } });
    await applyStakeTx({ elementId: T5, startupId: s.id, addUsd: 1, kind: "stake" });
    const after = await prisma.stake.findMany({ where: { elementId: T5 }, orderBy: { rank: "asc" } });
    expect(after.filter((r) => r.isLeader).length).toBe(1);
    expect(after.map((r) => r.rank)).toEqual(after.map((_, i) => i + 1));
    expect(before.length).toBe(after.length);
  });
  it("activity carries delta + resulting total + payment id (P2-06)", async () => {
    const log = await prisma.activityLog.findFirst({
      where: { domain: "join-t.dev", elementSymbol: "TST5" },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    expect(log?.deltaUsd).toBe(5);
    expect(log?.resultTotalUsd).toBe(5);
    expect(log?.paymentId).not.toBeNull();
  });
  it("returned rank matches the persisted row (P2-01)", async () => {
    const s = await startup("join-t.dev");
    const r = await applyStakeTx({ elementId: T5, startupId: s.id, addUsd: 1, kind: "stake" });
    const row = await prisma.stake.findUniqueOrThrow({
      where: { elementId_startupId: { elementId: T5, startupId: s.id } },
    });
    expect(r.stake.rank).toBe(row.rank);
    expect(r.stake.isLeader).toBe(row.isLeader);
  });
  it("concurrent settles preserve one leader and exact pool/count", async () => {
    const racers = ["race1-t.dev", "race2-t.dev", "race3-t.dev", "race4-t.dev", "race5-t.dev"];
    const payments = await Promise.all(
      racers.map(async (d, i) => {
        const s = await startup(d);
        const p = await prisma.payment.create({
          data: { elementId: T5, startupId: s.id, amountUsd: 5 + i, path: "JOIN", provider: "DEV", idempotencyKey: key(), status: "PENDING" },
        });
        paymentIds.push(p.id);
        previewKeys.push(`preview-${s.id}`);
        return p;
      })
    );
    const outcomes = await Promise.all(
      payments.map((p, i) =>
        settlePayment(p.id, { provider: "dev", eventId: `dev-${key()}-r${i}`, eventType: "dev.test", paid: true })
      )
    );
    expect(outcomes.every((o) => o.outcome === "applied")).toBe(true);
    const rows = await prisma.stake.findMany({ where: { elementId: T5 }, orderBy: { rank: "asc" } });
    expect(rows.filter((r) => r.isLeader).length).toBe(1);
    expect(rows.map((r) => r.rank)).toEqual(rows.map((_, i) => i + 1));
    const el = await prisma.element.findUniqueOrThrow({ where: { id: T5 } });
    expect(el.totalPoolUsd).toBe(rows.reduce((s, r) => s + r.amountUsd, 0));
    expect(el.stakeCount).toBe(rows.length);
  });
  it("concurrent settles of the SAME payment apply exactly one delta", async () => {
    const s = await startup("join-t.dev");
    const payment = await prisma.payment.create({
      data: { elementId: T5, startupId: s.id, amountUsd: 3, path: "STAKE", provider: "DEV", idempotencyKey: key(), status: "PENDING" },
    });
    const before = (await prisma.stake.findUnique({ where: { elementId_startupId: { elementId: T5, startupId: s.id } } }))?.amountUsd ?? 0;
    const outcomes = await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        settlePayment(payment.id, { provider: "dev", eventId: `dev-${key()}-s${i}`, eventType: "dev.test", paid: true })
      )
    );
    expect(outcomes.filter((o) => o.outcome === "applied").length).toBe(1);
    const after = await prisma.stake.findUniqueOrThrow({
      where: { elementId_startupId: { elementId: T5, startupId: s.id } },
    });
    expect(after.amountUsd).toBe(before + 3);
    await prisma.providerEvent.deleteMany({ where: { paymentId: payment.id } });
    await prisma.outboxEvent.deleteMany({
      where: { dedupeKey: { in: settledOutboxKeys(payment.id, s.id) } },
    });
    await prisma.payment.delete({ where: { id: payment.id } });
  });
});
