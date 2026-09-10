/* Phase 6 moderation + worker integration (local test DB, TST7/9993).
   Hide/unlist enforcement across surfaces, triage flow, outbox retry,
   worker auth/bounds, unsubscribe semantics. */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { settlePayment } from "./settle";
import { attachPreview } from "./outbox";
import { GET as searchGET } from "../app/api/search/route";
import { GET as tableOrderGET } from "../app/api/table-order/route";
import { GET as boardGET } from "../app/api/board/route";
import { GET as elementsGET } from "../app/api/elements/route";
import { GET as activityGET } from "../app/api/activity/route";
import { GET as elementGET } from "../app/api/elements/[sym]/route";
import { GET as goGET } from "../app/go/[stakeId]/route";
import { POST as reportPOST } from "../app/api/report/route";
import { GET as reportsGET } from "../app/api/admin/reports/route";
import { PATCH as triagePATCH } from "../app/api/admin/reports/[id]/route";
import { POST as moderatePOST } from "../app/api/admin/startups/[domain]/moderate/route";
import { POST as outboxRetryPOST } from "../app/api/admin/outbox/retry/route";
import { POST as outboxPOST } from "../app/api/jobs/outbox/route";
import { POST as shotPOST } from "../app/api/jobs/screenshot/route";
import { GET as unsubGET, POST as unsubPOST } from "../app/api/unsubscribe/route";

const prisma = testPrisma();
const hasDb = hasTestDb;
const T7 = 9993;
const DOMAINS = ["modhide-t.dev", "modvis-t.dev"];
let keyN = 0;
const key = () => `p6-mod-${Date.now()}-${keyN++}`;
const ADMIN = "test-admin-token";

