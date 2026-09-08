/* Webhook reference validation (Phase 7 — P0-03 follow-through).
   A provider session id attached to two payments must fail safe (operator
   ERROR), never 500-loop or double-apply. */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "crypto";
import { POST as webhookPOST } from "../app/api/webhooks/whop/route";

const prisma = testPrisma();
const hasDb = hasTestDb;
const T8 = 9992;
const SECRET = "test-whop-secret";

type Env = Record<string, string | undefined>;
const penv = process.env as unknown as Env;
let keyN = 0;

async function signed(body: object) {
  const raw = JSON.stringify(body);
  const sig = createHmac("sha256", SECRET).update(raw, "utf8").digest("hex");
  return webhookPOST(
    new NextRequest("http://localhost/api/webhooks/whop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-whop-signature": sig },
      body: raw,
    })
  );
}

beforeAll(async () => {
  if (!hasDb) return;
  penv.WHOP_WEBHOOK_SECRET = SECRET;
  await prisma.stake.deleteMany({ where: { elementId: T8 } });
  await prisma.element.upsert({
    where: { id: T8 },
    create: { id: T8, symbol: "TST8", name: "Test Eight", atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
    update: {},
  });
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
  delete penv.WHOP_WEBHOOK_SECRET;
  const domains = ["wh-t.dev", "wh2-t.dev"];
  await prisma.providerEvent.deleteMany({ where: { payment: { startup: { domain: { in: domains } } } } });
  await prisma.outboxEvent.deleteMany({ where: { OR: [{ dedupeKey: { contains: "wh-t" } }, { dedupeKey: { contains: "wh2-t" } }] } });
  await prisma.activityLog.deleteMany({ where: { domain: { in: domains } } });
  await prisma.payment.deleteMany({ where: { startup: { domain: { in: domains } } } });
  await prisma.auditLog.deleteMany({ where: { startup: { domain: { in: domains } } } });
  await prisma.firstClaim.deleteMany({ where: { elementId: T8 } });
  await prisma.stake.deleteMany({ where: { elementId: T8 } });
  await prisma.element.deleteMany({ where: { id: T8 } });
  await prisma.startup.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
});

async function pendingPayment(domain: string, amount: number, ref: string | null) {
  const s = await prisma.startup.upsert({
    where: { domain },
    create: { domain, title: domain, pitch: "webhook fixture pitch", url: `https://${domain}`, logoUrl: "x" },
    update: {},
  });
  return prisma.payment.create({
    data: {
      elementId: T8,
      startupId: s.id,
      amountUsd: amount,
      path: "JOIN",
      provider: "WHOP",
      providerRef: ref,
      idempotencyKey: `wh-t-${Date.now()}-${keyN++}`,
      status: "PENDING",
    },
  });
}

describe.skipIf(!hasDb)("webhook reference safety", () => {
  it("mismatched reference on a claimed payment fails safe", async () => {
    const p = await pendingPayment("wh-t.dev", 10, "cs_owned");
    const res = await signed({
      id: `wh-mismatch-${Date.now()}`,
      type: "payment.succeeded",
      data: { status: "succeeded", amount: 10, currency: "usd", id: "cs_other", metadata: { paymentId: p.id } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { error?: string }).error).toMatch(/reference-mismatch/);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING");
  });
  it("reference claimed by another payment fails safe (no 500 loop)", async () => {
    const p1 = await pendingPayment("wh-t.dev", 10, "cs_shared");
    const p2 = await pendingPayment("wh2-t.dev", 10, null);
    const res = await signed({
      id: `wh-claimed-${Date.now()}`,
      type: "payment.succeeded",
      data: { status: "succeeded", amount: 10, currency: "usd", id: "cs_shared", metadata: { paymentId: p2.id } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { error?: string }).error).toMatch(/reference-claimed/);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p2.id } })).status).toBe("PENDING");
    expect(p1.id).not.toBe(p2.id);
  });
  it("matching reference settles", async () => {
    const p = await pendingPayment("wh2-t.dev", 12, "cs_mine");
    const res = await signed({
      id: `wh-ok-${Date.now()}`,
      type: "payment.succeeded",
      data: { status: "succeeded", amount: 12, currency: "usd", id: "cs_mine", metadata: { paymentId: p.id } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome?: string }).outcome).toBe("applied");
  });
});
