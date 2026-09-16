/* R12-4: the data-subject erasure sweep, end to end on a real database.

   What this suite is for: the doc's PII census (§5.11) is the list of columns
   that hold a person, and erasure is only real if *every* one of them loses the
   person while every row and every id survives. So the assertions are structural
   rather than per-column: a table of (table, column) pairs is scanned for the
   address after each run, and the expected result of the scan is stated exactly
   — nothing left inside the window, and precisely the rows the window held back
   outside it. The ledger and provider registers are asserted untouched by the
   same kind of raw check that the money tests use. */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ERASURE_MARKER, ERASURE_SCOPES, eraseSubject, previewErasure, summary } from "./erasure";

/** Free element id: 9982-9999 belong to other suites. */
const T = 9981;
const SYMBOL = "ERS1";
const DOMAIN = "r12-4-erasure.test";
const EMAIL = "erase-me@r12-4.test";
const BYSTANDER = "bystander@r12-4.test";
const IP_HASH = "r12-4-hash-of-the-subject";
const BYSTANDER_HASH = "r12-4-hash-of-a-bystander";
const DAY = 86_400_000;
const OLD = new Date(Date.now() - 40 * DAY);
const WINDOW = 30;

/** Every column the census names, plus the free-text ones R12-4 found. A scan
 *  that misses a column is an erasure that leaves an address behind. */
const PII_COLUMNS: [string, string][] = [
  ["Payment", "email"],
  ["Startup", "email"],
  ["Startup", "moderatedReason"],
  ["WaitlistEntry", "email"],
  ["ManageToken", "email"],
  ["EmailAddress", "email"],
  ["EmailAddress", "token"],
  ["EmailAddress", "detail"],
  ["Report", "ipHash"],
  ["Report", "reason"],
  ["Report", "note"],
  ["ClickEvent", "ipHash"],
  ["AuditLog", "detail"],
  ["EmailLog", "to"],
  ["EmailLog", "detail"],
  ["EmailLog", "error"],
  ["ProviderEvent", "detail"],
  ["ProviderEvent", "payload"],
  ["OutboxEvent", "payload"],
  ["OutboxEvent", "lastError"],
];

async function leaks(prisma: PrismaClient, needle: string): Promise<Record<string, number>> {
  const hits: Record<string, number> = {};
  for (const [table, column] of PII_COLUMNS) {
    const rows = await prisma.$queryRaw<{ n: number }[]>(
      Prisma.sql`SELECT count(*)::int AS n FROM ${Prisma.raw(`"${table}"`)}
                 WHERE ${Prisma.raw(`"${column}"`)}::text ILIKE ${`%${needle}%`}`
    );
    const n = rows[0]?.n ?? 0;
    if (n > 0) hits[`${table}.${column}`] = n;
  }
  return hits;
}

/** What a 30-day window keeps: four recent rows, six columns. Stated once here
 *  because three tests assert against it, and a change to the fixture should
 *  break all three at the same time rather than one at a time. */
const HELD_BACK = {
  "AuditLog.detail": 1,
  "EmailLog.detail": 1,
  "EmailLog.to": 1,
  "OutboxEvent.payload": 1,
  "ProviderEvent.detail": 1,
  "ProviderEvent.payload": 1,
};

