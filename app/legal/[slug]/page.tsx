import Link from "next/link";
import { notFound } from "next/navigation";

const PAGES: Record<string, { title: string; body: string[] }> = {
  about: {
    title: "About & disclaimer",
    body: [
      "periodictable.lol is an uncapped, multi-tenant staking leaderboard for startup advertising on a living periodic table.",
      "Periodic data: IUPAC Standard. Classifications are illustrative, not a chemical statement.",
      "Anyone can list any link — a listing doesn't imply the company added it. Report abuse from any rank row.",
    ],
  },
  rules: {
    title: "Rules & payments",
    body: [
      "Floor: $5 for the first stake on an element and for any new join. Takeover: current #1 total + $1 (integer dollars).",
      "Stake is cumulative equity and never expires. Reclaim = (current #1 + $1) − your prior stake, floored at $1.",
      "No refunds, no withdrawals — stake = ad inventory. Secure payment via Whop. By continuing you agree to the rules & terms.",
    ],
  },
  contact: {
    title: "Contact",
    body: ["Abuse / DMCA / takedowns: use the report button on any rank row, or email ops via your receipt footer."],
  },
};

export function generateStaticParams() {
  return Object.keys(PAGES).map((slug) => ({ slug }));
}

export default function LegalPage({ params }: { params: { slug: string } }) {
  const page = PAGES[params.slug];
  if (!page) return notFound();
  return (
    <main className="min-h-screen bg-profilebg text-ink">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <Link href="/" className="text-sm font-bold text-mutedink hover:text-ink">← the table</Link>
        <h1 className="font-display text-2xl font-bold mt-3">{page.title}</h1>
        {page.body.map((p) => (
          <p key={p.slice(0, 24)} className="text-sm text-mutedink mt-2 leading-relaxed">{p}</p>
        ))}
        <div className="text-xs text-mutedink mt-6">About & disclaimer · Rules & payments · Contact</div>
      </div>
    </main>
  );
}
