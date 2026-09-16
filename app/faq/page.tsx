import type { Metadata } from "next";
import Link from "next/link";
import { staticDocMetadata } from "../../lib/legalMeta";
import { FAQ_ITEMS, FAQ_META } from "../../lib/faqDocs";
import { FAQ_PATH } from "../../lib/faq";
import { LEGAL_LINKS } from "../../lib/legal";

/* The FAQ (R19-4).
 *
 * Doc 19 §5.4 found the pre-purchase questions — price, rank, what happens when
 * you are outbid, refunds, support — answered only inside legal documents a
 * buyer reaches after deciding, or in a help modal that named documents instead
 * of linking them. This route is the marketing surface those answers belonged
 * on: one static page, its own title and description (R02-7's rule, via the
 * shared `staticDocMetadata`), no revision stamp, and every sentence coming
 * from `lib/faqDocs.ts` so a test can import the copy rather than scrape it.
 *
 * Deliberately not a fifth legal document: the corpus is four, pinned by
 * `lib/legalContent.test.ts`, and a page whose copy lock is "bump a revision
 * stamp when the answers change" would weaken that lock rather than add to it.
 * The stamp lives in `FAQ_REVISED` for the sitemap's `lastmod` alone. The
 * footer's legal pill stays four links for the same reason — see the sizing
 * note in `components/FooterBar.tsx` — so the FAQ is linked from the help modal
 * (R19-5), from every element page's footnote, and from the sitemap (R19-4).
 */

export const metadata: Metadata = staticDocMetadata(FAQ_PATH, FAQ_META);

export default function FaqPage() {
  return (
    <main id="main" className="min-h-screen bg-profilebg text-ink">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <Link href="/" className="text-sm font-bold text-mutedink hover:text-ink">← the table</Link>
        <h1 className="font-display text-2xl font-bold mt-3">{FAQ_META.title}</h1>
        <div className="text-xs font-bold text-mutedink mt-1">The short answers</div>
        {FAQ_ITEMS.map((item) => (
          <section key={item.q} className="mt-5">
            <h2 className="font-display text-base font-bold text-ink">{item.q}</h2>
            {item.a.map((p) => (
              <p key={p.slice(0, 24)} className="text-sm text-mutedink mt-2 leading-relaxed">{p}</p>
            ))}
          </section>
        ))}
        <div className="text-xs text-mutedink mt-8">
          {LEGAL_LINKS.map((l, i) => (
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
