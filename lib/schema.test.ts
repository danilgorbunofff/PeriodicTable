/* R12-6: the migrated database's own shape, asserted after `migrate deploy`.

   These two guarantees — the partial unique index from 0001 and the CHECK
   constraints from 0009 — cannot be expressed in `schema.prisma`, so no other
   test in the suite can notice their absence: a database built from the schema
   instead of the migration set (`prisma db push`) would pass everything else and
   quietly lose the take-lead race guard and every money guard. */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Free element id: 9985-9999 belong to other suites. */
const T = 9983;
const DOMAIN = "r12-6-schema.test";
const PAYMENT_KEY = "r12-6-schema-probe";

const CHECK_CONSTRAINTS: Record<string, string> = {
  Stake_amountUsd_nonnegative: "Stake",
  Payment_amountUsd_nonnegative: "Payment",
  Payment_providerAmount_nonnegative: "Payment",
  Payment_refundedAt_matches_status: "Payment",
  Element_totalPoolUsd_nonnegative: "Element",
  Element_stakeCount_nonnegative: "Element",
};

describe.skipIf(!hasTestDb)("migrated database shape (R12-6)", () => {
  const prisma = testPrisma();

  beforeAll(async () => {
    await prisma.element.upsert({
      where: { id: T },
      create: { id: T, symbol: "TSP6", name: "Schema probe", atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
      update: {},
    });
    await prisma.startup.upsert({
      where: { domain: DOMAIN },
      create: { domain: DOMAIN, title: "Schema probe", pitch: "constraint probes", url: `https://${DOMAIN}`, logoUrl: "x" },
      update: {},
    });
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { idempotencyKey: PAYMENT_KEY } });
    await prisma.stake.deleteMany({ where: { elementId: T } });
    await prisma.startup.deleteMany({ where: { domain: DOMAIN } });
    await prisma.element.deleteMany({ where: { id: T } });
    await prisma.$disconnect();
  });

  it("keeps the hand-written partial unique index the checkout race depends on", async () => {
    const rows = await prisma.$queryRaw<{ tablename: string; indexdef: string }[]>`
      SELECT tablename, indexdef FROM pg_indexes
      WHERE indexname = 'ClaimReservation_elementId_active_key'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].tablename).toBe("ClaimReservation");
    // Both halves matter: UNIQUE is the race guard, the WHERE clause is what lets
    // the next quote be taken once the previous reservation is released.
    expect(rows[0].indexdef).toMatch(/UNIQUE/);
    expect(rows[0].indexdef).toMatch(/WHERE .*active/);
  });

  it("keeps every 0009 CHECK constraint, validated", async () => {
    const rows = await prisma.$queryRaw<{ conname: string; relname: string; definition: string }[]>`
      SELECT c.conname, t.relname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.contype = 'c' AND t.relnamespace = 'public'::regnamespace`;
    const found = new Map(rows.map((r) => [r.conname, r]));
    for (const [name, table] of Object.entries(CHECK_CONSTRAINTS)) {
      expect(found.get(name)?.relname, `${name} is missing`).toBe(table);
      // A CHECK that was dropped and re-added as NOT VALID still exists in
      // pg_constraint while enforcing nothing for the rows already present.
      expect(found.get(name)?.definition).not.toMatch(/NOT VALID/);
    }
  });

  it("proves the constraints bite, not just that they exist", async () => {
    const startup = await prisma.startup.findUniqueOrThrow({ where: { domain: DOMAIN } });

    // Each probe is one statement, so its own failure rolls the statement back
    // and leaves the fixture rows intact for the next one. The messages are
    // Postgres's, which name the constraint that refused the write.
    await expect(prisma.element.update({ where: { id: T }, data: { totalPoolUsd: -1 } })).rejects.toThrow(
      /Element_totalPoolUsd_nonnegative/,
    );
    await expect(prisma.element.update({ where: { id: T }, data: { stakeCount: -1 } })).rejects.toThrow(
      /Element_stakeCount_nonnegative/,
    );
    await expect(
      prisma.stake.create({ data: { elementId: T, startupId: startup.id, amountUsd: -5, rank: 1 } }),
    ).rejects.toThrow(/Stake_amountUsd_nonnegative/);
    await expect(
      prisma.payment.create({
        data: { elementId: T, startupId: startup.id, amountUsd: -5, provider: "STRIPE", idempotencyKey: PAYMENT_KEY },
      }),
    ).rejects.toThrow(/Payment_amountUsd_nonnegative/);
    await expect(
      prisma.payment.create({
        data: { elementId: T, startupId: startup.id, amountUsd: 5, providerAmount: -5, provider: "STRIPE", idempotencyKey: PAYMENT_KEY },
      }),
    ).rejects.toThrow(/Payment_providerAmount_nonnegative/);

    // The refund pair is a biconditional, so it has to bite in both directions:
    // a refunded status with no timestamp, and a timestamp on a live payment.
    // `providerAmount` stays NULL in these two, which the CHECK allows.
    const live = await prisma.payment.create({
      data: { elementId: T, startupId: startup.id, amountUsd: 5, provider: "STRIPE", idempotencyKey: PAYMENT_KEY },
    });
    await expect(
      prisma.payment.update({ where: { id: live.id }, data: { status: "REFUNDED" } }),
    ).rejects.toThrow(/Payment_refundedAt_matches_status/);
    await expect(
      prisma.payment.update({ where: { id: live.id }, data: { refundedAt: new Date() } }),
    ).rejects.toThrow(/Payment_refundedAt_matches_status/);
    // Positive control: the legitimate pairing is what the settlement paths write.
    await expect(
      prisma.payment.update({ where: { id: live.id }, data: { status: "REFUNDED", refundedAt: new Date() } }),
    ).resolves.toMatchObject({ status: "REFUNDED" });
  });
});