describe.skipIf(!hasTestDb)("data-subject erasure (R12-4)", () => {
  const prisma = testPrisma();
  const ids = {
    elementStartup: "",
    unsubToken: "",
    stake: "",
    payment: "",
    waitlists: [] as string[],
    manageToken: "",
    addresses: [] as string[],
    report: "",
    reportBystander: "",
    clicks: [] as string[],
    logs: [] as string[],
    events: [] as string[],
    queued: "",
    sentOld: "",
    sentRecent: "",
    audits: [] as string[],
  };

  beforeAll(async () => {
    await prisma.element.upsert({
      where: { id: T },
      create: {
        id: T,
        symbol: SYMBOL,
        name: "Erasure probe",
        atomicMass: "0",
        gridRow: 0,
        gridCol: 0,
        family: "EXOTIC_THEORETICAL",
        tier: "EXOTIC",
      },
      update: {},
    });
    const startup = await prisma.startup.create({
      data: {
        domain: DOMAIN,
        title: "Erasure probe",
        pitch: "subject erasure fixture",
        url: `https://${DOMAIN}`,
        logoUrl: "x",
        email: EMAIL,
        moderatedBy: "operator",
        moderatedReason: `asked about ${EMAIL}`,
      },
    });
    ids.elementStartup = startup.id;
    ids.unsubToken = startup.unsubToken;
    const bystanderStartup = await prisma.startup.create({
      data: {
        domain: `bystander.${DOMAIN}`,
        title: "Erasure bystander",
        pitch: "must not be touched",
        url: `https://bystander.${DOMAIN}`,
        logoUrl: "x",
        email: BYSTANDER,
      },
    });

    const stake = await prisma.stake.create({
      data: { elementId: T, startupId: startup.id, amountUsd: 7, rank: 1, isLeader: true },
    });
    ids.stake = stake.id;

    ids.payment = (
      await prisma.payment.create({
        data: {
          elementId: T,
          startupId: startup.id,
          stakeId: stake.id,
          amountUsd: 7,
          provider: "DEV",
          providerRef: "r12-4-provider-ref",
          providerAmount: 7,
          providerCurrency: "usd",
          idempotencyKey: "r12-4-erasure-payment",
          status: "PAID",
          email: EMAIL,
        },
      })
    ).id;
    await prisma.payment.create({
      data: {
        elementId: T,
        startupId: bystanderStartup.id,
        amountUsd: 3,
        provider: "DEV",
        providerRef: "r12-4-provider-ref-bystander",
        idempotencyKey: "r12-4-erasure-payment-bystander",
        email: BYSTANDER,
      },
    });

    const waitlists = await Promise.all([
      prisma.waitlistEntry.create({ data: { email: EMAIL, source: "test" } }),
      prisma.waitlistEntry.create({ data: { email: BYSTANDER, source: "test" } }),
    ]);
    ids.waitlists = waitlists.map((w) => w.id);

    ids.manageToken = (
      await prisma.manageToken.create({
        data: {
          startupId: startup.id,
          email: EMAIL,
          tokenHash: "r12-4-token-hash",
          expiresAt: new Date(Date.now() + DAY),
        },
      })
    ).id;

    const addresses = await Promise.all([
      prisma.emailAddress.create({
        data: { email: EMAIL, reason: "bounce", source: "resend", detail: `hard bounce for ${EMAIL}` },
      }),
      prisma.emailAddress.create({ data: { email: BYSTANDER, reason: "manual" } }),
    ]);
    ids.addresses = addresses.map((a) => a.id);

    ids.report = (
      await prisma.report.create({
        data: {
          startupId: startup.id,
          reason: `impersonation of ${EMAIL}`,
          note: `reported by ${EMAIL}`,
          ipHash: IP_HASH,
        },
      })
    ).id;
    ids.reportBystander = (
      await prisma.report.create({ data: { reason: "spam", ipHash: BYSTANDER_HASH } })
    ).id;

    const clicks = await Promise.all([
      prisma.clickEvent.create({ data: { stakeId: stake.id, ipHash: IP_HASH } }),
      prisma.clickEvent.create({ data: { stakeId: stake.id, ipHash: BYSTANDER_HASH } }),
    ]);
    ids.clicks = clicks.map((c) => c.id);

    // The windowed half: one row of each record type inside the window, one
    // outside it. The old rows are the ones a 30-day window must erase.
    const logs = await Promise.all([
      prisma.emailLog.create({
        data: {
          to: EMAIL,
          template: "receipt",
          status: "logged",
          detail: `sent to ${EMAIL}`,
          createdAt: OLD,
        },
      }),
      prisma.emailLog.create({ data: { to: EMAIL, template: "waitlist", status: "logged", detail: `sent to ${EMAIL}` } }),
      prisma.emailLog.create({ data: { to: BYSTANDER, template: "waitlist", status: "logged" } }),
    ]);
    ids.logs = logs.map((l) => l.id);

    const events = await Promise.all([
      prisma.providerEvent.create({
        data: {
          provider: "STRIPE",
          providerEventId: "r12-4-event-old",
          eventType: "charge.succeeded",
          outcome: "APPLIED",
          detail: `delivered to ${EMAIL}`,
          payload: { to: [EMAIL], nested: { deeper: [{ note: `copy for ${EMAIL}` }] } },
          createdAt: OLD,
        },
      }),
      prisma.providerEvent.create({
        data: {
          provider: "STRIPE",
          providerEventId: "r12-4-event-recent",
          eventType: "charge.succeeded",
          detail: `delivered to ${EMAIL}`,
          payload: { to: [EMAIL] },
        },
      }),
    ]);
    ids.events = events.map((e) => e.id);

    ids.queued = (
      await prisma.outboxEvent.create({
        data: { type: "RECEIPT_EMAIL", dedupeKey: "r12-4-queued", payload: { to: EMAIL, template: "receipt" } },
      })
    ).id;
    ids.sentOld = (
      await prisma.outboxEvent.create({
        data: {
          type: "RECEIPT_EMAIL",
          dedupeKey: "r12-4-sent-old",
          payload: { to: EMAIL },
          completedAt: OLD,
          lastError: `smtp refused ${EMAIL}`,
          createdAt: OLD,
        },
      })
    ).id;
    ids.sentRecent = (
      await prisma.outboxEvent.create({
        data: {
          type: "RECEIPT_EMAIL",
          dedupeKey: "r12-4-sent-recent",
          payload: { to: EMAIL },
          completedAt: new Date(),
        },
      })
    ).id;

    const audits = await Promise.all([
      prisma.auditLog.create({ data: { action: "WAITLIST_JOINED", detail: `joined with ${EMAIL}`, createdAt: OLD } }),
      prisma.auditLog.create({ data: { action: "MANAGE_LINK_REQUESTED", detail: `link sent to ${EMAIL}` } }),
    ]);
    ids.audits = audits.map((a) => a.id);
  });

  afterAll(async () => {
    await prisma.emailLog.deleteMany({ where: { id: { in: ids.logs } } });
    await prisma.providerEvent.deleteMany({ where: { providerEventId: { startsWith: "r12-4-event-" } } });
    await prisma.outboxEvent.deleteMany({ where: { dedupeKey: { startsWith: "r12-4-" } } });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ id: { in: ids.audits } }, { action: "SUBJECT_ERASED" }] },
    });
    await prisma.clickEvent.deleteMany({ where: { id: { in: ids.clicks } } });
    await prisma.report.deleteMany({ where: { id: { in: [ids.report, ids.reportBystander] } } });
    await prisma.manageToken.deleteMany({ where: { id: ids.manageToken } });
    await prisma.waitlistEntry.deleteMany({ where: { id: { in: ids.waitlists } } });
    await prisma.emailAddress.deleteMany({ where: { id: { in: ids.addresses } } });
    await prisma.payment.deleteMany({ where: { idempotencyKey: { startsWith: "r12-4-erasure-payment" } } });
    await prisma.stake.deleteMany({ where: { elementId: T } });
    await prisma.startup.deleteMany({ where: { domain: { in: [DOMAIN, `bystander.${DOMAIN}`] } } });
    await prisma.element.deleteMany({ where: { id: T } });
    await prisma.$disconnect();
  });

  it("previews the whole sweep and writes nothing", async () => {
    const plan = await previewErasure({ email: EMAIL, days: WINDOW });

    expect(plan.applied).toBe(false);
    expect(plan.subject.email).toBe(EMAIL);
    expect(plan.scopes.map((s) => s.scope)).toEqual([...ERASURE_SCOPES]);
    expect(plan.scopes.every((s) => s.scrubbed === 0)).toBe(true);
    expect(plan.totals.matched).toBeGreaterThan(0);
    expect(plan.totals.kept).toBe(6); // six columns, one recent row each — see HELD_BACK

    // The record of the run must not be the thing the run removes.
    expect(ERASURE_MARKER).not.toContain("@");
    expect(summary(plan)).not.toContain("@");
    expect(summary(plan)).toContain(`window=${WINDOW}d`);

    // Nothing was written by the preview: not one column, and not the row the
    // queued-send scope would have cancelled.
    const before = await leaks(prisma, EMAIL);
    expect(before["Payment.email"]).toBe(1);
    expect(before["AuditLog.detail"]).toBe(2);
    expect(before["OutboxEvent.payload"]).toBe(3);
    // The four columns that do not hold it are the two bearer secrets and the
    // two hashes — neither is the address, and neither is a needle hit.
    expect(before["EmailAddress.token"]).toBeUndefined();
    expect(before["Startup.unsubToken"]).toBeUndefined();
    expect(before["Report.ipHash"]).toBeUndefined();
    expect(before["ClickEvent.ipHash"]).toBeUndefined();
    const queued = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: ids.queued } });
    expect(queued.completedAt).toBeNull();
  });

  it("erases identity at any age and records only inside the window", async () => {
    const run = await eraseSubject({ email: EMAIL, days: WINDOW, confirm: true });

    expect(run.applied).toBe(true);
    // Every matched row was actually changed — a scope that found rows and
    // scrubbed none is a query that does not agree with its own write.
    expect(run.totals.scrubbed).toBe(run.totals.matched);
    expect(run.totals.kept).toBe(6);

    // Identity columns: erased whatever their age.
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: ids.payment } })).email).toBeNull();
    const startup = await prisma.startup.findUniqueOrThrow({ where: { id: ids.elementStartup } });
    expect(startup.email).toBeNull();
    expect(startup.unsubToken).not.toBe(ids.unsubToken); // a fresh bearer secret, so old links die
    expect(startup.moderatedReason).toBe(`asked about ${ERASURE_MARKER}`);
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: ids.waitlists[0] } })).email).toBe(
      `erased-${ids.waitlists[0]}`
    );
    expect((await prisma.manageToken.findUniqueOrThrow({ where: { id: ids.manageToken } })).email).toBe(
      `erased-${ids.manageToken}`
    );
    const address = await prisma.emailAddress.findUniqueOrThrow({ where: { id: ids.addresses[0] } });
    expect(address.email).toBe(`erased-${ids.addresses[0]}`);
    expect(address.token).toBe(`erased-${ids.addresses[0]}-t`);
    expect(address.detail).toBe(`hard bounce for ${ERASURE_MARKER}`);
    const report = await prisma.report.findUniqueOrThrow({ where: { id: ids.report } });
    // The fingerprint scope is skipped, not guessed: the address does not name
    // the hash, so an address-only run cannot reach hash columns at all.
    expect(report.ipHash).toBe(IP_HASH);
    expect(report.reason).toBe(`impersonation of ${ERASURE_MARKER}`);
    expect(report.note).toBe(`reported by ${ERASURE_MARKER}`);
    expect((await prisma.clickEvent.findUniqueOrThrow({ where: { id: ids.clicks[0] } })).ipHash).toBe(IP_HASH);

    // The queue: a send that has not happened yet is cancelled outright, and the
    // one that already went out loses the address inside its payload.
    const queued = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: ids.queued } });
    expect(queued.completedAt).not.toBeNull();
    expect(queued.payload).toEqual({ to: ERASURE_MARKER, template: "receipt" });
    expect(queued.lastError).toContain("subject-erased");
    const sentOld = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: ids.sentOld } });
    expect(sentOld.lastError).toBe(`smtp refused ${ERASURE_MARKER}`);

    // Nothing else moved: the ledger, the amounts and the provider registers are
    // the reason the row survives in the first place.
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: ids.payment } });
    expect(payment.amountUsd).toBe(7);
    expect(payment.providerRef).toBe("r12-4-provider-ref");
    expect(payment.startupId).toBe(ids.elementStartup);
    expect(payment.elementId).toBe(T);
    const stake = await prisma.stake.findUniqueOrThrow({ where: { id: ids.stake } });
    expect(stake.amountUsd).toBe(7);
    expect(stake.rank).toBe(1);
    expect(stake.isLeader).toBe(true);

    // The bystander is untouched in every table it appears in.
    expect((await prisma.waitlistEntry.findFirstOrThrow({ where: { email: BYSTANDER } })).email).toBe(BYSTANDER);
    expect((await prisma.emailAddress.findFirstOrThrow({ where: { email: BYSTANDER } })).email).toBe(BYSTANDER);
    expect((await prisma.startup.findFirstOrThrow({ where: { domain: `bystander.${DOMAIN}` } })).email).toBe(BYSTANDER);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: ids.reportBystander } })).ipHash).toBe(BYSTANDER_HASH);
    expect((await prisma.clickEvent.findUniqueOrThrow({ where: { id: ids.clicks[1] } })).ipHash).toBe(BYSTANDER_HASH);
  });

  it("leaves exactly the rows the window held back", async () => {
    // The window is the retention decision, so the rows outside it are the only
    // place the address may still be — and they are named exactly, one column at
    // a time, because "the erasure is done" is a claim about every column.
    expect((await leaks(prisma, EMAIL))).toEqual(HELD_BACK);
    // The recent rows are still intact, which is what makes the count above a
    // statement about the window rather than about a broken sweep.
    const recent = await prisma.emailLog.findUniqueOrThrow({ where: { id: ids.logs[1] } });
    expect(recent.to).toBe(EMAIL);
    const recentEvent = await prisma.providerEvent.findUniqueOrThrow({ where: { id: ids.events[1] } });
    expect(recentEvent.payload).toEqual({ to: [EMAIL] });
  });

  it("is idempotent: a second run finds nothing left to do", async () => {
    const again = await eraseSubject({ email: EMAIL, days: WINDOW, confirm: true });
    expect(again.totals.scrubbed).toBe(0);
    expect(again.totals.matched).toBe(0);
    expect(again.totals.kept).toBe(6);
    expect(await leaks(prisma, EMAIL)).toEqual(HELD_BACK);
  });

  it("serves a subject with only an ip hash and skips the address scopes", async () => {
    const plan = await previewErasure({ ipHash: BYSTANDER_HASH, days: 0 });
    const skipped = plan.scopes.filter((s) => s.skipped);
    expect(skipped).toHaveLength(ERASURE_SCOPES.length - 1); // every scope but the fingerprint one
    expect(skipped.every((s) => s.skipped === "no email address supplied")).toBe(true);
    const fingerprints = plan.scopes.find((s) => s.scope === "Report.ipHash + ClickEvent.ipHash");
    expect(fingerprints?.skipped).toBeUndefined();
    expect(fingerprints?.matched).toBe(2);
    expect(fingerprints?.scrubbed).toBe(0); // still a preview

    const run = await eraseSubject({ ipHash: BYSTANDER_HASH, days: 0, confirm: true });
    expect(run.scopes.find((s) => s.scope === "Report.ipHash + ClickEvent.ipHash")?.scrubbed).toBe(2);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: ids.reportBystander } })).ipHash).toBeNull();
    expect((await prisma.clickEvent.findUniqueOrThrow({ where: { id: ids.clicks[1] } })).ipHash).toBe(ERASURE_MARKER);
    // And the address half of that subject, had there been one, was not touched:
    // the email scopes were skipped, not silently run with an empty needle.
    expect((await prisma.emailAddress.findFirstOrThrow({ where: { email: BYSTANDER } })).email).toBe(BYSTANDER);
  });

  it("refuses to guess a window or a subject, and normalizes the address it is given", async () => {
    await expect(previewErasure({ email: EMAIL, days: -1 })).rejects.toThrow(/days/);
    await expect(previewErasure({ email: EMAIL, days: 1.5 })).rejects.toThrow(/days/);
    await expect(previewErasure({ days: WINDOW })).rejects.toThrow(/email address, an ip hash, or both/);
    // The type makes the confirmation part of the call; the runtime check is
    // what a JavaScript caller hits, and it is the one that matters.
    await expect(
      eraseSubject({ email: EMAIL, days: 0, confirm: false as unknown as true })
    ).rejects.toThrow(/confirmation/);

    const plan = await previewErasure({ email: `  ${EMAIL.toUpperCase()}  `, days: 0 });
    expect(plan.subject.email).toBe(EMAIL);
  });

  it("erases what the window held back once the window closes", async () => {
    const run = await eraseSubject({ email: EMAIL, days: 0, confirm: true });
    expect(run.totals.kept).toBe(0);
    expect(run.totals.scrubbed).toBe(run.totals.matched);
    expect(await leaks(prisma, EMAIL)).toEqual({});

    // A hole-free sweep still leaves the rows: the ids and the amounts are what
    // the ledger and the provider register are made of.
    expect(await prisma.payment.count({ where: { id: ids.payment } })).toBe(1);
    expect(await prisma.emailLog.count({ where: { id: { in: ids.logs } } })).toBe(3);
    expect(await prisma.outboxEvent.count({ where: { id: { in: [ids.queued, ids.sentOld, ids.sentRecent] } } })).toBe(3);
  });

  it("audits the run with counts and a window, never the subject", async () => {
    const rows = await prisma.auditLog.findMany({ where: { action: "SUBJECT_ERASED" }, orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(4); // the runs above: 30d, again, ip-only, 0d
    for (const row of rows) {
      expect(row.actorType).toBe("operator");
      expect(row.detail).toContain("subject-erased scopes=");
      expect(row.detail).toContain("kept=");
      expect(row.detail).not.toContain("@");
      expect(row.actorRef).toBe("scripts/erase-subject.ts");
    }
    // No address anywhere in the trail, not even inside the rows the erasure wrote.
    expect(await leaks(prisma, EMAIL)).toEqual({});
  });
});
