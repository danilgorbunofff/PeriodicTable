import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { legalMetadata } from "../../../lib/legalMeta";
import { LEGAL_PAGES, legalSections } from "../../../lib/legalDocs";
import { LEGAL_LINKS, type LegalSlug } from "../../../lib/legal";

/* The corpus is one route rendering four documents.
 *
 * The shape is deliberate, and each part of it is load-bearing:
 *  - the copy lives in `lib/legalDocs.ts` rather than here, so a test can import
 *    it and fail when a sentence stops matching what the code actually does;
 *  - every document is plain prose with no version stamp and no revision history,
 *    because the wording on the page is the wording that applies;
 *  - nothing about the operator is rendered from configuration. The one contact
 *    point is an address inside the copy itself, so a missing environment value
 *    can never appear as a blank or a placeholder on a page a buyer reads;
 *  - a fourth document exists — `/legal/privacy` — because the data inventory has
 *    nowhere else to live.
 */

export function generateStaticParams() {
  return (Object.keys(LEGAL_PAGES) as LegalSlug[]).map((slug) => ({ slug }));
}

/** Each legal document carries its own title, description and canonical (R02-7);
 * both now come from the same object that renders the body. */
export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const page = LEGAL_PAGES[params.slug as LegalSlug];
  if (!page) return {};
  return legalMetadata(params.slug, page);
}

export default function LegalPage({ params }: { params: { slug: string } }) {
  const slug = params.slug as LegalSlug;
  const page = LEGAL_PAGES[slug];
  if (!page) return notFound();
  const sections = legalSections(slug);
  return (
    <main id="main" className="min-h-screen bg-profilebg text-ink">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <Link href="/" className="text-sm font-bold text-mutedink hover:text-ink">← the table</Link>
        <h1 className="font-display text-2xl font-bold mt-3">{page.title}</h1>
        <p className="text-sm text-mutedink mt-2 leading-relaxed">{page.desc}</p>
        {sections.map((s) => (
          <section key={s.h} className="mt-5">
            <h2 className="font-display text-base font-bold text-ink">{s.h}</h2>
            {(s.ps ?? []).map((p) => (
              <p key={p.slice(0, 24)} className="text-sm text-mutedink mt-2 leading-relaxed">{p}</p>
            ))}
            {s.bullets && (
              <ul className="mt-2 space-y-1.5">
                {s.bullets.map((b) => (
                  <li key={b.slice(0, 24)} className="text-sm text-mutedink leading-relaxed pl-4 -indent-4">• {b}</li>
                ))}
              </ul>
            )}
            {s.table && (
              <dl className="mt-2 space-y-1.5">
                {s.table.map((row) => (
                  <div key={row.label} className="text-sm text-mutedink leading-relaxed">
                    <dt className="font-bold inline">{row.label}: </dt>
                    <dd className="inline">{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        ))}
        <div className="text-xs text-mutedink mt-8">
          {LEGAL_LINKS.filter((l) => l.href !== `/legal/${slug}`).map((l, i) => (
            <span key={l.href}>
              {i > 0 && " · "}
              <Link href={l.href} className="hover:text-ink hover:underline">{l.label}</Link>
            </span>
          ))}
        </div>
      </div>
    </main>
  );
}
