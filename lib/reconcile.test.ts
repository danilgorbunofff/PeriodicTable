/* Money reconciliation report tests (Phase 2 follow-up).
   The report is the only reader of Payment.providerAmount/providerCurrency, so
   it gets its own fixture element (9989 — outside the 9991-9999 block the other
   suites own) and writes payment rows directly. No stake is ever applied, so no
   element/leader state is touched. */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../app/api/jobs/reconcile/route";

const prisma = testPrisma();
const hasDb = hasTestDb;
const TE = 9989;
const DOMAIN = "rec-a.dev";

// Future timestamps: the report samples with ORDER BY paidAt DESC LIMIT 5, and
// other suites settle payments in parallel, so ordering must be ours.
const future = (min: number) => new Date(Date.now() + min * 60_000);

let startupId = "";
let keyN = 0;

type Report = {
  ok: boolean;
  paidTotal: number;
  divergent: { count: number; samples: { id: string; amountUsd: number; providerAmount: number | null }[] };
  unverified: {
    count: number;
    byProvider: { provider: string; count: number }[];
    samples: { id: string; amountUsd: number; provider: string }[];
    note: string;
  };
};

async function call(): Promise<Report> {
  const res = await GET(new NextRequest("http://localhost/api/jobs/reconcile") as never);
  const report = (await res.json()) as Report;
  // The status code is the only channel a status-code-only monitor can read
  // (the free cron-job.org tier fails a job on non-2xx and cannot inspect
  // bodies), so it must agree with `ok` exactly. Asserted as a coupling rather
  // than a fixed 200 — a hardcoded 200 here is what kept real money
  // contradictions invisible to the pinger, and the divergent tests below are
  // where this check earns its keep.
  expect(res.status).toBe(report.ok ? 200 : 503);
  return report;
}

function paid(data: { amountUsd: number; providerAmount?: number | null; providerCurrency?: string | null; minutes: number }) {
  return prisma.payment.create({
    data: {
      elementId: TE,
      startupId,
      amountUsd: data.amountUsd,
      path: "JOIN",
      provider: "WHOP",
      idempotencyKey: `rec-${Date.now()}-${keyN++}`,
      status: "PAID",
      paidAt: future(data.minutes),
      providerAmount: data.providerAmount ?? null,
      providerCurrency: data.providerCurrency ?? null,
    },
  });
}

describe.skipIf(!hasDb)("money reconciliation report", () => {
  beforeAll(async () => {
    if (!hasDb) return;
    await prisma.element.upsert({
      where: { id: TE },
      create: { id: TE, symbol: "TRC", name: "Test Reconcile", atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
      update: {},
    });
    const s = await prisma.startup.upsert({
      where: { domain: DOMAIN },
      create: { domain: DOMAIN, title: DOMAIN, pitch: "reconcile fixture", url: `https://${DOMAIN}`, logoUrl: "x" },
      update: {},
    });
    startupId = s.id;
  });

  afterAll(async () => {
    if (!hasDb) {
      await prisma.$disconnect().catch(() => undefined);
      return;
    }
    await prisma.payment.deleteMany({ where: { startup: { domain: DOMAIN } } });
    await prisma.element.deleteMany({ where: { id: TE } });
    await prisma.startup.deleteMany({ where: { domain: DOMAIN } });
    await prisma.$disconnect();
  });

  it("accepts a cents-unit provider amount as agreement, not as a divergence", async () => {
    // 2500 vs 25 is the real shape of a cents payload: the same money, and a
    // report that flagged it would cry wolf on every legitimate charge.
    const p = await paid({ amountUsd: 25, providerAmount: 2500, providerCurrency: "usd", minutes: 5 });
    const report = await call();
    expect(report.ok).toBe(true);
    expect(report.divergent.count).toBe(0);
    expect(report.divergent.samples.map((s) => s.id)).not.toContain(p.id);
  });

  it("counts a paid payment the provider never priced as unverified", async () => {
    const p = await paid({ amountUsd: 15, minutes: 6 });
    const report = await call();
    // Advisory, not a defect: the charge is real, it just was never cross-checked.
    expect(report.ok).toBe(true);
    expect(report.unverified.count).toBeGreaterThanOrEqual(1);
    expect(report.unverified.samples[0]?.id).toBe(p.id);
    // The report's own numbers must agree with each other.
    const summed = report.unverified.byProvider.reduce((n, r) => n + r.count, 0);
    expect(summed).toBe(report.unverified.count);
    expect(report.unverified.note).toContain("cross-checked");
  });

  it("fails ok and names the row when the stored figure contradicts the charge", async () => {
    // Unreachable through the app (the webhook rejects mismatches before
    // settling), which is exactly why a hit must be loud: it means the
    // acceptance rule, or a path that bypassed it, is wrong.
    const bad = await paid({ amountUsd: 25, providerAmount: 999, minutes: 7 });
    const report = await call();
    expect(report.ok).toBe(false);
    expect(report.divergent.count).toBe(1);
    expect(report.divergent.samples[0]?.id).toBe(bad.id);

    await prisma.payment.delete({ where: { id: bad.id } });
    const clean = await call();
    expect(clean.ok).toBe(true);
    expect(clean.divergent.count).toBe(0);
  });

  it("flags a non-usd stored currency even when the amount agrees", async () => {
    const p = await paid({ amountUsd: 30, providerAmount: 30, providerCurrency: "eur", minutes: 8 });
    const report = await call();
    expect(report.ok).toBe(false);
    expect(report.divergent.samples.find((s) => s.id === p.id)).toBeTruthy();
    await prisma.payment.delete({ where: { id: p.id } });
  });

  it("counts every contradiction even though it only shows five", async () => {
    // The count must never be the sample size: an ops report that understates
    // a problem by capping at its display limit is worse than no report.
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push(await paid({ amountUsd: 7, providerAmount: 8, minutes: 9 + i }));
    const report = await call();
    expect(report.ok).toBe(false);
    expect(report.divergent.count).toBe(6);
    expect(report.divergent.samples.length).toBe(5);
    await prisma.payment.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    expect((await call()).divergent.count).toBe(0);
  });
});
