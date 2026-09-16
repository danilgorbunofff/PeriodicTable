/* R02-7: each legal document describes itself.

   All three slugs are statically generated, and all three served the root
   layout's title and description before this: a search result or a pasted link
   for `/legal/rules` advertised the board's marketing copy, and nothing in the
   document said which page it was. The metadata is built from the same copy the
   page body renders, so a title cannot describe a page that says something else.

   The wiring — that Next actually calls this for every slug — only exists once
   the route runs, so it is locked by reading the page, the way lib/shareMeta.test.ts
   locks the layout. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { legalMetadata } from "./legalMeta";
import type { LegalPageCopy } from "./legalMeta";
import { LEGAL_PAGES } from "./legalDocs";
import { LEGAL_SLUGS } from "./legal";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const ORIGIN = "https://www.periodictable.lol";
const PAGE = "app/legal/[slug]/page.tsx";

/** The documents, as the corpus declares them. The copy moved out of the route
 * in the phase-16 fix pass, so it is imported rather than parsed out of source. */
const SLUGS = LEGAL_SLUGS;
const copy = (slug: (typeof SLUGS)[number]): LegalPageCopy => {
  const page = LEGAL_PAGES[slug];
  return { title: page.title, desc: page.desc };
};

describe("legal metadata (R02-7)", () => {
  it("titles the document with its own name and the site", () => {
    const meta = legalMetadata("rules", { title: "Rules & payments", desc: "The floor." }, { NEXT_PUBLIC_APP_URL: ORIGIN });
    expect(meta.title).toBe("Rules & payments · periodictable.lol");
    expect(meta.description).toBe("The floor.");
  });

  it("canonicalises each slug at its own absolute URL", () => {
    for (const slug of SLUGS) {
      const meta = legalMetadata(slug, copy(slug), { NEXT_PUBLIC_APP_URL: ORIGIN });
      expect(meta.alternates).toEqual({ canonical: `${ORIGIN}/legal/${slug}` });
    }
  });

  it("unfurls as the document it is, not as the board", () => {
    const meta = legalMetadata("contact", copy("contact"), { NEXT_PUBLIC_APP_URL: ORIGIN });
    expect(meta.openGraph).toMatchObject({
      type: "article",
      url: `${ORIGIN}/legal/contact`,
      title: "Contact · periodictable.lol",
      description: copy("contact").desc,
    });
    expect(meta.twitter).toMatchObject({ title: "Contact · periodictable.lol", description: copy("contact").desc });
  });

  it("follows the configured host rather than a hardcoded one", () => {
    const meta = legalMetadata("about", copy("about"), { NEXT_PUBLIC_APP_URL: "https://ptl-git-main.vercel.app" });
    expect(meta.alternates).toEqual({ canonical: "https://ptl-git-main.vercel.app/legal/about" });
  });

  it("never publishes a title identical to another slug's", () => {
    const titles = SLUGS.map((slug) => legalMetadata(slug, copy(slug), {}).title);
    expect(new Set(titles).size).toBe(SLUGS.length);
    for (const title of titles) expect(title).toMatch(/periodictable\.lol$/);
  });

  it("describes each page with its own sentence, not the layout's", () => {
    const descs = SLUGS.map((slug) => legalMetadata(slug, copy(slug), {}).description);
    expect(new Set(descs).size).toBe(SLUGS.length);
    for (const desc of descs) expect(String(desc).length).toBeGreaterThan(60);
  });
});

describe("the route is wired to it (R02-7)", () => {
  it("exports generateMetadata beside generateStaticParams", () => {
    const s = src(PAGE);
    expect(s).toMatch(/export function generateStaticParams\(\)/);
    expect(s).toMatch(/export function generateMetadata\(\{ params \}: \{ params: \{ slug: string \} \}\): Metadata/);
    expect(s).toMatch(/return legalMetadata\(params\.slug, page\)/);
  });

  it("keeps the metadata and the body reading the same copy", () => {
    const s = src(PAGE);
    // Both the title and the description handed to legalMetadata come from the
    // LEGAL_PAGES entry the page body renders, so they cannot drift apart.
    expect(s).toMatch(/const page = LEGAL_PAGES\[params\.slug as LegalSlug\];/);
    expect(s).toMatch(/if \(!page\) return \{\};/);
  });

  it("generates a route for every document the corpus declares", () => {
    const s = src(PAGE);
    expect(s).toMatch(/Object\.keys\(LEGAL_PAGES\) as LegalSlug\[\]/);
    for (const slug of SLUGS) {
      const page = LEGAL_PAGES[slug];
      expect(page.desc.length).toBeGreaterThan(60);
      expect(page.sections.length).toBeGreaterThan(0);
      expect(page.sections.every((sec) => sec.ps.length > 0 || sec.h === "Operator")).toBe(true);
    }
  });

  it("still 404s an unknown slug through the app's own boundary", () => {
    expect(src(PAGE)).toMatch(/if \(!page\) return notFound\(\);/);
  });
});
