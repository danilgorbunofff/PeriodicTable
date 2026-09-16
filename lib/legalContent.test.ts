/* R16-1, R16-2, R16-3, R16-4, R16-6, R16-7, R16-11, R16-13: the copy lock.

   Doc 16's central finding was that the four documents could say anything,
   because every claim in them had to be verified by reading served HTML: the
   copy lived inline in the route component, so nothing could be imported and
   asserted against. The fix pass moved it into `lib/legalDocs.ts` and this file
   is the reason that move was worth doing.

   What is locked here:
     - the digest of each document, so an edit to the words fails the suite until
       someone consciously bumps `LEGAL_REVISIONS` and records what changed;
     - the claims that a finding turned into a code change (the icon proxy, the
       analytics event list, the processor list, the mailboxes), each checked
       against the constant the code itself uses, so prose and behaviour cannot
       drift apart in either direction;
     - the consent record: the words hashed are the words the modal renders, and
       a stale version is refused rather than recorded.

   The digests are meant to be updated — in the same commit as the revision bump
   and the new revision-log entry, never on their own. */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  DESCRIPTOR_SENTENCE,
  LEGAL_PAGES,
  OWNERSHIP_SENTENCE,
  PRIVACY_PROCESSORS,
  STAKE_SENTENCE,
  TAX_SENTENCE,
  legalCanonicalText,
  legalSections,
} from "./legalDocs";
import {
  CONSENT_STATEMENT,
  LEGAL_LINKS,
  LEGAL_REVISIONS,
  LEGAL_REVISION_LOG,
  LEGAL_SLUGS,
  RECEIPT_TAX_LINE,
  SUPPORT,
  type LegalSlug,
} from "./legal";
import {
  ATTEST_VERSION,
  CONSENT_TEXT_HASH,
  attestVersionRefusal,
  consentRecord,
  consentTextHash,
} from "./consent";
import { ANALYTICS_EVENTS } from "./analytics";

/** sha256 of the canonical text — the same string the page renders, minus the
 * operator's own lines, which are deployment configuration. */
const digest = (slug: LegalSlug) =>
  createHash("sha256").update(legalCanonicalText(slug), "utf8").digest("hex");

const text = (slug: LegalSlug) => legalCanonicalText(slug);

/** Every digest as of the phase-16 fix pass. A failure here is not a broken
 * test: it is the copy asking to be versioned. */
const DIGESTS: Record<LegalSlug, string> = {
  about: "78df6b30c09b8c39ee749e861373da556cbec00e68bd02451342134020cda1fd",
  rules: "a338b41854e569939324ff77c3e5856461a850800867cddf8c23bf52064b68de",
  contact: "745291c0457b00967ccd9c377c7b862d1511d03353c80ec3fddb520419982008",
  privacy: "7543e10c8633c3b3b3abafec37e0b056b36104e96649f3f78befe404bda0215d",
};

