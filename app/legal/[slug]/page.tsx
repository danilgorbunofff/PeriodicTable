import Link from "next/link";
import { notFound } from "next/navigation";

type Section = { h: string; ps: string[] };
const PAGES: Record<string, { title: string; updated: string; sections: Section[] }> = {
  about: {
    title: "About & disclaimer",
    updated: "Last updated: September 2026",
    sections: [
      {
        h: "What this is",
        ps: [
          "periodictable.lol is an advertising leaderboard built on a live periodic table. Anyone can stake money to claim an element and put a startup's link on it: the current top spender on an element holds it, and their listing is displayed publicly on the table and in the leaderboards.",
          "Stakes are cumulative — your rank on an element is the total amount you have staked there, and the top-ranked listing owns the element until someone outbids them.",
        ],
      },
      {
        h: "Independence & no endorsement",
        ps: [
          "This site is an independent creative project. It is not affiliated with, endorsed by, or connected to IUPAC or any scientific body. Element names, symbols, and atomic numbers are used referentially to describe the layout of the table; all trademarks, logos, and brand names shown in listings belong to their respective owners.",
          "A listing on the table does not mean the listed company participates in, endorses, or is even aware of this site. Every link is submitted by whoever paid for it, and a listing is paid advertising — nothing more.",
        ],
      },
      {
        h: "Third-party links & content",
        ps: [
          "Listings point to third-party websites that we do not own, operate, or vet. We are not responsible for the content, products, safety, privacy practices, or accuracy of any linked site. Visiting a linked site is at your own risk — we display the destination domain on every row before you click.",
          "We do not pre-moderate listings, but we act on reports: any listing can be reported directly from its rank row, and we remove listings that violate our rules (see Rules & payments).",
        ],
      },
      {
        h: "No warranty & liability",
        ps: [
          "The site and all content are provided \"as is\" and \"as available\" without warranties of any kind, express or implied, including availability, accuracy, or fitness for a particular purpose. Figures shown on the table and leaderboards are informational and may lag or be incorrect during outages or maintenance.",
          "To the maximum extent permitted by law, we are not liable for any indirect, incidental, or consequential damages arising from your use of this site, including any dealings between you and listed businesses or other users.",
        ],
      },
      {
        h: "Data & cookies",
        ps: [
          "We keep the minimum data needed to operate the leaderboard: payment status via our payment partner, a display name, the link you list, and the city/country your payment provider associates with the transaction. We do not sell personal data. Favicon previews are fetched from a public favicon service.",
          "Questions about your data can go to the contact channels on the Contact page.",
        ],
      },
    ],
  },
  rules: {
    title: "Rules & payments",
    updated: "Last updated: September 2026",
    sections: [
      {
        h: "Who can participate",
        ps: [
          "You must be at least 18 years old (or the age of majority where you live) and able to form a binding contract. You may not stake on behalf of someone else's payment instrument without their permission.",
          "One listing per payment per element; you may hold several elements at once.",
        ],
      },
      {
        h: "Bidding rules",
        ps: [
          "Floor: $5 — the minimum first stake on any unclaimed element, and the minimum for any new join on an already-claimed element. All amounts are in US dollars, whole numbers.",
          "Takeover: to become the top holder of an element that already has a #1, your total stake on that element must reach the current #1's total plus $1. You can stake any amount above the floor — outbidding by more than $1 is always allowed.",
          "Reclaim: if you previously staked on an element and were overtaken, the price to get back to #1 is (current #1 total + $1) minus what you already staked there, never less than $1. Your stake is cumulative equity — it never expires and is never reset.",
        ],
      },
      {
        h: "What you may list",
        ps: [
          "Links must be lawful and safe for a general audience. Prohibited: malware, phishing, scam or deceptive schemes, illegal goods or services, sexually explicit content, hate or harassment, content impersonating others, or anything that violates applicable law.",
          "We may remove or hide any listing that violates these rules or receives valid legal complaints, without refund (see below). We may also refuse or remove listings for trademark or right-of-publicity complaints from the actual rights holder.",
        ],
      },
      {
        h: "Payments",
        ps: [
          "Payments are processed securely by our payment partner (Whop). We never see or store your full card details. A stake is a one-time charge in USD; there are no subscriptions and no recurring billing.",
          "During launch, checkout may be gated to a waitlist — if the payment step shows a waitlist, that is expected and not an error.",
        ],
      },
      {
        h: "No refunds & disputes",
        ps: [
          "All stakes are final. A stake buys advertising inventory that is delivered immediately (your listing appears on the table and in leaderboards as soon as the payment settles), so we do not offer refunds, withdrawals, or cancellations — including if you are later outbid or if you change your mind.",
          "If something went wrong with a payment, contact us before disputing the charge. Chargebacks filed without first contacting us may result in the permanent removal of all your listings without refund.",
          "You are responsible for any taxes arising from your purchase under your local law.",
        ],
      },
      {
        h: "Changes",
        ps: [
          "We may update these rules as the product evolves. The version on this page is the one that applies; material changes will be announced on the site before they take effect.",
        ],
      },
    ],
  },
  contact: {
    title: "Contact",
    updated: "Last updated: September 2026",
    sections: [
      {
        h: "Abuse, takedowns & DMCA",
        ps: [
          "Fastest path: use the report button (⚑) on any rank row — it goes straight to our moderation queue with the listing attached, no account needed.",
          "For formal copyright or trademark complaints, email abuse@periodictable.lol with: (1) the element and listing domain, (2) the URL of the content you believe is infringed, (3) your contact details, and (4) a statement of good-faith belief and authority to act on behalf of the rights holder. Valid reports are actioned within 72 hours; reported listings can be hidden pending review.",
        ],
      },
      {
        h: "Payment & billing issues",
        ps: [
          "For a failed, duplicated, or incorrect charge, email payments@periodictable.lol with the receipt from your payment confirmation. Always include the email you paid with — we can only discuss billing details with the payer.",
        ],
      },
      {
        h: "Everything else",
        ps: [
          "Press, partnerships, and general questions: hello@periodictable.lol. We usually reply within 2–3 business days.",
          "This site is operated as an independent project; postal address available on request for legal correspondence.",
        ],
      },
    ],
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
        <div className="text-xs font-bold text-mutedink mt-1">{page.updated}</div>
        {page.sections.map((s) => (
          <section key={s.h} className="mt-5">
            <h2 className="font-display text-base font-bold text-ink">{s.h}</h2>
            {s.ps.map((p) => (
              <p key={p.slice(0, 24)} className="text-sm text-mutedink mt-2 leading-relaxed">{p}</p>
            ))}
          </section>
        ))}
        <div className="text-xs text-mutedink mt-8">
          <Link href="/legal/about" className="hover:text-ink hover:underline">About & disclaimer</Link>
          {" · "}
          <Link href="/legal/rules" className="hover:text-ink hover:underline">Rules & payments</Link>
          {" · "}
          <Link href="/legal/contact" className="hover:text-ink hover:underline">Contact</Link>
        </div>
      </div>
    </main>
  );
}