type Env = Record<string, string | undefined>;
const penv = process.env as unknown as Env;
const req = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  new NextRequest(`http://localhost${url}`, init);
const adminHeaders = { authorization: `Bearer ${ADMIN}` };
const jsonInit = (body: object, auth = true): { method: string; headers: Record<string, string>; body: string } => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...(auth ? adminHeaders : {}) },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  if (!hasDb) return;
  penv.ADMIN_TOKEN = ADMIN;
  await prisma.stake.deleteMany({ where: { elementId: T7 } });
  await prisma.element.upsert({
    where: { id: T7 },
    create: { id: T7, symbol: "TST7", name: "Test Seven", atomicMass: "0", gridRow: 0, gridCol: 0, family: "EXOTIC_THEORETICAL", tier: "EXOTIC" },
    update: {},
  });
  for (const [domain, amount] of [["modhide-t.dev", 40], ["modvis-t.dev", 12]] as const) {
    const s = await prisma.startup.upsert({
      where: { domain },
      create: { domain, title: domain, pitch: "moderation fixture pitch", url: `https://${domain}`, logoUrl: "x", email: `${domain.split(".")[0]}@example.com` },
      update: { email: `${domain.split(".")[0]}@example.com` },
    });
    const payment = await prisma.payment.create({
      data: { elementId: T7, startupId: s.id, amountUsd: amount, path: "JOIN", provider: "DEV", idempotencyKey: key(), status: "PENDING" },
    });
    const out = await settlePayment(payment.id, { provider: "dev", eventId: `dev-${key()}`, eventType: "dev.test", paid: true });
    expect(out.outcome).toBe("applied");
  }
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
  delete penv.ADMIN_TOKEN;
  await prisma.providerEvent.deleteMany({ where: { payment: { startup: { domain: { in: DOMAINS } } } } });
  await prisma.outboxEvent.deleteMany({ where: { OR: [{ dedupeKey: { contains: "p6-mod" } }] } });
  await prisma.activityLog.deleteMany({ where: { domain: { in: DOMAINS } } });
  await prisma.report.deleteMany({ where: { startup: { domain: { in: DOMAINS } } } });
  await prisma.payment.deleteMany({ where: { startup: { domain: { in: DOMAINS } } } });
  await prisma.auditLog.deleteMany({ where: { startup: { domain: { in: DOMAINS } } } });
  await prisma.firstClaim.deleteMany({ where: { elementId: T7 } });
  await prisma.stake.deleteMany({ where: { elementId: T7 } });
  await prisma.element.deleteMany({ where: { id: T7 } });
  await prisma.startup.deleteMany({ where: { domain: { in: DOMAINS } } });
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)("moderation enforcement", () => {
  it("admin endpoints require the token", async () => {
    expect((await reportsGET(req("/api/admin/reports"))).status).toBe(403);
    expect((await moderatePOST(req("/api/admin/startups/x/moderate", jsonInit({}, false)), { params: { domain: "x" } })).status).toBe(403);
    expect((await outboxRetryPOST(req("/api/admin/outbox/retry", jsonInit({}, false)))).status).toBe(403);
    expect((await reportsGET(req("/api/admin/reports", { headers: adminHeaders }))).status).toBe(200);
  });
  it("hide removes the listing everywhere but keeps the money", async () => {
    const res = await moderatePOST(
      req("/api/admin/startups/modhide-t.dev/moderate", jsonInit({ state: "HIDDEN", reason: "phishing test", operator: "tester" })),
      { params: { domain: "modhide-t.dev" } }
    );
    expect(res.status).toBe(200);

    const search = (await (await searchGET(req("/api/search?q=modhide-t"))).json()) as { domain?: string }[];
    expect(search.some((h) => h.domain === "modhide-t.dev")).toBe(false);
    const order = (await (await tableOrderGET()).json()) as { domain: string }[];
    expect(order.some((r) => r.domain === "modhide-t.dev")).toBe(false);
    const crowns = (await (await boardGET(req("/api/board?tab=crowns"))).json()) as { domain: string }[];
    expect(crowns.some((r) => r.domain === "modhide-t.dev")).toBe(false);

    // Tile face falls back to the visible runner-up; pool still counts all.
    const tiles = (await (await elementsGET()).json()) as { symbol: string; pool: number; leader: { domain: string; amount: number } | null }[];
    const tile = tiles.find((t) => t.symbol === "TST7");
    expect(tile?.leader?.domain).toBe("modvis-t.dev");
    expect(tile?.pool).toBe(52);

    const detail = (await (await elementGET(req("/api/elements/TST7"), { params: { sym: "TST7" } } as never)).json()) as {
      stakes: { domain: string }[];
    };
    expect(detail.stakes.some((s) => s.domain === "modhide-t.dev")).toBe(false);

    const profile = await prisma.startup.findUniqueOrThrow({ where: { domain: "modhide-t.dev" } });
    expect(profile.moderationState).toBe("HIDDEN");
    expect(profile.previewImgUrl).toBeNull();

    const stake = await prisma.stake.findFirstOrThrow({ where: { elementId: T7, startup: { domain: "modhide-t.dev" } } });
    expect((await goGET(req(`/go/${stake.id}`), { params: { stakeId: stake.id } })).status).toBe(404);

    // The feed publishes domain + city + amount, so it must not re-announce a
    // concealed listing. Asserted as a window-independent invariant: whatever
    // rows the feed happens to return, none may belong to a HIDDEN startup.
    expect(await prisma.activityLog.count({ where: { domain: "modhide-t.dev" } })).toBeGreaterThan(0);
    const feed = (await (await activityGET(req("/api/activity?limit=20"))).json()) as { domain: string }[];
    expect(feed.some((row) => row.domain === "modhide-t.dev")).toBe(false);
    const feedStates = await prisma.startup.findMany({
      where: { domain: { in: [...new Set(feed.map((r) => r.domain))] } },
      select: { domain: true, moderationState: true },
    });
    expect(feedStates.filter((s) => s.moderationState === "HIDDEN")).toEqual([]);
  });
  it("unlist keeps direct surfaces, drops discovery", async () => {
    await moderatePOST(
      req("/api/admin/startups/modhide-t.dev/moderate", jsonInit({ state: "UNLISTED", reason: "dispute test", operator: "tester" })),
      { params: { domain: "modhide-t.dev" } }
    );
    const search = (await (await searchGET(req("/api/search?q=modhide-t"))).json()) as { domain?: string }[];
    expect(search.some((h) => h.domain === "modhide-t.dev")).toBe(false);
    const tiles = (await (await elementsGET()).json()) as { symbol: string; leader: { domain: string } | null }[];
    expect(tiles.find((t) => t.symbol === "TST7")?.leader?.domain).toBe("modhide-t.dev");
    const profile = await prisma.startup.findUniqueOrThrow({ where: { domain: "modhide-t.dev" } });
    expect(profile.moderationState).toBe("UNLISTED");

    // UNLISTED stays in the feed on purpose: the listing is still shown on tiles
    // and element pages, so concealing it here would hide nothing. Only HIDDEN
    // is filtered, which keeps the invariant below satisfied.
    const feed = (await (await activityGET(req("/api/activity?limit=20"))).json()) as { domain: string }[];
    const feedStates = await prisma.startup.findMany({
      where: { domain: { in: [...new Set(feed.map((r) => r.domain))] } },
      select: { moderationState: true },
    });
    expect(feedStates.filter((s) => s.moderationState === "HIDDEN")).toEqual([]);
  });
  it("restore returns the listing and audits the operator trail", async () => {
    const res = await moderatePOST(
      req("/api/admin/startups/modhide-t.dev/moderate", jsonInit({ state: "VISIBLE", operator: "tester" })),
      { params: { domain: "modhide-t.dev" } }
    );
    expect(res.status).toBe(200);
    const search = (await (await searchGET(req("/api/search?q=modhide-t"))).json()) as { domain?: string }[];
    expect(search.some((h) => h.domain === "modhide-t.dev")).toBe(true);
    const audits = await prisma.auditLog.findMany({
      where: { startup: { domain: "modhide-t.dev" }, action: "PROFILE_MODERATED" },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(audits.every((a) => a.actorType === "operator")).toBe(true);
  });
  it("report intake → triage without touching stakes", async () => {
    const stake = await prisma.stake.findFirstOrThrow({ where: { elementId: T7, startup: { domain: "modvis-t.dev" } } });
    const created = await reportPOST(
      req("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stakeId: stake.id, reason: "test report" }) })
    );
    expect(created.status).toBe(200);
    const queue = (await (await reportsGET(req("/api/admin/reports?status=OPEN", { headers: adminHeaders }))).json()) as {
      id: string;
      status: string;
    }[];
    const mine = queue.find((r) => r.id);
    expect(mine).toBeDefined();
    const triaged = await triagePATCH(
      req(`/api/admin/reports/${mine!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...adminHeaders }, body: JSON.stringify({ status: "DISMISSED", note: "test triage", reviewedBy: "tester" }) }),
      { params: { id: mine!.id } }
    );
    expect(triaged.status).toBe(200);
    expect((await prisma.stake.count({ where: { elementId: T7 } })).valueOf()).toBe(2);
  });
});

describe.skipIf(!hasDb)("workers and delivery ops", () => {
  it("job endpoints authenticate in production shape, pass locally", async () => {
    const ok = await outboxPOST(req("/api/jobs/outbox", jsonInit({ limit: 1 }, false)));
    expect(ok.status).toBe(200);
    const shot = await shotPOST(req("/api/jobs/screenshot", jsonInit({ limit: 1 }, false)));
    expect(shot.status).toBe(200);
  });
  it("outbox retry resets terminal rows, refuses completed ones", async () => {
    const row = await prisma.outboxEvent.create({
      data: { type: "STAKE_ANALYTICS", dedupeKey: `p6-mod-retry-${Date.now()}`, payload: {}, attempts: 5, lastError: "boom" },
    });
    const res = await outboxRetryPOST(req("/api/admin/outbox/retry", jsonInit({ dedupeKey: row.dedupeKey })));
    expect(res.status).toBe(200);
    const fresh = await prisma.outboxEvent.findUniqueOrThrow({ where: { dedupeKey: row.dedupeKey } });
    expect(fresh.attempts).toBe(0);
    expect(fresh.lastError).toBeNull();
    await prisma.outboxEvent.update({ where: { id: row.id }, data: { completedAt: new Date() } });
    expect((await outboxRetryPOST(req("/api/admin/outbox/retry", jsonInit({ dedupeKey: row.dedupeKey })))).status).toBe(409);
    await prisma.outboxEvent.delete({ where: { id: row.id } });
  });
});

describe.skipIf(!hasDb)("unsubscribe semantics (P1-18)", () => {
  it("GET renders a confirm form and mutates nothing", async () => {
    const before = await prisma.startup.findUniqueOrThrow({ where: { domain: "modvis-t.dev" } });
    expect(before.email).not.toBeNull();
    const res = await unsubGET(req(`/api/unsubscribe?token=${before.unsubToken}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<form");
    expect((await prisma.startup.findUniqueOrThrow({ where: { domain: "modvis-t.dev" } })).email).not.toBeNull();
  });
  it("POST clears idempotently; unknown tokens succeed silently", async () => {
    const before = await prisma.startup.findUniqueOrThrow({ where: { domain: "modvis-t.dev" } });
    const res = await unsubPOST(
      req("/api/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: before.unsubToken }) })
    );
    expect(res.status).toBe(200);
    expect((await prisma.startup.findUniqueOrThrow({ where: { domain: "modvis-t.dev" } })).email).toBeNull();
    const again = await unsubPOST(
      req("/api/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: before.unsubToken }) })
    );
    expect(again.status).toBe(200);
    const unknown = await unsubPOST(
      req("/api/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "nope" }) })
    );
    expect(unknown.status).toBe(200);
  });
});

describe.skipIf(!hasDb)("preview writes respect moderation (P1-14 retention)", () => {
  it("a late probe result cannot re-attach a preview to a moderated listing", async () => {
    const { id } = await prisma.startup.findUniqueOrThrow({ where: { domain: "modhide-t.dev" }, select: { id: true } });
    const late = "https://iad.microlink.io/late-probe.png";

    for (const state of ["HIDDEN", "UNLISTED"] as const) {
      await prisma.startup.update({ where: { id }, data: { moderationState: state, previewImgUrl: null } });
      expect((await attachPreview(id, late)).count).toBe(0);
      expect((await prisma.startup.findUniqueOrThrow({ where: { id } })).previewImgUrl).toBeNull();
    }

    await prisma.startup.update({ where: { id }, data: { moderationState: "VISIBLE" } });
    expect((await attachPreview(id, late)).count).toBe(1);
    expect((await prisma.startup.findUniqueOrThrow({ where: { id } })).previewImgUrl).toBe(late);
    await prisma.startup.update({ where: { id }, data: { previewImgUrl: null } });
  });
});
