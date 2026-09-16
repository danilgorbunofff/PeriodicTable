/* Phase 6 moderation + worker integration (local test DB, TST7/9993).
   Hide/unlist enforcement across surfaces, triage flow, outbox retry,
   worker auth/bounds, unsubscribe semantics. */
import { hasTestDb, purgeSettledOutbox, testPrisma } from "./testDb"; // must stay first
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
import { POST as checkoutPOST } from "../app/api/checkout/route";
import { GET as unsubGET, POST as unsubPOST } from "../app/api/unsubscribe/route";
import { suppressionFor } from "./email";
import { TRIAGE_PROMISE_HOURS } from "./moderation";

const prisma = testPrisma();
const hasDb = hasTestDb;
const T7 = 9993;
const DOMAINS = ["modhide-t.dev", "modvis-t.dev", "modbuy-t.dev"];
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
  // The unsubscribe case suppresses by address, so the refusal rows and the
  // audit rows that carry the address (no startupId) are cleaned by hand; the
  // domain-scoped audit delete below cannot see them (R10-5).
  await prisma.emailAddress.deleteMany({ where: { email: { in: ["modvis-t@example.com", "modhide-t@example.com"] } } });
  await prisma.auditLog.deleteMany({ where: { detail: { in: ["modvis-t@example.com", "modhide-t@example.com"] } } });
  // Reservations before payments — the FK is restrictive.
  await prisma.claimReservation.deleteMany({ where: { elementId: T7 } });
  await prisma.providerEvent.deleteMany({ where: { payment: { startup: { domain: { in: DOMAINS } } } } });
  await purgeSettledOutbox(prisma, { startup: { domain: { in: DOMAINS } } });
  await prisma.activityLog.deleteMany({ where: { domain: { in: DOMAINS } } });
  // R05-7: report intake also enqueues a notice keyed on the report id, which
  // purgeSettledOutbox (payment keys only) does not cover. Read the ids first —
  // deleting the reports is what removes the key.
  const reports = await prisma.report.findMany({
    where: { startup: { domain: { in: DOMAINS } } },
    select: { id: true },
  });
  await prisma.outboxEvent.deleteMany({
    where: { dedupeKey: { in: reports.map((r) => `report-mail:${r.id}`) } },
  });
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

    // The charge must equal the advertised price. With modhide-t.dev hidden,
    // the displayed take-lead price is derived from the visible leader (12) —
    // so paying that price must actually take the lead at that same price.
    // Pricing off the hidden 40 instead classified the advertised amount as a
    // mere join: no reservation, and the buyer's money would not have bought
    // the lead the page promised.
    const advertised = (
      (await (await elementGET(req("/api/elements/TST7"), { params: { sym: "TST7" } } as never)).json()) as {
        prices: { takeLead: number };
      }
    ).prices.takeLead;
    expect(advertised).toBe(13);
    const buy = await checkoutPOST(
      req("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elementSym: "TST7",
          amountUsd: advertised,
          attest: true,
          idempotencyKey: key(),
          startup: { title: "Mod Buyer", pitch: "moderation buyer probe pitch", url: "https://modbuy-t.dev", linkType: "product" },
        }),
      })
    );
    expect(buy.status).toBe(200);
    const bought = (await buy.json()) as { paymentId: string; reservation?: { reservedTotal: number } };
    expect(bought.reservation?.reservedTotal).toBe(advertised);
    const boughtPayment = await prisma.payment.findUniqueOrThrow({ where: { id: bought.paymentId } });
    expect(boughtPayment.path).toBe("TAKE");
    expect(boughtPayment.amountUsd).toBe(advertised);
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

