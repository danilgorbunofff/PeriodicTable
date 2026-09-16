import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { describeError, logError } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { ELEMENTS, findElementBySymbol } from "@/lib/elements";
import { OG_CARD } from "@/lib/ogCard";
import { siteOrigin } from "@/lib/siteUrl";

export const dynamicParams = true;
// The data window, and therefore the document's: Next derives
// `Cache-Control: s-maxage=60, stale-while-revalidate` for this route from it,
// so a visitor can be served a 60 s old page — and, for the `revalidate` window
// after a failure, the fallback shell below as if it were the page. R15-10: the
// shell is now distinguishable and logged (see the catch), and the window itself
// is left at 60 s on purpose: it is 5x *tighter* than the homepage's
// `s-maxage=31536000`, so widening the difference here is the wrong direction,
// and choosing a per-surface window is the platform decision doc 15 §9 Q4
// records (owner: 12). A crawler that lands in the window is told the standings
// are unavailable rather than being shown an element with no bidders.
export const revalidate = 60;

export async function generateStaticParams() {
  return ELEMENTS.map((e) => ({ sym: e.symbol }));
}

export async function generateMetadata({ params }: { params: { sym: string } }): Promise<Metadata> {
  const el = findElementBySymbol(decodeURIComponent(params.sym));
  if (!el) return { title: "Element not found — periodictable.lol" };
  const title = `${el.name} (${el.symbol})`;
  const description = `Who leads ${el.name}? Live ranked stakes, prices, and claim CTA.`;
  // Absolute, not relative: metadataBase is inherited from the root layout, and
  // an image URL that resolves to the request host in one environment and to
  // the canonical host in another is a card nobody can predict (R01-1).
  const card = `${siteOrigin()}/og/${encodeURIComponent(el.symbol)}`;
  return {
    title: `${el.name} (${el.symbol}) — startups on the table | periodictable.lol`,
    description,
    // One canonical per entity: the table's CTA visits `/?el=<sym>` instead of
    // this page, but the page itself is the indexable one (R01-4).
    alternates: { canonical: `/elements/${encodeURIComponent(el.symbol)}` },
    openGraph: {
      title,
      description,
      url: `/elements/${encodeURIComponent(el.symbol)}`,
      images: [{ url: card, width: OG_CARD.width, height: OG_CARD.height, alt: `${title} on periodictable.lol` }],
    },
    // Declared rather than inherited: without these, X falls back to the root
    // layout's card and every element page shares as the home card.
    twitter: { card: "summary_large_image", title, description, images: [card] },
  };
}

