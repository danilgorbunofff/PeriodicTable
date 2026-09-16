/* Review 19 — launch and marketing readiness, R19-3 … R19-8.

   Batch 5's last pass is about what a stranger meets in the first five minutes:
   an empty panel that reads as broken, an answer to "what does this cost" that
   lives nowhere, a price ladder restated by hand in four surfaces, three mail
   addresses that may bounce, and a launch-day runbook that named a payment
   provider the product does not use. None of that is a runtime defect, so none of
   it is caught by a behavioural test — these read the sources and documents the
   way lib/a11y.test.ts and lib/datasetGeometry.test.ts do.

   The pins are deliberately about *provenance*, not prose: the FAQ must quote the
   constants `lib/pricing.ts` enforces, the runbook must not name a column or a
   provider that does not exist, and the seed list must describe the rows the
   seeder actually writes. A test that matched a sentence would pass while the
   sentence went wrong. */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { MIN_STAKE, TAKEOVER_MARGIN, TIE_CLEARANCE } from "./pricing";
import { FAQ_PATH, FAQ_REVISED } from "./faq";
import { FAQ_ITEMS, FAQ_META } from "./faqDocs";
import { twitterSite } from "./shareMeta";
import { NO_STAKES_YET } from "./activityFace";
import { SUPPORT } from "./legal";
import { REQUIRED_PROD_ENV } from "./env";

const src = (p: string) =>
  readFileSync(join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

describe("R19-3 the board says something when nobody has staked", () => {
  it("has one empty-state sentence, exported where the panel can import it", () => {
    expect(NO_STAKES_YET).toBeTruthy();
    expect(src("lib/activityFace.ts")).toMatch(/export const NO_STAKES_YET/);
  });

  it("the Table Order panel renders it instead of an empty list", () => {
    const order = src("components/WorldOrder.tsx");
    expect(order).toMatch(/import \{[^}]*NO_STAKES_YET[^}]*\} from "\.\.\/lib\/activityFace"/);
    expect(order).toMatch(/\{NO_STAKES_YET\}/);
    // The branch has to exist before the rows are mapped, or the sentence is dead
    // code the moment a single row lands.
    expect(order).toMatch(/rows\.length === 0/);
  });
});