describe("legal corpus", () => {
  it("has a page for every slug, and a slug for every page", () => {
    expect(Object.keys(LEGAL_PAGES).sort()).toEqual([...LEGAL_SLUGS].sort());
    for (const slug of LEGAL_SLUGS) {
      const page = LEGAL_PAGES[slug];
      expect(page.title.length).toBeGreaterThan(1);
      expect(page.desc.length).toBeGreaterThan(1);
      expect(page.sections.length).toBeGreaterThan(0);
    }
  });

  it("renders no empty section, and no section that is prose-less unless the operator fills it", () => {
    for (const slug of LEGAL_SLUGS) {
      for (const s of LEGAL_PAGES[slug].sections) {
        expect(s.h.length).toBeGreaterThan(1);
        if (s.h === "Operator") {
          // The one deliberate placeholder: filled from configuration (R16-11).
          expect(s.ps).toEqual([]);
          continue;
        }
        expect(s.ps.length + (s.bullets?.length ?? 0) + (s.table?.length ?? 0)).toBeGreaterThan(0);
      }
    }
  });

  it("prints the operator's lines into the Operator section and nowhere else", () => {
    const lines = ["Legal entity, established in Testland", "Descriptor: TEST"];
    const sections = legalSections("about", lines);
    expect(sections.find((s) => s.h === "Operator")?.ps).toEqual(lines);
    expect(sections.length).toBe(LEGAL_PAGES.about.sections.length);
  });

  it("carries a revision stamp and a log entry for every document", () => {
    for (const slug of LEGAL_SLUGS) {
      const version = LEGAL_REVISIONS[slug];
      expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const log = LEGAL_REVISION_LOG[slug];
      expect(log.length).toBeGreaterThan(0);
      // The stamp printed on the page is the newest logged revision.
      expect(log[0].version).toBe(version);
      expect(log[0].note.length).toBeGreaterThan(20);
      // And the page quotes it, so a stamp cannot be edited out of the document.
      expect(text(slug)).toContain(version);
    }
  });

  it("fails the copy lock when the words change without a version bump", () => {
    for (const slug of LEGAL_SLUGS) {
      expect(digest(slug), `the ${slug} copy changed — bump LEGAL_REVISIONS and log it`).toBe(DIGESTS[slug]);
    }
  });

  it("keeps every soft reference out of the documents — no URL, no hostname", () => {
    // The corpus names companies; it never hands the reader a link that would
    // send their browser to one (R16-3). Everything a visitor is asked to visit
    // is either our own route or a mailbox.
    for (const slug of LEGAL_SLUGS) {
      const body = text(slug);
      expect(body).not.toMatch(/https?:\/\//);
      expect(body).not.toMatch(/www\./);
      expect(body).not.toContain(".io");
    }
  });

  it("describes the icon fetch as our server's, and never as the browser's (R16-3)", () => {
    const privacy = text("privacy");
    expect(privacy).toContain("/api/favicon");
    expect(privacy).toContain("our own server fetches the icon");
    expect(text("about")).toContain("listing icons are fetched by our server");
    // The two halves of the finding, stated as facts the product enforces:
    // the proxy exists (lib/screenshots.ts + app/api/favicon/route.ts) and the
    // live screenshot stream is gone.
    expect(privacy).toContain("Listing screenshots are captured by our servers");
    expect(privacy).toMatch(/On a normal page view: none\./);
  });

  it("lists the analytics events it would send, from the constant the code sends (R16-3)", () => {
    const privacy = text("privacy");
    for (const event of ANALYTICS_EVENTS) expect(privacy).toContain(event);
    expect(privacy).toContain("plus an aggregate pageview count");
    // The switch is named, and the page says it is off. Both are true today:
    // `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is unset in production (doc 16 §5.1).
    expect(privacy).toContain("NEXT_PUBLIC_PLAUSIBLE_DOMAIN");
    expect(privacy).toContain("Analytics is off in production");
    // R18-13: the gate is described in the same paragraph as the switch, so the
    // page cannot promise a notice the code does not render.
    expect(privacy).toContain("does not load until you say yes");
    expect(privacy).toContain("A visitor who never answers makes no request to Plausible at all");
  });

  it("names every processor in the processor list, in the page that lists processors (R16-2)", () => {
    const privacy = text("privacy");
    for (const processor of PRIVACY_PROCESSORS) {
      expect(privacy).toContain(processor.name);
      expect(processor.text.length).toBeGreaterThan(20);
    }
    // Names present, and used once each — a duplicate entry would hide a missing
    // processor behind a repeated name.
    expect(new Set(PRIVACY_PROCESSORS.map((p) => p.name)).size).toBe(PRIVACY_PROCESSORS.length);
  });

  it("publishes exactly the mailboxes the product publishes, and no others", () => {
    const quoted = new Set<string>();
    for (const slug of LEGAL_SLUGS) {
      for (const m of text(slug).matchAll(/[a-z]+@periodictable\.lol/g)) quoted.add(m[0]);
    }
    for (const address of Object.values(SUPPORT)) expect(quoted.has(address)).toBe(true);
    // `hi@` is the sender on outbound mail, not a request mailbox.
    const known = new Set([...Object.values(SUPPORT), "hi@periodictable.lol"]);
    for (const address of quoted) expect(known.has(address)).toBe(true);
  });

  it("defines the vocabulary it uses, in the documents that use it (R16-10)", () => {
    expect(text("about")).toContain(OWNERSHIP_SENTENCE);
    expect(text("about")).toContain(STAKE_SENTENCE);
    expect(text("rules")).toContain(STAKE_SENTENCE);
  });

  it("states the tax position rather than implying one (R16-4, U16-1)", () => {
    const rules = text("rules");
    expect(rules).toContain(TAX_SENTENCE);
    expect(rules).toContain(DESCRIPTOR_SENTENCE);
    // The receipt's line is the same fact from the payer's side: no tax was
    // added, because the merchant of record remits it out of the price. The two
    // must not contradict — a receipt that added tax it never charged, or a
    // rules page silent about who remits it, is the failure mode here.
    expect(RECEIPT_TAX_LINE).toContain("No tax was added");
    expect(rules).toContain("it determines and remits that tax");
  });

  it("leaves no blank or placeholder printed as a fact", () => {
    for (const slug of LEGAL_SLUGS) {
      const body = text(slug);
      expect(body).not.toMatch(/\b(TBD|TODO|FIXME|XXX|Lorem)\b/i);
      // The operator values render as explicit blanks, never as their own names.
      expect(body).not.toContain("OPERATOR_UNPUBLISHED");
      expect(body).not.toMatch(/\{\{|\}\}/);
    }
  });

  it("is reachable: every document the corpus defines is also linked from the chrome (R16-13)", () => {
    const hrefs = LEGAL_LINKS.map((l) => l.href);
    for (const slug of LEGAL_SLUGS) expect(hrefs).toContain(`/legal/${slug}`);
    expect(hrefs.length).toBe(LEGAL_SLUGS.length);
  });
});

describe("consent record", () => {
  it("is the revision the checkout prints and the document stamps", () => {
    expect(ATTEST_VERSION).toBe(LEGAL_REVISIONS.rules);
    expect(CONSENT_STATEMENT).toContain("I am 18+");
  });

  it("hashes the words the modal shows, under the version it shows", () => {
    expect(CONSENT_TEXT_HASH).toBe(consentTextHash(CONSENT_STATEMENT));
    expect(CONSENT_TEXT_HASH).toMatch(/^[0-9a-f]{64}$/);
    // Digest depends on both inputs — a version bump alone must change it, or a
    // payment recorded under the old words would look like it honoured the new.
    expect(consentTextHash(CONSENT_STATEMENT, "2020-01-01")).not.toBe(CONSENT_TEXT_HASH);
    expect(consentTextHash(CONSENT_STATEMENT + ".")).not.toBe(CONSENT_TEXT_HASH);
  });

  it("records all three fields, at the moment it is asked", () => {
    const now = new Date("2026-09-16T10:00:00.000Z");
    expect(consentRecord(now)).toEqual({
      consentVersion: ATTEST_VERSION,
      consentTextHash: CONSENT_TEXT_HASH,
      consentAt: now,
    });
  });

  it("tolerates an absent version and refuses a stale one (R16-7)", () => {
    expect(attestVersionRefusal(undefined)).toBeNull();
    expect(attestVersionRefusal(null)).toBeNull();
    expect(attestVersionRefusal("")).toBeNull();
    expect(attestVersionRefusal(ATTEST_VERSION)).toBeNull();

    const stale = attestVersionRefusal("2020-01-01");
    expect(stale).toBeTruthy();
    expect(stale).toContain("Rules & payments");
    // A malformed value is not a version claim — asked to reload, not told
    // their terms are out of date.
    for (const junk of [true, 42, {}, []]) {
      expect(attestVersionRefusal(junk)).toBe("Please reload the page and try again.");
    }
  });
});
