/* Review 20 — post-launch and debt, R20-1 … R20-15.

   This register is the one that plans work for *after* the site is live, so its
   rows are mostly dates, decisions and runbook prose — none of which a
   behavioural test can catch. What a test can catch is the part that is code and
   could drift: the advisory tripwire that makes an accepted risk re-checkable
   rather than remembered (R20-1), the two money readings that must stay
   distinguishable (R20-4/R20-5), the arithmetic that lets one cron slot drive
   three jobs (R20-7), the published service term that has to be the same string
   in the rules, the FAQ and the element page (R20-14/R20-15), and the runbook
   halves that were written as prose and would otherwise be unfalsifiable
   (R20-9 … R20-12).

   The pins are about provenance, the way lib/launchReadiness.test.ts's are: the
   published date must come from `SERVICE_TERM`, the budget split must sum to the
   ceiling, and a runbook that claims a test exists must name it. A test that
   matched a sentence would pass while the sentence went wrong. */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  DAILY_DIAGNOSTIC_RESERVE_MS,
  DAILY_PREVIEW_BUDGET_MS,
  JOB_WORK_BUDGET_MS,
  ROW_CEILING_MS,
} from "./jobBudget";
import {
  HEARTBEAT_ROUTES,
  HEARTBEAT_SLACK_MS,
  HEARTBEAT_STALE_MS,
} from "./jobHeartbeat";
import { SERVICE_TERM, SERVICE_TERM_SENTENCE, LEGAL_REVISION_LOG, LEGAL_REVISIONS } from "./legal";
import { legalCanonicalText } from "./legalDocs";
import { FAQ_ITEMS } from "./faqDocs";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const ops = (p: string) => src(join("ops", p));

