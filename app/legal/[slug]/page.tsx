import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { legalMetadata } from "../../../lib/legalMeta";
import { LEGAL_PAGES, legalSections } from "../../../lib/legalDocs";
import { LEGAL_LINKS, LEGAL_REVISIONS, LEGAL_REVISION_LOG, type LegalSlug } from "../../../lib/legal";
import { operatorLines } from "../../../lib/operator";

/* The corpus is one route rendering four documents (R16-1 … R16-14).
 *
 * What changed in the phase-16 fix pass, and why the shape is what it is:
 *  - the copy moved out of this file into `lib/legalDocs.ts`, so a test can
 *    import it and fail when a sentence stops matching the code (R16-2, R16-3);
 *  - every document prints the revision it is and carries a dated revision
 *    history, which is the announcement surface §5.7 could not find (R16-7,
 *    R16-12c);
 *  - a fourth document exists — `/legal/privacy` — because the data inventory
 *    had nowhere to live (R16-1);
 *  - the operator's identity, address and governing law render from
 *    configuration, as explicit blanks when unset (R16-11).
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
  const log = LEGAL_REVISION_LOG[slug] ?? [];
  const sections = legalSections(slug, operatorLines().map((l) => `${l.label}: ${l.value}`));
  return (
    <main id="main" className="min-h-screen bg-profilebg text-ink">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <Link href="/" className="text-sm font-bold text-mutedink hover:text-ink">← the table</Link>
        <h1 className="font-display text-2xl font-bold mt-3">{page.title}</h1>
        <div className="text-xs font-bold text-mutedink mt-1">Version {LEGAL_REVISIONS[slug]}</div>
        {sections.map((s) => (
          <section key={s.h} className="mt-5">
            <h2 className="font-display text-base font-bold text-ink">{s.h}</h2>
            {s.ps.map((p) => (
              <p key={p.slice(0, 24)} className="text-sm text-mutedink mt-2 leading-relaxed">{p}</p>
            ))}
            {s.bullets && (
              <ul className="mt-2 space-y-1.5">
                {s.bullets.map((b) => (
                  <li key={b.slice(0, 24)} className="text-sm text-mutedink leading-relaxed pl-4 -indent-4">• {b}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
        <section className="mt-6">
          <h2 className="font-display text-base font-bold text-ink">Revision history</h2>
          <ul className="mt-2 space-y-1.5">
            {log.map((r) => (
              <li key={r.version} className="text-sm text-mutedink leading-relaxed pl-4 -indent-4">
                <span className="font-bold">{r.version}</span> — {r.note}
              </li>
            ))}
          </ul>
        </section>
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