export default async function ElementPage({ params }: { params: { sym: string } }) {
  const symbol = decodeURIComponent(params.sym);
  const el = findElementBySymbol(symbol);
  // Canonical casing (R04-4): every casing of a known symbol is the same page,
  // so send `/elements/au` to `/elements/Au` instead of rendering a duplicate
  // that claims its own canonical URL and ranks against it.
  if (el && el.symbol !== symbol) redirect(`/elements/${encodeURIComponent(el.symbol)}`);
  // A symbol the inventory does not author is a 404 in every deployment,
  // database or not — resolved before any query so a typo'd URL can never be
  // answered with a page about a real element (R15-10).
  if (!el) notFound();
  let element = null;
  let hiddenStakes = 0;
  let dbFailed = false;
  try {
    element = await prisma.element.findUnique({
      where: { symbol: el.symbol },
      include: {
        // Same visibility contract as /api/elements/[sym]: hidden listings
        // never reach the ranked list, so the CTA price and JSON-LD derived
        // from stakes[0] cannot disclose a concealed bid. Fully reversed
        // stakes (amountUsd 0) are rows, not bids, and are left out too (R09-4)
        // — the stored aggregates still count them.
        stakes: {
          where: { startup: { moderationState: { not: "HIDDEN" } }, amountUsd: { gt: 0 } },
          orderBy: { amountUsd: "desc" },
          include: { startup: { select: { domain: true, title: true, pitch: true } } },
        },
      },
    });
    if (element) {
      // stakeCount/totalPoolUsd deliberately still count every stake
      // (lib/moderation.ts: financial history is never deleted), so the page
      // owes the reader an explanation for the difference in row count — and
      // it reads the visible+live rows rather than stakeCount, which also
      // counts fully reversed rows (R09-4).
      hiddenStakes = await prisma.stake.count({
        where: { elementId: element.id, startup: { moderationState: "HIDDEN" } },
      });
    }
  } catch (err) {
    // R15-10: this used to be `catch {}` — the page silently rendered the
    // build-time shell while the log said nothing, so a total database outage
    // was indistinguishable from a quiet element, from the outside *and* from
    // the inside. The failure is now recorded (page + symbol, never a value from
    // the request) and the shell says which of the two states it is showing.
    element = null;
    dbFailed = true;
    logError("page", "element-read-failed", {
      page: "element",
      symbol: el.symbol,
      error: describeError(err),
    });
  }
  if (!element) {
    // Build-time fallback without DATABASE_URL, or a failed read at request
    // time. `el` is known to exist here (checked above), so this is never a
    // masquerade of a missing element.
    return (
      <main id="main" className="min-h-screen bg-profilebg text-ink">
        <div className="max-w-3xl mx-auto px-4 py-8">
          <Link href="/" className="text-sm font-bold text-mutedink hover:text-ink">← the table</Link>
          <h1 className="font-display text-3xl font-bold mt-3">
            {el.name} ({el.symbol}) — startups on the table
          </h1>
          <p className="text-sm text-mutedink mt-1">
            {dbFailed
              ? "Live standings are temporarily unavailable. Reload in a moment — the table itself is still up."
              : "Live standings load with a database connection."}
          </p>
          <Link
            href={`/?el=${encodeURIComponent(el.symbol)}&stake=5`}
            className="mt-4 inline-block bg-cta font-extrabold rounded-btn px-5 h-11 leading-[44px] text-sm"
          >
            Claim a spot — from $5
          </Link>
          <p className="text-[11px] text-mutedink mt-3">
            Periodic data: IUPAC Standard. Classifications are illustrative, not a chemical statement.
          </p>
        </div>
      </main>
    );
  }
  // Same "row 0 is not necessarily the leader" rule as /api/elements/[sym]:
  // a reversed $0 stake must not price the takeover at $1.
  const lead = element.stakes.find((s) => s.amountUsd > 0);
  const takeLead = lead ? lead.amountUsd + 1 : 5;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${element.symbol} leaderboard`,
    itemListElement: element.stakes.slice(0, 10).map((s, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: s.startup.domain,
    })),
  };
  return (
    <main id="main" className="min-h-screen bg-profilebg text-ink">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <Link href="/" className="text-sm font-bold text-mutedink hover:text-ink">← the table</Link>
        <h1 className="font-display text-3xl font-bold mt-3">
          {el?.name ?? element.symbol} ({element.symbol}) — startups on the table
        </h1>
        <p className="text-sm text-mutedink mt-1">
          {element.stakes.length + hiddenStakes} stakers · ${element.totalPoolUsd} pool · take #1 for ${takeLead}
        </p>
        <table className="mt-4 w-full bg-white rounded-2xl overflow-hidden text-sm">
          <tbody>
            {element.stakes.map((s, i) => (
              <tr key={s.id} className="border-b last:border-0 border-icy">
                <td className="px-4 py-2 font-bold text-mutedink">#{i + 1}</td>
                <td className="px-4 py-2 font-bold">{s.startup.domain}</td>
                <td className="px-4 py-2 text-moneyink font-extrabold text-right">${s.amountUsd}</td>
              </tr>
            ))}
            {element.stakes.length === 0 && (
              <tr><td className="px-4 py-3 text-mutedink">No bids yet — be the first for $5.</td></tr>
            )}
            {hiddenStakes > 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-3 text-mutedink">
                  {hiddenStakes === 1 ? "1 listing is" : `${hiddenStakes} listings are`} hidden from this
                  table by moderation. The pool and staker count above still include{" "}
                  {hiddenStakes === 1 ? "it" : "them"}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Link
          href={`/?el=${encodeURIComponent(element.symbol)}&stake=${takeLead}`}
          className="mt-4 inline-block bg-cta font-extrabold rounded-btn px-5 h-11 leading-[44px] text-sm"
        >
          Claim a spot — for ${takeLead}
        </Link>
        <p className="text-[11px] text-mutedink mt-3">
          Periodic data: IUPAC Standard. Classifications are illustrative, not a chemical statement.
        </p>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      </div>
    </main>
  );
}
