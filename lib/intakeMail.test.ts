/* Phase 05 R05-7 — intake mail contracts.
 *
 * Two routes answer a person with a promise: POST /api/report ("we act on
 * reports within 72 hours", /legal/contact) and POST /api/waitlist ("we'll be
 * in touch", the paused-checkout modal). Both must leave a durable outbox row
 * so the promise survives a mail outage, and both may only deliver inline
 * inside a budget they can afford to hold an always-200 intake open for.
 *
 * Delivery itself is covered by the DB-gated suites; these are the template
 * and static-wiring halves. The recipient split matters: the report notice goes
 * to us, the waitlist confirmation goes to the address that asked for it —
 * and since R14-3 it goes there once per address, under a per-source ceiling.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { esc } from "../emails/escape";
import { reportSubject, reportHtml } from "../emails/report";
import { waitlistSubject, waitlistHtml } from "../emails/waitlist";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const reportRoute = src("app/api/report/route.ts");
const waitlistRoute = src("app/api/waitlist/route.ts");

describe("R05-7 report notice", () => {
  it("names the listing in the subject so triage needs no click", () => {
    expect(reportSubject({ domain: "acme.dev" })).toBe("[report] acme.dev");
    expect(reportSubject({ domain: null })).toBe("[report] unattached listing");
  });

  it("carries the queue link, the reason, and an unattached report too", () => {
    const html = reportHtml({
      id: "rep_1",
      domain: "acme.dev",
      stakeId: "ck_1",
      reason: "phishing clone of the real site",
      createdAt: "2026-09-14 12:00 UTC",
      queueUrl: "https://periodictable.lol/api/admin/reports",
    });
    expect(html).toContain("acme.dev");
    expect(html).toContain("phishing clone of the real site");
    expect(html).toContain("rep_1");
    expect(html).toContain("ck_1");
    expect(html).toContain("https://periodictable.lol/api/admin/reports");
    // A report filed without a listing still has to reach the queue.
    const loose = reportHtml({
      id: "rep_2",
      domain: null,
      stakeId: null,
      reason: "reported listing",
      createdAt: "2026-09-14 12:00 UTC",
      queueUrl: "https://periodictable.lol/api/admin/reports",
    });
    expect(loose).toContain("(no listing attached)");
    expect(loose).not.toContain("rep_2</code> </p>");
  });

  it("escapes reporter-supplied text instead of printing it as markup", () => {
    // `reason` is free text and `domain` is whatever the form posted: without
    // escaping, a report could put markup in the moderation inbox.
    const html = reportHtml({
      id: "rep_3",
      domain: '<img src=x onerror="p">',
      stakeId: null,
      reason: "</p><script>alert(1)</script>",
      createdAt: "2026-09-14 12:00 UTC",
      queueUrl: "https://periodictable.lol/api/admin/reports",
    });
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });

  it("escapes ampersands once, before the other entities", () => {
    expect(esc("a&b<c>d\"e'f")).toBe("a&amp;b&lt;c&gt;d&quot;e&#39;f");
  });

  it("is sent to the abuse inbox, never to the person who reported", () => {
    expect(reportRoute).toMatch(/REPORT_NOTIFY_EMAIL \?\? "abuse@periodictable\.lol"/);
    // The reporter is never an address this route knows: the payload it mails
    // carries only the moderation facts, minus the hashed IP it stores.
    const payload = /payload: \{[\s\S]*?\n      \},/.exec(reportRoute)?.[0] ?? "";
    expect(payload).toContain("process.env.REPORT_NOTIFY_EMAIL");
    expect(payload).not.toContain("ipHash");
    expect(reportRoute).toMatch(/ipHash/);
  });
});

describe("R05-7 waitlist confirmation", () => {
  it("confirms the join without claiming a date or taken money", () => {
    expect(waitlistSubject()).toBe("You're on the waitlist");
    const html = waitlistHtml({ domain: "acme.dev", tableUrl: "https://periodictable.lol" });
    expect(html).toContain("acme.dev");
    expect(html).toMatch(/nothing has been charged/i);
    expect(html).toContain("https://periodictable.lol");
  });

  it("renders for a join with no domain, and escapes a submitted one", () => {
    const bare = waitlistHtml({ domain: null, tableUrl: "https://x.test" });
    expect(bare).toContain("<strong>periodictable.lol</strong>");
    const hostile = waitlistHtml({ domain: "<b>big</b>", tableUrl: "https://x.test" });
    expect(hostile).toContain("&lt;b&gt;big&lt;/b&gt;");
    expect(hostile).not.toContain("<b>big</b>");
  });
});

describe("R05-7 route wiring", () => {
  const routes: Array<[string, string, string]> = [
    ["report", reportRoute, "REPORT_EMAIL"],
    ["waitlist", waitlistRoute, "WAITLIST_EMAIL"],
  ];

  it("enqueues first, then drains on a bounded budget", () => {
    for (const [label, s, type] of routes) {
      const enqueue = s.indexOf("enqueueOutbox(");
      const drain = s.indexOf("drainDueWithin(");
      expect(enqueue, label).toBeGreaterThan(-1);
      expect(drain, label).toBeGreaterThan(enqueue);
      // Intake answers in milliseconds: the drain gets 3s for 5 rows, and the
      // row it cannot reach is left for the daily /api/jobs/outbox cron.
      expect(s, label).toMatch(/drainDueWithin\(3_000, 5, \["[A-Z_]+"\]\)/);
      expect(s, label).toContain(`["${type}"]`);
    }
  });

  it("never lets a mail failure fail the request", () => {
    for (const [label, s] of routes) {
      expect(s, label).toMatch(/catch[\s\S]{0,400}console\.warn/);
      expect(s, label).toMatch(/return NextResponse\.json\(\{ ok: true/);
    }
  });

  it("dedupes per entity, and per hashed address per day", () => {
    expect(reportRoute).toMatch(/dedupeKey: `report-mail:\$\{report\.id\}`/);
    // R14-3: the key carries a salted reference rather than the address (the
    // queue is read by the cron and by operators), and is bucketed by day so two
    // instances racing the same join enqueue one row, not one per day of history.
    expect(waitlistRoute).toMatch(
      /dedupeKey: `waitlist-mail:\$\{addressRef\(entry\.email\)\}:\$\{Math\.floor\(Date\.now\(\) \/ WAITLIST_RECIPIENT_WINDOW_MS\)\}`/,
    );
  });

  it("mails only a first-time address, and caps new recipients per source (R14-3)", () => {
    // The mail is what the caller was previously able to direct at will: the
    // route handed their string to the provider, so one POST was an anonymous
    // relay into any inbox, sent from the domain that carries receipts.
    expect(waitlistRoute).toMatch(/const known = await prisma\.waitlistEntry\.findUnique/);
    expect(waitlistRoute).toMatch(/if \(!suppressed && !known\) await confirmWaitlist\(/);
    // The ceiling on distinct new recipients per source per day, counted on the
    // shared store and fail-closed: an unusable store must not lift the cap on
    // outbound mail the way it lifts a traffic limit.
    expect(waitlistRoute).toMatch(/const WAITLIST_NEW_RECIPIENTS = 5;/);
    expect(waitlistRoute).toMatch(
      /rateLimitAsync\(\s*`waitlist-new:\$\{entry\.ip\}`,\s*WAITLIST_NEW_RECIPIENTS,\s*WAITLIST_RECIPIENT_WINDOW_MS,\s*\{ onStoreError: "closed" \}/,
    );
    expect(waitlistRoute).toMatch(/rateLimitAsync\(`waitlist:\$\{ip\}`, 10, 3_600_000, \{\s*onStoreError: "closed"/);
  });

  it("the worker knows both types", () => {
    const outbox = src("lib/outbox.ts");
    expect(outbox).toMatch(/case "REPORT_EMAIL"/);
    expect(outbox).toMatch(/case "WAITLIST_EMAIL"/);
    expect(outbox).toMatch(/\| "REPORT_EMAIL"/);
    expect(outbox).toMatch(/\| "WAITLIST_EMAIL"/);
    // The unknown-type throw is what the retry suite exercises; the new cases
    // must not have turned it into a default arm.
    expect(outbox).toMatch(/throw new Error\(`unknown outbox type/);
    const email = src("lib/email.ts");
    expect(email).toMatch(/template: "report"/);
    expect(email).toMatch(/template: "waitlist"/);
    // Both go through the shared deliver/logEmail pair, so a missing
    // RESEND_API_KEY logs instead of throwing.
    expect(email).toMatch(/sendReportEmail/);
    expect(email).toMatch(/sendWaitlistEmail/);
  });
});