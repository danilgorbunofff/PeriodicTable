/* Integration test — requires DATABASE_URL. Uses isolated test elements
   (9999 TEST1 / 9998 TEST2) created and cleaned up by the suite. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { applyStakeTx } from "./recompute";
import { reclaimFor } from "./pricing";

const prisma = new PrismaClient();
const T1 = 9999;
const T2 = 9998;
const hasDb = !!process.env.DATABASE_URL;

beforeAll(async () => {
  if (!hasDb) return;
  // clean any residue from earlier runs so amounts start at zero
  await prisma.stake.deleteMany({ where: { elementId: { in: [T1, T2] } } });
  await prisma.activityLog.deleteMany({ where: { elementSymbol: { in: ["TST1", "TST2"] } } });
  for (const [id, sym] of [
    [T1, "TST1"],
    [T2, "TST2"],
  ] as const) {
    await prisma.element.upsert({
      where: { id },
      create: { id, symbol: sym, name: `Test ${sym}`, atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
      update: {},
    });
  }
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
  // delete stakes first (FK), then test elements + startups; also clear any
  // residue from earlier failed runs
  await prisma.stake.deleteMany({ where: { elementId: { in: [T1, T2] } } });
  await prisma.stake.deleteMany({ where: { startup: { domain: { in: ["test-a.dev", "test-b.dev"] } }, elementId: { gte: 9000 } } });
  await prisma.activityLog.deleteMany({ where: { elementSymbol: { in: ["TST1", "TST2"] } } });
  await prisma.element.deleteMany({ where: { id: { in: [T1, T2] } } });
  await prisma.startup.deleteMany({ where: { domain: { in: ["test-a.dev", "test-b.dev"] } } });
  await prisma.$disconnect();
});

async function freshStartup(domain: string) {
  return prisma.startup.upsert({
    where: { domain },
    create: { domain, title: domain, pitch: "test", url: `https://${domain}`, logoUrl: "x" },
    update: {},
  });
}

describe.skipIf(!hasDb)("applyStakeTx — canonical flow", () => {
  it("A $20 → B $21 → A reclaims $2 → A is #1 at $22, dethrone detected", async () => {
    const A = (await freshStartup("test-a.dev")).id;
    const B = (await freshStartup("test-b.dev")).id;

    // A stakes $20 on empty tile
    const r1 = await applyStakeTx({ elementId: T1, startupId: A, addUsd: 20, kind: "join" });
    expect(r1.stake.isLeader).toBe(true);
    expect(r1.element.totalPoolUsd).toBe(20);

    // B takes lead at $21
    const r2 = await applyStakeTx({ elementId: T1, startupId: B, addUsd: 21, kind: "stake" });
    expect(r2.stake.isLeader).toBe(true);
    expect(r2.info.dethroned).toBe(true);
    expect(r2.info.oldLeader?.domain).toBe("test-a.dev");
    expect(r2.info.newLeader.domain).toBe("test-b.dev");

    // A's reclaim quote
    const quote = reclaimFor(21, 20);
    expect(quote).toBe(2);

    // A reclaims
    const r3 = await applyStakeTx({ elementId: T1, startupId: A, addUsd: quote, kind: "reclaim" });
    expect(r3.stake.amountUsd).toBe(22);
    expect(r3.stake.isLeader).toBe(true);
    expect(r3.info.dethroned).toBe(true);
    expect(r3.info.newLeader.domain).toBe("test-a.dev");
    expect(r3.element.totalPoolUsd).toBe(43);
    expect(r3.element.stakeCount).toBe(2);
  });
});

describe.skipIf(!hasDb)("applyStakeTx — self top-up while #1", () => {
  it("keeps crown, moat grows, no dethrone", async () => {
    const A = (await freshStartup("test-a.dev")).id;
    await applyStakeTx({ elementId: T2, startupId: A, addUsd: 10, kind: "join" });
    const r = await applyStakeTx({ elementId: T2, startupId: A, addUsd: 5, kind: "stake" });
    expect(r.stake.amountUsd).toBe(15);
    expect(r.stake.isLeader).toBe(true);
    expect(r.info.dethroned).toBe(false);
    expect(r.element.totalPoolUsd).toBe(15);
  });
});

describe.skipIf(!hasDb)("applyStakeTx — concurrent top-ups", () => {
  it("exactly one leader, pool = sum", async () => {
    const A = (await freshStartup("test-a.dev")).id;
    const B = (await freshStartup("test-b.dev")).id;
    const results = await Promise.all([
      applyStakeTx({ elementId: T2, startupId: A, addUsd: 30, kind: "stake" }),
      applyStakeTx({ elementId: T2, startupId: B, addUsd: 31, kind: "stake" }),
    ]);
    const el = await prisma.element.findUniqueOrThrow({ where: { id: T2 } });
    const stakes = await prisma.stake.findMany({ where: { elementId: T2 } });
    expect(stakes).toHaveLength(2);
    expect(el.totalPoolUsd).toBe(76); // 15 + 30 + 31
    const leaders = stakes.filter((s) => s.isLeader);
    expect(leaders).toHaveLength(1);
    expect(leaders[0].amountUsd).toBe(45); // A: 15 + 30 — highest total wins regardless of apply order
    const aTotal = results.find((r) => r.stake.domain === "test-a.dev")!;
    expect(aTotal.stake.amountUsd).toBe(45); // 15 + 30
  });
});