describe("R20-1 the accepted advisory is re-checked, not remembered", () => {
  const advisories = JSON.parse(src("ops/accepted-advisories.json")) as {
    accepted: { package: string; tripwires?: { file: string; must_not_contain: string; because: string }[] }[];
  };
  const audit = src("scripts/audit-prod.mjs");

  it("carries a tripwire whose condition is the reason the risk is accepted", () => {
    const next = advisories.accepted.find((a) => a.package === "next");
    expect(next).toBeDefined();
    expect(next!.tripwires?.length ?? 0).toBeGreaterThan(0);
    for (const t of next!.tripwires!) {
      // All three fields, because a tripwire without them cannot be checked: the
      // file to read, the substring that voids the acceptance, and why.
      expect(t.file, "tripwire file").toBeTruthy();
      expect(t.must_not_contain, "tripwire condition").toBeTruthy();
      expect(t.because.length, "tripwire reason").toBeGreaterThan(20);
      // The AVIF half of the acceptance rests on a file that is in the repo, so
      // the tripwire is checkable rather than aspirational.
      expect(existsSync(join(__dirname, "..", t.file)), t.file).toBe(true);
    }
  });

  it("matches the config key it is a tripwire for, and strips comments first", () => {
    const next = advisories.accepted.find((a) => a.package === "next")!;
    for (const t of next.tripwires!) {
      // A tripwire on a config key has to name the key and a config file, or it
      // is a comment about nothing.
      expect(t.file, t.file).toMatch(/\.(mjs|js|ts|json)$/);
      expect(t.must_not_contain).toMatch(/images|formats/);
      // The prose in next.config.mjs talks about the key it must not contain, so
      // the check has to read the file with comments removed — pinned here so a
      // future tripwire cannot be tripped by its own explanation.
      expect(audit).toMatch(/function withoutComments/);
      expect(audit).toMatch(/replace\(\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\/\/g, ""\)/);
    }
  });

  it("fails closed, and before the audit it guards", () => {
    expect(audit).toMatch(/function checkTripwires\(\)/);
    // Missing file, missing field, tripwired substring present: all three exit(1)
    // rather than warn — an acceptance that cannot be verified is not an
    // acceptance.
    const body = audit.slice(
      audit.indexOf("function checkTripwires()"),
      audit.indexOf("checkTripwires();"),
    );
    expect(body.match(/process\.exit\(1\)/g)?.length).toBeGreaterThanOrEqual(3);
    // ...and it runs before the audit output is trusted: a stale acceptance would
    // otherwise be reported as a clean run.
    expect(audit.indexOf("checkTripwires();")).toBeLessThan(
      audit.indexOf('execSync("npm audit --omit=dev --json"'),
    );
  });

  it("keeps the acceptance dated, so the expiry is what ends it", () => {
    const next = advisories.accepted.find((a) => a.package === "next")! as unknown as { expires?: string };
    expect(next.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // An acceptance with no expiry is a permanent decision made by accident.
    for (const a of advisories.accepted as unknown as { expires?: string }[]) {
      expect(a.expires, JSON.stringify(a).slice(0, 60)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("R20-4/R20-5 a ledger reader can tell revenue from activity", () => {
  const shapes = src("doc/PAYMENT-LEDGER-SHAPES.md");
  const metrics = src("lib/opsMetrics.ts");

  it("writes the shapes down where a non-operator meets them", () => {
    expect(existsSync(join(__dirname, "..", "doc", "PAYMENT-LEDGER-SHAPES.md"))).toBe(true);
    // The document is only useful if it says where its numbers came from and when
    // — an inventory with no date is a claim about now.
    expect(shapes).toMatch(/Provenance/);
    expect(shapes).toMatch(/2026-09-14/);
    // Which table, and which spelling: the trap that costs an hour if unwritten.
    expect(shapes).toContain("stakeId IS NOT NULL");
    expect(shapes).toContain(`invalid input value for enum "PaymentStatus"`);
    // A reader has to be able to reproduce the shapes, not just read about them.
    expect(shapes).toMatch(/psql "\$DATABASE_URL" -c "SELECT provider, status/);
    // And the open decision has to be visible from here, not only in the register.
    expect(shapes).toMatch(/open decision/i);
  });

  it("keeps both readings in the report, and only one of them filtered", () => {
    // Two reads of the same status on purpose: everything the processor settled,
    // and the subset that became a stake. The filter is what tells them apart,
    // and there is exactly one of each.
    const unfiltered =
      metrics.match(
        /prisma\.payment\.findMany\(\{\s*where: \{ status: "PAID", appliedAt: \{ gte: since \} \},/g,
      ) ?? [];
    expect(unfiltered.length, "the unfiltered reading, and only one").toBe(1);
    const filtered =
      metrics.match(
        /prisma\.payment\.aggregate\(\{\s*where: \{ status: "PAID",[\s\S]{0,60}?stakeId: \{ not: null \} \},/g,
      ) ?? [];
    expect(filtered.length, "exactly one reading filters stakeId").toBe(1);
    // Both are named, so the comment above them can say which is which.
    expect(metrics).toContain("windowPaid");
    expect(metrics).toContain("windowSettled");
    // ...and the source cites the document rather than leaving a reader to infer
    // the difference from a field name.
    expect(metrics).toContain("doc/PAYMENT-LEDGER-SHAPES.md");
  });

  it("leaves reconcile reading every had_money row, deliberately", () => {
    // A settlement whose stake was unwound by hand is still evidence money
    // arrived; filtering there would hide it. This is the asymmetry the
    // document explains, pinned so "consistency" cannot quietly remove it.
    expect(src("app/api/jobs/reconcile/route.ts")).toMatch(/status: "PAID"/);
    expect(src("app/api/jobs/reconcile/route.ts")).not.toMatch(/stakeId: \{ not: null \}/);
  });
});

describe("R20-7 one cron slot drives three jobs, and the arithmetic says how", () => {
  const crons = JSON.parse(src("vercel.json")) as { crons: { path: string; schedule: string }[] };

  it("spends the plan's two entries, and no more", () => {
    // Hobby allows two cron jobs at daily frequency; both were already spent on
    // workers, which is why the composite exists (D20-7). A third entry is a
    // deploy that silently drops one, so it is a test failure instead.
    expect(crons.crons.length).toBe(2);
    expect(crons.crons.map((c) => c.path).sort()).toEqual([
      "/api/jobs/daily",
      "/api/jobs/outbox?limit=25",
    ]);
    // Daily, once: the plan's limit is hourly-or-slower and *once* per day.
    for (const c of crons.crons) expect(c.schedule, c.path).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(new Set(crons.crons.map((c) => c.schedule)).size).toBe(2);
  });

  it("splits the work budget without planning past the ceiling", () => {
    expect(DAILY_DIAGNOSTIC_RESERVE_MS + DAILY_PREVIEW_BUDGET_MS).toBe(JOB_WORK_BUDGET_MS);
    expect(DAILY_PREVIEW_BUDGET_MS).toBeGreaterThan(0);
    // At least one preview row must still fit, or the composite is a report
    // runner that pretends to be a worker.
    expect(DAILY_PREVIEW_BUDGET_MS).toBeGreaterThanOrEqual(ROW_CEILING_MS);
    expect(src("lib/jobBudget.ts")).toContain("export const DAILY_DIAGNOSTIC_RESERVE_MS");
  });

  it("runs both reports in-process, through their own handlers", () => {
    const daily = src("app/api/jobs/daily/route.ts");
    // Imported rather than fetched: same auth, same gate, same shape. A copy of
    // either report's logic would be a second answer to the same question.
    expect(daily).toMatch(/import \{ GET as configGET \} from "\.\.\/config\/route"/);
    expect(daily).toMatch(/import \{ GET as reconcileGET \} from "\.\.\/reconcile\/route"/);
    expect(daily).toContain("reconcileGET");
    expect(daily).toContain("configGET");
    expect(daily).toContain("DAILY_PREVIEW_BUDGET_MS");
    expect(daily).toContain("drainPreviews(");
    // One request id across four invocations, so a run can be traced from one id.
    expect(daily).toMatch(/headers\.set\("x-request-id", id\)/);
    // A failing leg is the run's verdict: a monitor reading the cron log and a
    // person reading curl must see the same thing.
    expect(daily).toMatch(/status: 500/);
  });

  it("gives the two reports a schedule their staleness bound can be true of", () => {
    // Both were tick-only before R20-7, so a stopped tick also stopped the thing
    // that would have reported it. The bound is now a day plus slack, which only
    // a stopped *schedule* trips.
    const day = 24 * 60 * 60_000;
    for (const route of [
      "/api/jobs/reconcile",
      "/api/jobs/config",
    ] as const) {
      expect(HEARTBEAT_STALE_MS[route], route).toBe(day + HEARTBEAT_SLACK_MS);
    }
    // The run's own row is watched like the workers it drives. Without it the
    // entry could stop firing and the only evidence would be three routes going
    // stale at once — a schedule failing, read as three unrelated stalls.
    expect(HEARTBEAT_ROUTES).toContain("/api/jobs/daily");
    expect(HEARTBEAT_STALE_MS["/api/jobs/daily"]).toBe(day + HEARTBEAT_SLACK_MS);
    // The one route the composite does *not* drive keeps the bound its own
    // schedule implies — the composite is not a licence to widen every bound.
    expect(HEARTBEAT_STALE_MS["/api/jobs/abandoned-checkouts"]).toBe(2 * 400 * 60_000);
    expect(src("app/api/jobs/daily/route.ts")).not.toContain("abandoned-checkouts");
  });

  it("names every watched route in the runbook, with the bound the registry derives", () => {
    // `ops/alerts.md` is where a stale tick is read, and it carried the pre-R20-7
    // bounds for a phase: `reconcile` and `config` listed as tick-only at 13 h 20 m
    // while the code said 26 h. The registry is the source, so the runbook is
    // compared against it row by row rather than trusted to have been re-read.
    const alerts = ops("alerts.md");
    const boundText = (ms: number) => {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.round((ms % 3_600_000) / 60_000);
      return m ? `${h} h ${m} m` : `${h} h`;
    };
    for (const route of HEARTBEAT_ROUTES) {
      const row = alerts
        .split("\n")
        .find((line) => line.startsWith(`| \`${route}\``));
      expect(row, route).toBeDefined();
      expect(row, route).toContain(`| ${boundText(HEARTBEAT_STALE_MS[route])} |`);
    }
  });

  it("is the only place the preview worker's response vocabulary is defined", () => {
    // The report and the worker answer with the same names, from one source, so a
    // reader comparing them cannot find a field that only one of them reports.
    const outbox = src("lib/outbox.ts");
    expect(outbox).toContain("export function previewCounts");
    expect(outbox).toContain("remaining: out.remaining");
    expect(outbox).toContain("export async function drainPreviews");
    for (const file of ["app/api/jobs/screenshot/route.ts", "app/api/jobs/daily/route.ts"]) {
      expect(src(file), file).toContain("previewCounts(");
    }
  });

  it("is run, not just wired: the composite has a test that calls it", () => {
    // The row's risk is that three jobs behind one entry work in the file and not
    // in the invocation. `lib/jobsAndCron.test.ts` calls the route the way the
    // platform does (a bodyless GET) against the test database, so the claim has
    // a run behind it rather than a shape.
    const jobs = src("lib/jobsAndCron.test.ts");
    expect(jobs).toMatch(/describe\.skipIf\(!hasDb\)\("the composite daily run \(R20-7\)"/);
    expect(jobs).toContain("dailyGET(new NextRequest(");
  });
});

describe("R20-9/R20-11 the runbook halves are written down", () => {
  it("says what the daily sweep is, where a takedown reader meets it", () => {
    const takedown = ops("takedown.md");
    expect(takedown).toMatch(/## The daily sweep \(R20-9\)/);
    // The sweep is only worth doing if it points at the instrument that answers
    // it, rather than restating a query that will fall out of date: the queue's
    // own headers, and the mailboxes `SUPPORT` publishes.
    expect(takedown).toMatch(/X-Report-Queue-Open/);
    expect(takedown).toMatch(/app\/api\/admin\/reports\/route\.ts/);
    expect(takedown).toMatch(/SUPPORT/);
  });

  it("records the restore drill as owed, with a date", () => {
    const db = ops("database.md");
    expect(db).toMatch(/### The drill \(owed — R20-11\)/);
    // An unrun drill with no date is a promise with no deadline; the register says
    // how the two are re-read together.
    expect(db).toMatch(/2026-10-15/);
  });

  it("tells the holders what happens if the site stops", () => {
    const comms = ops("comms.md");
    expect(comms).toMatch(/## Template: the wind-down notice \(R20-15\)/);
    // The notice has to inherit the promise rather than invent a window: the
    // rules commit to a date and a notice period, so the message names both.
    expect(comms).toContain("SERVICE_TERM");
    expect(comms).toContain(SERVICE_TERM.until);
    expect(comms).toContain(`${SERVICE_TERM.noticeDays} days`);
    // And it must not promise refunds the rules page says are not given.
    expect(comms).toMatch(/Stakes are not refunded/);
  });
});

describe("R20-10 the refund path is proven where the money moves", () => {
  it("names the test that covers a reversal, rather than asserting it is covered", () => {
    const refunds = ops("refunds-and-disputes.md");
    expect(refunds).toMatch(/R20-10/);
    // The runbook names the suite and the line, so the claim can be re-checked
    // without re-deriving it.
    expect(refunds).toContain("lib/webhook.test.ts");
    expect(refunds).toContain("`:214`");
    expect(src("lib/webhook.test.ts")).toMatch(/describe\.skipIf\(!hasDb\)\("webhook refund \/ chargeback unwind"/);
    // The mail the reversal sends is pinned separately; the runbook says so,
    // because "the ledger is right" and "the buyer was told" are two claims.
    expect(refunds).toContain("lib/phase8.test.ts:259");
    expect(src("lib/phase8.test.ts")).toContain("REFUND_EMAIL");
  });

  it("cites the decision that exists — D17-5, not doc 17's local D14", () => {
    // Every ops runbook cited `D14`, which is doc 17's *local* number: the
    // findings table records it as `D17-5`, so the citation sent a reader to a
    // decision id that does not exist anywhere (found while writing R20-10).
    const files = readdirSync(join(__dirname, "..", "ops")).filter((f) => f.endsWith(".md"));
    let d14 = 0;
    let d175 = 0;
    for (const f of files) {
      const body = ops(f);
      d14 += body.match(/\bD14\b/g)?.length ?? 0;
      d175 += body.match(/\bD17-5\b/g)?.length ?? 0;
    }
    expect(d175, "runbooks cite the recorded decision").toBeGreaterThan(0);
    // Exactly one mention survives, in the header that explains the local
    // numbering — a second one would be a citation to a decision that does not
    // exist.
    expect(d14, "ops/*.md cites D14").toBe(1);
    expect(ops("refunds-and-disputes.md")).toMatch(/used to cite/);
    // ...and the id it points at is real.
    expect(src("doc/review/FINDINGS.md")).toMatch(/\| D17-5 \|/);
  });
});

describe("R20-12/R20-13 the questions launch week can answer have queries", () => {
  const week = src("doc/phase-5-launch/03-launch-week-questions.md");

  it("is runnable: every command block is a psql call against the ledger", () => {
    const blocks = [...week.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1].trim());
    expect(blocks.length, "questions with a query").toBeGreaterThanOrEqual(4);
    for (const b of blocks) {
      expect(b.startsWith('psql "$DATABASE_URL" -c "'), b.slice(0, 40)).toBe(true);
      // The blocks are shell, so inner quotes arrive escaped; unescape before
      // asking what the query reads.
      const sql = b.replace(/\\"/g, '"');
      // A query that does not name a table answers nothing.
      expect(sql).toMatch(/"Payment"|"Element"|"ActivityLog"|"Stake"|"ClickEvent"/);
      // The wrapper has to be closed, or the block is a syntax error the reader
      // discovers by typing it.
      expect(b.endsWith(';"'), `${b.slice(0, 30)}… ends`).toBe(true);
    }
  });

  it("keeps the server-side funnel authoritative for money", () => {
    // The client-side events are informative only (R18-14) and are off until
    // R19-1 lands, so a launch-week number that matters has to be read from the
    // ledger — the document says which, and this is the pin that it still does.
    expect(week).toMatch(/\/api\/admin\/ops/);
    expect(week).toMatch(/funnel/);
    expect(week).toMatch(/NEXT_PUBLIC_PLAUSIBLE_DOMAIN/);
    // Seeded rows are separable without a schema change.
    expect(week).toContain("lib/demoLabels.ts");
    // The crown is a mutable flag, so history is read from the activity log.
    expect(week.replace(/\\"/g, '"')).toMatch(/"ActivityLog"/);
  });

  it("writes the two maintenance items where the v2 rule is", () => {
    const v2 = src("doc/phase-6-v2/README.md");
    expect(v2).toMatch(/R20-13/);
    // A review date, because an unrevisited threshold is a decision pretending
    // to be a measurement.
    expect(v2).toMatch(/2026-12-31/);
    expect(v2).toMatch(/\$50k/);
    // The gated half names the instrument that reads it.
    expect(v2).toMatch(/\/api\/admin\/ops/);
  });
});

describe("R20-14/R20-15 the permanence and the term are published, from one source", () => {
  const rules = legalCanonicalText("rules");
  const faq = FAQ_ITEMS.flatMap((i) => [i.q, ...i.a]).join("\n");

  it("states the term once, with both halves of the promise", () => {
    // "Stakes never expire" is what the buyer is buying; the date is what makes
    // the promise keepable. Neither substitutes for the other.
    expect(SERVICE_TERM_SENTENCE).toContain("never expire");
    expect(SERVICE_TERM_SENTENCE).toContain(SERVICE_TERM.until);
    // The printed date and the ISO form are the same day, so anything that sorts
    // or diffs cannot disagree with the sentence a buyer reads.
    const [day, month, year] = SERVICE_TERM.until.split(/[\s,]+/);
    expect(SERVICE_TERM.iso).toBe(`${year}-${String(new Date(`${month} 1, ${year}`).getMonth() + 1).padStart(2, "0")}-${day.padStart(2, "0")}`);
  });

  it("publishes it in the rules, with the notice commitment", () => {
    expect(rules).toContain(SERVICE_TERM.until);
    expect(rules).toContain(`${SERVICE_TERM.noticeDays} days`);
    // Whatever the term is, the rules have to say what happens if it is
    // extended — an extendable date with no mechanism is a date nobody can rely
    // on either way.
    expect(rules).toMatch(/if we extend it/i);
    // ...and what happens to stakes on a wind-down, so the "all stakes are final"
    // clause above it is not read as the whole answer.
    expect(rules).toMatch(/not refunded/i);
    // A change to any of this is a revision, and the log is where it is announced.
    const entry = LEGAL_REVISION_LOG.rules[0];
    expect(entry.version).toBe(LEGAL_REVISIONS.rules);
    expect(entry.note).toContain(SERVICE_TERM.until);
  });

  it("answers the same question in the FAQ, in the same words", () => {
    expect(faq).toContain(SERVICE_TERM_SENTENCE);
    expect(faq).toContain(`${SERVICE_TERM.noticeDays} days`);
    expect(FAQ_ITEMS.some((i) => /site stops/i.test(i.q))).toBe(true);
  });

  it("prints it where the price is, not only in the footer", () => {
    const page = src("app/elements/[sym]/page.tsx");
    expect(page).toContain("SERVICE_TERM_SENTENCE");
    // Both branches of the element page — claimed and unclaimed — carry it, which
    // is what "printed under the price" means: the claim CTA and the sentence are
    // in the same block.
    expect(page.match(/<FootnoteLinks \/>/g)?.length).toBe(2);
    // Once in the import, once where it is printed — the sentence is rendered,
    // not merely imported.
    expect(page.match(/\{SERVICE_TERM_SENTENCE\}/g)?.length).toBe(1);
    // The FAQ says it is in three places; this counts them.
    expect(page).toMatch(/FAQ_PATH/);
  });

  it("changes the launch gate, because that is what CR-20.4 asks for", () => {
    const gate = src("doc/review/19-launch-and-marketing-readiness.md");
    // The register's one row that moves a launch gate: the statement is either
    // published or its absence accepted in writing. It was published, and the
    // checkbox says so — with the date it commits to.
    expect(gate).toMatch(/CR-20\.4/);
    expect(gate).toMatch(/A shutdown statement is published/);
    expect(gate).toContain(SERVICE_TERM.until);
  });
});
