import Link from "next/link";
import { notFound } from "next/navigation";
import { ELEMENTS } from "../../../lib/elements";
import { FAMILY_FILL } from "../../../lib/familyFill";
import { MOCK_STAKES } from "../../../mocks/startups";

function rankTitle(n: number) {
  if (n >= 5) return "Emperor";
  if (n >= 2) return "Contender";
  return "Claimer";
}

export default function Profile({ params }: { params: { domain: string } }) {
  const domain = decodeURIComponent(params.domain);
  const stakes = MOCK_STAKES.filter((s) => s.domain === domain);
  if (stakes.length === 0) return notFound();
  const first = stakes[0];
  const elements = stakes
    .map((s) => ELEMENTS.find((e) => e.symbol === s.symbol)!)
    .filter(Boolean);
  const held = new Set(elements.map((e) => e.id)).size;
  const crowns = elements.length;
  const total = stakes.reduce((a, s) => a + s.amount, 0);
  const title = rankTitle(held);

  return (
    <div className="min-h-screen bg-profilebg text-ink">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between">
          <Link href="/" className="text-sm font-bold text-muted hover:text-ink">← the table</Link>
          <div className="bg-white rounded-full shadow px-4 py-1.5 text-sm font-extrabold flex items-center gap-1.5">
            <span>periodictable<span className="text-money">.lol</span></span>
          </div>
        </div>

        <div className="mt-4 rounded-card p-6 text-center" style={{ background: "linear-gradient(180deg,#FFEFC1,#FFCE4B)" }}>
          <div className="text-xs font-extrabold tracking-widest">✦ OFFICIALLY ON THE TABLE ✦</div>
          <div className="text-2xl font-extrabold mt-1">{domain} is on the table</div>
          <div className="text-sm font-bold mt-1">{title} · {held} elements claimed</div>
        </div>

        <div className="mt-4 grid md:grid-cols-2 gap-4">
          <div className="bg-stage rounded-card p-4 text-white">
            <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(18, 1fr)" }}>
              {ELEMENTS.map((e) => {
                const mine = elements.some((m) => m.id === e.id);
                return (
                  <div
                    key={e.id}
                    title={`${e.symbol} ${e.name}`}
                    className="aspect-square rounded-[3px]"
                    style={{ background: mine ? "#FFC93C" : "rgba(255,255,255,.12)" }}
                  />
                );
              })}
            </div>
            <div className="text-xs text-white/70 mt-2">drag to pan · scroll to zoom</div>
            <div className="text-xs font-bold mt-1">{held} elements claimed</div>
          </div>

          <div className="bg-white rounded-card p-5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={first.logo} alt="" className="w-12 h-12 rounded-2xl" />
            <div className="mt-2 inline-block text-xs font-extrabold bg-icy rounded-full px-3 py-1">{title}</div>
            <div className="text-xl font-extrabold mt-1">{domain}</div>
            <p className="text-sm text-muted mt-1">{first.pitch}</p>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs font-bold">
              <span className="bg-icy rounded-full px-3 py-1">👑 {crowns}</span>
              <span className="bg-icy rounded-full px-3 py-1">${total} staked</span>
              <span className="bg-icy rounded-full px-3 py-1">{held} elements</span>
            </div>
            <a href={`https://${domain}`} target="_blank" rel="noreferrer" className="mt-4 inline-block bg-visit text-white font-extrabold rounded-btn px-5 h-11 leading-[44px] text-sm">
              Visit site ↗
            </a>
            <div className="text-xs text-muted mt-1">{domain}</div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
          {[[held, "elements"], [crowns, "#1 spots"], [stakes.length, "placements"], [stakes.reduce((a, s) => a + s.clicks, 0), "clicks"]].map(([v, l]) => (
            <div key={l as string} className="bg-white rounded-2xl p-4">
              <div className="text-xl font-extrabold">{v}</div>
              <div className="text-xs text-muted">{l}</div>
            </div>
          ))}
        </div>

        <h3 className="mt-6 font-extrabold">Elements held</h3>
        <div className="mt-2 grid md:grid-cols-2 gap-3">
          {elements.map((e) => {
            const rows = MOCK_STAKES.filter((s) => s.symbol === e.symbol).sort((a, b) => b.amount - a.amount);
            return (
              <div key={e.id} className="bg-white rounded-2xl p-4">
                <div className="flex items-center gap-2">
                  <span className="w-9 h-9 rounded-xl grid place-items-center font-extrabold text-sm" style={{ background: FAMILY_FILL[e.family] }}>{e.symbol}</span>
                  <div>
                    <div className="font-extrabold text-sm">{e.symbol} {e.name}</div>
                    <div className="text-xs text-muted">{rows.length} startups bidding</div>
                  </div>
                </div>
                <div className="mt-2 flex flex-col gap-1">
                  {rows.map((r, i) => (
                    <div key={r.domain} className={`flex items-center gap-2 text-sm px-2 py-1 rounded-xl ${r.domain === domain ? "bg-goldwash" : ""}`}>
                      <span className="text-xs text-muted w-6">{i === 0 ? "👑 #1" : `#${i + 1}`}</span>
                      <span className="font-bold">{r.domain}</span>
                      <span className="ml-auto font-extrabold text-money">${r.amount}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-6 rounded-card p-6 flex items-center gap-4 flex-wrap" style={{ background: "linear-gradient(180deg,#FFEFC1,#FFCE4B)" }}>
          <div>
            <div className="font-extrabold text-lg">Start your own empire</div>
            <div className="text-sm">Grab a seat on any element — from $5.</div>
          </div>
          <Link href="/" className="ml-auto bg-visit text-white font-extrabold rounded-btn px-5 h-11 leading-[44px] text-sm">Claim</Link>
        </div>
        <div className="text-center text-[11px] text-muted mt-4">
          Public page · standings are live. Anyone can list any link — a listing doesn&apos;t imply the company added it.
        </div>
      </div>
    </div>
  );
}
