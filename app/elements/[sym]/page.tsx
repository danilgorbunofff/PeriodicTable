import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ELEMENTS } from "@/lib/elements";

export const dynamicParams = true;
export const revalidate = 60;

export async function generateStaticParams() {
  return ELEMENTS.map((e) => ({ sym: e.symbol }));
}

export async function generateMetadata({ params }: { params: { sym: string } }): Promise<Metadata> {
  const symbol = decodeURIComponent(params.sym);
  const el = ELEMENTS.find((e) => e.symbol === symbol);
  if (!el) return { title: "Element not found — periodictable.lol" };
  return {
    title: `${el.name} (${el.symbol}) — startups on the table | periodictable.lol`,
    description: `Who leads ${el.name}? Live ranked stakes, prices, and claim CTA.`,
    openGraph: { title: `${el.name} (${el.symbol})`, images: [`/og/${encodeURIComponent(el.symbol)}`] },
  };
}

export default async function ElementPage({ params }: { params: { sym: string } }) {
  const symbol = decodeURIComponent(params.sym);
  const el = ELEMENTS.find((e) => e.symbol === symbol);
  let element = null;
  let hiddenStakes = 0;
  try {
    element = await prisma.element.findUnique({
      where: { symbol },
      include: {
        // Same visibility contract as /api/elements/[sym]: hidden listings
        // never reach the ranked list, so the CTA price and JSON-LD derived
        // from stakes[0] cannot disclose a concealed bid.
        stakes: {
          where: { startup: { moderationState: { not: "HIDDEN" } } },
          orderBy: { amountUsd: "desc" },
          include: { startup: { select: { domain: true, title: true, pitch: true } } },
        },
      },
    });
    if (element) {
      // stakeCount/totalPoolUsd deliberately still count every stake
      // (lib/moderation.ts: financial history is never deleted), so the page
      // owes the reader an explanation for the difference in row count.
      hiddenStakes = await prisma.stake.count({
        where: { elementId: element.id, startup: { moderationState: "HIDDEN" } },
      });
    }
  } catch {
    element = null;
  }
  if (!element) {
    // Build-time fallback without DATABASE_URL: SEO shell from static ELEMENTS.
    if (!el) return notFound();
    return (
      <main className="min-h-screen bg-profilebg text-ink">
        <div className="max-w-3xl mx-auto px-4 py-8">
          <Link href="/" className="text-sm font-bold text-mutedink hover:text-ink">← the table</Link>
          <h1 className="font-display text-3xl font-bold mt-3">
            {el.name} ({el.symbol}) — startups on the table
          </h1>
          <p className="text-sm text-mutedink mt-1">Live standings load with a database connection.</p>
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
    <main className="min-h-screen bg-profilebg text-ink">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <Link href="/" className="text-sm font-bold text-mutedink hover:text-ink">← the table</Link>
        <h1 className="font-display text-3xl font-bold mt-3">
          {el?.name ?? element.symbol} ({element.symbol}) — startups on the table
        </h1>
        <p className="text-sm text-mutedink mt-1">
          {element.stakeCount} stakers · ${element.totalPoolUsd} pool · take #1 for ${takeLead}
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