describe.skipIf(!hasDb)("report intake contract (R11-5) and the operator queue (R11-6)", () => {
  /* R11-5: the limiter used to answer 200 `{ok:true,note:"rate-limited"}` — a
   * success to every `res.ok` check on the client, and to any uptime probe
   * counting 2xx. A person whose report was dropped was told it was filed. */
  it("answers 429 with the shared envelope when the hourly key is spent", async () => {
    const from = { "x-forwarded-for": "203.0.113.9", "Content-Type": "application/json" };
    const call = () =>
      reportPOST(req("/api/report", { method: "POST", headers: from, body: JSON.stringify({ domain: "modvis-t.dev", reason: "limit probe" }) }));
    for (let i = 0; i < 10; i++) {
      const ok = await call();
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { ok?: boolean }).ok).toBe(true);
    }
    const over = await call();
    expect(over.status).toBe(429);
    const body = (await over.json()) as { error: string; code: string };
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.error).toBeTruthy();
    expect(over.headers.get("x-request-id")).toBeTruthy();
    // The refused report is not stored: the 429 is the whole answer.
    expect(await prisma.report.count({ where: { reason: "limit probe" } })).toBe(10);
  });

  it("refuses an unknown ?status= instead of rendering an empty queue", async () => {
    const bad = await reportsGET(req("/api/admin/reports?status=nope", { headers: adminHeaders }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("BAD_STATUS");
    // The typo a person actually makes: `?status=open` used to be an empty
    // list, which reads as "no reports" — how a real report gets missed.
    expect((await reportsGET(req("/api/admin/reports?status=open", { headers: adminHeaders }))).status).toBe(400);
    expect((await reportsGET(req("/api/admin/reports?status=OPEN", { headers: adminHeaders }))).status).toBe(200);
    expect((await reportsGET(req("/api/admin/reports", { headers: adminHeaders }))).status).toBe(200);
  });

  /* R16-12: `/legal/contact` promises a reporter their report is "actioned within
     72 hours", and nothing counted the wait — the queue answered 50 rows by
     `createdAt desc`, so the report that had waited longest was the least likely
     to be read. The metric is the fix; these are the two surfaces that publish it
     (the other is the reconcile `triage` block, asserted in lib/reconcile.test.ts). */
  it("publishes the age of the queue the promise is made against", async () => {
    const stake = await prisma.stake.findFirstOrThrow({ where: { elementId: T7, startup: { domain: "modvis-t.dev" } } });
    // Backdated on purpose: the cursor test above needs `createdAt desc` to keep
    // the row it creates at the head of the queue, and a backlog is exactly what
    // this metric exists to reveal.
    const backlog = await prisma.report.create({
      data: {
        stakeId: stake.id,
        domain: "modvis-t.dev",
        reason: "queue age probe",
        createdAt: new Date(Date.now() - 250 * 3_600_000),
      },
    });
    await prisma.report.create({
      data: {
        stakeId: stake.id,
        domain: "modvis-t.dev",
        reason: "queue age probe",
        createdAt: new Date(Date.now() - 2 * 3_600_000),
      },
    });

    const res = await reportsGET(req("/api/admin/reports", { headers: adminHeaders }));
    expect(res.status).toBe(200);
    // The body is unchanged — an `<table>`-less operator tool reads the array, and
    // the metric rides in headers so adding it broke no reader (R11-6).
    expect(Array.isArray(await res.json())).toBe(true);

    // Counted, not sampled: the header is the database's answer, so a page size
    // cannot understate a backlog.
    const open = await prisma.report.count({ where: { status: "OPEN" } });
    const overdue = await prisma.report.count({
      where: { status: "OPEN", createdAt: { lt: new Date(Date.now() - TRIAGE_PROMISE_HOURS * 3_600_000) } },
    });
    const oldest = await prisma.report.findFirst({
      where: { status: "OPEN" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    expect(res.headers.get("X-Report-Queue-Open")).toBe(String(open));
    expect(res.headers.get("X-Report-Queue-Overdue")).toBe(String(overdue));
    expect(res.headers.get("X-Report-Queue-Promise-Hours")).toBe(String(TRIAGE_PROMISE_HOURS));
    expect(res.headers.get("X-Report-Queue-Oldest-At")).toBe(oldest?.createdAt.toISOString());
    // The 250-hour backlog is in it, and the promise is breached while it waits.
    expect(Number(res.headers.get("X-Report-Queue-Oldest-Hours"))).toBeGreaterThanOrEqual(249);
    expect(overdue).toBeGreaterThanOrEqual(1);

    await prisma.report.deleteMany({ where: { reason: "queue age probe" } });
    expect(await prisma.report.count({ where: { id: backlog.id } })).toBe(0);
  });

  it("walks the queue with ?before=, and an unknown cursor is empty rather than a fault", async () => {
    const stake = await prisma.stake.findFirstOrThrow({ where: { elementId: T7, startup: { domain: "modvis-t.dev" } } });
    const older = await prisma.report.create({ data: { stakeId: stake.id, domain: "modvis-t.dev", reason: "cursor probe a" } });
    const newer = await prisma.report.create({
      data: { stakeId: stake.id, startupId: older.startupId, domain: "modvis-t.dev", reason: "cursor probe b" },
    });
    const page1 = (await (await reportsGET(req("/api/admin/reports", { headers: adminHeaders }))).json()) as { id: string }[];
    const page2 = (await (await reportsGET(req(`/api/admin/reports?before=${newer.id}`, { headers: adminHeaders }))).json()) as { id: string }[];
    // The cursor page starts where the previous one stopped and repeats
    // nothing at or above the cursor row.
    expect(page2[0]?.id).toBe(older.id);
    const head = page1.slice(0, page1.findIndex((r) => r.id === newer.id) + 1);
    expect(head).toHaveLength(1);
    expect(page2.map((r) => r.id)).not.toContain(head[0].id);
    // Filter and cursor compose, and a cursor id that does not exist is not a 500.
    const filtered = (await (await reportsGET(req(`/api/admin/reports?status=OPEN&before=${newer.id}`, { headers: adminHeaders }))).json()) as { id: string }[];
    expect(filtered[0]?.id).toBe(older.id);
    const ghost = await reportsGET(req("/api/admin/reports?before=cursor-probe-missing", { headers: adminHeaders }));
    expect(ghost.status).toBe(200);
    expect((await ghost.json()) as unknown[]).toEqual([]);
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
  /* R10-5: a token issued before the address model still works — the link in an
   * old inbox must not go dead — but what the click does has changed. It used to
   * clear `Startup.email`, which is a *delivery address*, not a permission: the
   * next payment carrying the same address re-mailed the same person, and a
   * receipt addressed to `payment.email` was untouched. The refusal is now a row
   * on the address, and the address itself stays on the listing. */
  it("POST stops mail at the address, not by deleting it; idempotent; unknown tokens succeed silently", async () => {
    const before = await prisma.startup.findUniqueOrThrow({ where: { domain: "modvis-t.dev" } });
    const email = before.email as string;
    const seen = await prisma.auditLog.count({ where: { action: "EMAIL_UNSUBSCRIBED", detail: email } });
    const res = await unsubPOST(
      req("/api/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: before.unsubToken }) })
    );
    expect(res.status).toBe(200);
    expect(await suppressionFor(email)).toBe("unsubscribe");
    const after = await prisma.startup.findUniqueOrThrow({ where: { domain: "modvis-t.dev" } });
    expect(after.email).toBe(email); // the address is not the permission
    expect(await prisma.auditLog.count({ where: { action: "EMAIL_UNSUBSCRIBED", detail: email } })).toBe(seen + 1);

    const again = await unsubPOST(
      req("/api/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: before.unsubToken }) })
    );
    expect(again.status).toBe(200);
    expect(await prisma.emailAddress.count({ where: { email } })).toBe(1);

    const unknown = await unsubPOST(
      req("/api/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "nope" }) })
    );
    expect(unknown.status).toBe(200);
    expect((await unknown.json()) as object).toEqual({ ok: true });
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