describe("R19-4 the questions have a page of their own", () => {
  it("serves /faq as a real route with its own document identity", () => {
    expect(FAQ_PATH).toBe("/faq");
    expect(existsSync(join(__dirname, "..", "app", "faq", "page.tsx"))).toBe(true);
    const page = src("app/faq/page.tsx");
    // Same builder as the legal shell (R02-7 extended), so /faq cannot advertise
    // the board's title the way /legal/rules once did.
    expect(page).toMatch(/staticDocMetadata\(FAQ_PATH/);
    expect(page).toMatch(/FAQ_ITEMS/);
    // Exactly one main landmark — lib/a11y.test.ts counts these per route.
    expect(page.match(/id="main"/g)?.length).toBe(1);
  });

  it("answers the questions a buyer asks, and every number is the enforced one", () => {
    expect(FAQ_ITEMS.length).toBeGreaterThanOrEqual(8);
    for (const item of FAQ_ITEMS) {
      expect(item.q.trim().length).toBeGreaterThan(0);
      expect(item.a.length).toBeGreaterThan(0);
      for (const para of item.a) expect(para.trim().length).toBeGreaterThan(0);
    }
    const copy = FAQ_ITEMS.flatMap((i) => i.a).join("\n");
    // The floor, the takeover margin and the tie rule appear as the numbers the
    // engine enforces...
    expect(copy).toContain(`$${MIN_STAKE}`);
    expect(copy).toContain(`$${TAKEOVER_MARGIN}`);
    expect(copy).toContain(`$${TIE_CLEARANCE}`);
    // ...and the *source* never states one by hand: the answers interpolate, which
    // is why the rendered "$5" above cannot drift when the floor moves.
    const sources = src("lib/faqDocs.ts");
    expect(sources).toMatch(/MIN_STAKE|TAKEOVER_MARGIN|TIE_CLEARANCE/);
    expect(sources).not.toMatch(/(?<!\$)\$5(?!\d)/);
    expect(FAQ_META.title.length).toBeGreaterThan(0);
  });

  it("quotes the corpus's own definitions rather than paraphrasing them", () => {
    const docs = src("lib/legalDocs.ts");
    const faqDocs = src("lib/faqDocs.ts");
    expect(faqDocs).toMatch(/import \{[^}]*STAKE_SENTENCE[^}]*\} from "\.\/legalDocs"/);
    for (const sentence of ["STAKE_SENTENCE", "OWNERSHIP_SENTENCE"]) {
      expect(docs).toContain(`export const ${sentence}`);
      expect(faqDocs).toContain(sentence);
    }
  });

  it("is reachable from the help modal, the checkout and the element page", () => {
    const modals = src("components/Modals.tsx");
    expect(modals).toMatch(/import \{[^}]*FAQ_PATH[^}]*\} from "\.\.\/lib\/faq"/);
    // Two placements: the help modal (what a stranger opens first) and the last
    // screen before paying.
    expect(modals.match(/href=\{FAQ_PATH\}/g)?.length).toBe(2);
    expect(src("app/elements/[sym]/page.tsx")).toMatch(/href=\{FAQ_PATH\}/);
    expect(src("components/Modals.tsx")).not.toMatch(/About & disclaimer · Rules & payments/);
  });

  it("is in the sitemap with its own lastmod, after the legal block", () => {
    const data = src("lib/sitemapData.ts");
    expect(data).toMatch(/FAQ_PATH/);
    expect(data).toMatch(/FAQ_REVISED/);
    expect(FAQ_REVISED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("R19-5 the rules are one click from where the decision is made", () => {
  it("the help modal links the documents instead of printing their names", () => {
    const modals = src("components/Modals.tsx");
    expect(modals).toMatch(/LEGAL_LINKS/);
    expect(modals).toMatch(/l\.href/);
  });

  it("the element page, where a symbol is chosen, links them too", () => {
    const page = src("app/elements/[sym]/page.tsx");
    expect(page).toMatch(/LEGAL_LINKS/);
    expect(page).toMatch(/FootnoteLinks/);
    // Both branches: the outage shell is a page the first cohort can land on.
    expect(page.match(/<FootnoteLinks \/>/g)?.length).toBe(2);
  });
});

describe("R19-6 no surface restates the ladder by hand", () => {
  // Comments in these files quote the retired strings on purpose ("$5 and pay only
  // the difference"), so the sweep reads code, not prose.
  const code = (p: string) =>
    src(p)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

  const surfaces = [
    "components/HeroCard.tsx",
    "components/SearchPill.tsx",
    "components/TerritoryView.tsx",
    "components/Modals.tsx",
    "app/elements/[sym]/page.tsx",
    "app/s/[domain]/page.tsx",
    "lib/ogCard.ts",
  ];

  it("every claim price is interpolated from lib/pricing.ts", () => {
    for (const file of surfaces) expect(code(file), file).not.toMatch(/(?<!\$)\$5(?!\d)/);
    expect(src("components/HeroCard.tsx")).toMatch(/\$\$\{MIN_STAKE\}/);
    expect(src("lib/ogCard.ts")).toMatch(/MIN_STAKE/);
    expect(src("app/s/[domain]/page.tsx")).toMatch(/\$\$\{MIN_STAKE\}/);
  });

  it("the takeover margin and the tie clearance are not literals in checkout copy", () => {
    const quote = src("lib/stakeQuote.ts");
    expect(quote).toMatch(/TIE_CLEARANCE/);
    expect(quote).not.toMatch(/stand \$1 clear/);
    expect(src("components/TerritoryView.tsx")).toMatch(/takeLeadPrice/);
    expect(src("components/TerritoryView.tsx")).not.toMatch(/\?\? 5/);
  });
});

describe("R19-7 one address per job, published once", () => {
  it("the sender, the report inbox and the FAQ read the same constants", () => {
    expect(SUPPORT.hi).toMatch(/^[^@\s]+@[^@\s]+$/);
    expect(SUPPORT.abuse).toMatch(/^[^@\s]+@[^@\s]+$/);
    expect(src("lib/email.ts")).toMatch(/SUPPORT\.hi/);
    expect(src("app/api/report/route.ts")).toMatch(/SUPPORT\.abuse/);
    expect(src("lib/legalDocs.ts")).toMatch(/SUPPORT\.hi|hello@/);
  });

  it("the legal corpus publishes the same three addresses the pages promise", () => {
    const faq = FAQ_ITEMS.flatMap((i) => i.a).join("\n");
    expect(faq).toContain(SUPPORT.hi);
    expect(faq).toContain(SUPPORT.abuse);
    for (const address of [SUPPORT.hi, SUPPORT.abuse, SUPPORT.billing]) {
      expect(src("lib/legal.ts")).toContain(address);
    }
  });
});

describe("R19-8 the launch-day file stops contradicting the runbook", () => {
  const gate = src("doc/phase-5-launch/02-launch-gate-runbook.md");

  it("names the provider the product uses, and no other", () => {
    expect(gate).toMatch(/Stripe/);
    expect(gate).not.toMatch(/Whop/);
    // Upstash is named once, and only to say it is not part of the deploy.
    expect(gate.match(/Upstash/g)?.length).toBe(1);
    expect(gate).toMatch(/No Upstash/);
  });

  it("hides a listing through moderation, not through a column that never existed", () => {
    expect(gate).toMatch(/moderationState = HIDDEN/);
    expect(src("prisma/schema.prisma")).toMatch(/enum ModerationState/);
    // Same rule: the retired form survives only as the correction that retires it.
    expect(gate.match(/hidden=true/g)?.length).toBe(1);
    expect(gate).toMatch(/this was `hidden=true`/);
  });

  it("starts the deploy order with the env gate the runbook starts with", () => {
    expect(gate).toMatch(/check-prod-env\.mjs/);
    expect(gate).toMatch(/audit:prod/);
    expect(gate).toMatch(/ops\/rollback\.md` is the runbook/);
  });

  it("points at a comms target that exists", () => {
    expect(existsSync(join(__dirname, "..", "doc", "phase-5-launch", "03-launch-post.md"))).toBe(false);
    // The runbook says so, rather than linking a draft that was never written.
    expect(gate.match(/03-launch-post\.md/g)?.length).toBe(1);
    expect(gate).toMatch(/There is no `03-launch-post\.md`/);
    expect(gate).toMatch(/utm_source/);
  });

  it("the gate's fallback env list is the strict list, not a shorter one", () => {
    const script = src("scripts/check-prod-env.mjs");
    const fallback = script.match(/const required = \[([\s\S]*?)\];/)?.[1] ?? "";
    const names = [...fallback.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...REQUIRED_PROD_ENV].sort());
  });

  it("the seed list describes the rows the seeder actually writes", () => {
    const csv = src("doc/phase-5-launch/seed-list.csv").trim().split("\n");
    const header = csv[0].split(",");
    expect(header).toEqual(["domain", "title", "pitch", "symbol", "amount_usd"]);
    const rows = csv.slice(1).map((line) => line.split(","));
    expect(rows.length).toBe(18);
    const seeder = src("prisma/launch-seed.ts");
    for (const row of rows) {
      // Real domains: the icon proxy needs them, and a seat carries a real
      // company's name, so the spreadsheet may not invent one.
      expect(seeder, row[0]).toContain(`domain: "${row[0]}"`);
      expect(seeder, row[0]).toContain(`symbol: "${row[3]}"`);
      // One seat per element, all at the floor: a laddered row here would be a
      // tile no $6 bid could take, so the list may not restate a price.
      expect(row[4], row[0]).toBe("5");
    }
    const symbols = [...seeder.matchAll(/symbol: "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(rows.map((row) => row[3]).sort()).toEqual(symbols);
    expect(src("doc/phase-5-launch/seed-list.csv")).not.toMatch(/aurum\.fi|acme\.dev|hydro\.dev/);
  });
});

describe("R19-9 the card credits the account, when an account exists", () => {
  it("adds twitter:site only for a configured handle", () => {
    const meta = src("lib/shareMeta.ts");
    expect(meta).toMatch(/export function twitterSite/);
    expect(meta).toMatch(/NEXT_PUBLIC_TWITTER_HANDLE/);
    expect(meta).toMatch(/\.\.\.twitterSite\(env\)/);
  });

  it("never invents a handle when the variable is unset or blank", () => {
    // The card must stay silent rather than credit an account the operator has
    // not claimed: a wrong @ is worse than no @.
    expect(twitterSite({})).toEqual({});
    expect(twitterSite({ NEXT_PUBLIC_TWITTER_HANDLE: "   " })).toEqual({});
    expect(twitterSite({ NEXT_PUBLIC_TWITTER_HANDLE: "periodictable" })).toEqual({ site: "@periodictable" });
    // ...and normalises the @ an operator will paste in either form.
    expect(twitterSite({ NEXT_PUBLIC_TWITTER_HANDLE: "@periodictable" })).toEqual({ site: "@periodictable" });
  });

  it("the three cards that render a social block all consume it", () => {
    for (const file of ["lib/shareMeta.ts", "lib/legalMeta.ts", "app/elements/[sym]/page.tsx"]) {
      expect(src(file), file).toMatch(/twitterSite\(/);
    }
  });

  it("records the tagging convention the launch posts must follow", () => {
    const runbook = src("doc/phase-5-launch/02-launch-gate-runbook.md");
    expect(runbook).toMatch(/utm_source=&utm_medium=&utm_campaign=launch/);
  });
});
