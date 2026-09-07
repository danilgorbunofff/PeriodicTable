import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "../../../lib/prisma";
import { ELEMENTS } from "../../../lib/elements";
import { FAMILY_FILL } from "../../../lib/familyFill";
import { Avatar } from "../../../components/Avatar";

export const dynamic = "force-dynamic";

function rankTitle(n: number) {
  if (n >= 5) return "Emperor";
  if (n >= 2) return "Contender";
  return "Claimer";
}

export default async function Profile({ params }: { params: { domain: string } }) {
  const domain = decodeURIComponent(params.domain);
  const startup = await prisma.startup.findUnique({
    where: { domain },
    include: {
      stakes: { include: { element: { select: { symbol: true, name: true, family: true } } } },
    },
  });
  if (!startup || startup.stakes.length === 0) return notFound();

  const stakes = startup.stakes;
  const held = new Set(stakes.map((s) => s.element.symbol)).size;
  const crowns = stakes.filter((s) => s.isLeader).length;
  const total = stakes.reduce((a, s) => a + s.amountUsd, 0);
  const clicks = stakes.reduce((a, s) => a + s.clicksDelivered, 0);
  const title = rankTitle(held);

  // per held element: full board for that element (to show rank context)
  const heldSymbols = [...new Set(stakes.map((s) => s.element.symbol))];
  const elementBoards = await Promise.all(
    heldSymbols.map(async (sym) => {
      const rows = await prisma.stake.findMany({
        where: { element: { symbol: sym } },
        orderBy: [{ amountUsd: "desc" }, { id: "asc" }],
        include: { startup: { select: { domain: true } }, element: { select: { symbol: true, name: true, family: true } } },
      });
      const el = ELEMENTS.find((e) => e.symbol === sym);
      return { symbol: sym, name: rows[0]?.element.name ?? el?.name ?? sym, family: rows[0]?.element.family ?? el?.family ?? "other", rows };
    })
  );

  return (
    <div className="min-h-screen bg-profilebg text-ink">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between">
          <Link href="/" className="text-sm font-bold text-muted hover:text-ink">← the table</Link>
          <div className="bg-white rounded-full shadow px-4 py-1.5 text-sm font-display font-bold flex items-center gap-1.5">
            <span>periodictable<span className="text-money">.lol</span></span>
          </div>
        </div>

        <div className="mt-4 rounded-card p-6 text-center shadow-card" style={{ background: "linear-gradient(180deg,#FFEFC1,#FFCE4B)" }}>
          <div className="text-xs font-extrabold tracking-widest">✦ OFFICIALLY ON THE TABLE ✦</div>
          <div className="font-display text-2xl font-bold mt-1">{domain} is on the table</div>
          <div className="text-sm font-bold mt-1">{title} · {held} elements claimed</div>
        </div>

        <div className="mt-4 grid md:grid-cols-2 gap-4">
          <div className="stage-shell rounded-card p-4 text-white shadow-card">
            <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(18, 1fr)" }}>
              {ELEMENTS.map((e) => {
                const mine = heldSymbols.includes(e.symbol);
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

          <div className="bg-white rounded-card p-5 shadow-card">
            <Avatar src={startup.logoUrl} domain={domain} size={48} rounded="rounded-2xl" />
            <div className="mt-2 inline-block text-xs font-extrabold bg-icy rounded-full px-3 py-1">{title}</div>
            <div className="font-display text-xl font-bold mt-1">{domain}</div>
            <p className="text-sm text-muted mt-1">{startup.pitch}</p>
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
          {[[held, "elements"], [crowns, "#1 spots"], [stakes.length, "placements"], [clicks, "clicks"]].map(([v, l]) => (
            <div key={l as string} className="bg-white rounded-2xl p-4 shadow-card">
              <div className="font-display text-xl font-bold">{v}</div>
              <div className="text-xs text-muted">{l}</div>
            </div>
          ))}
        </div>

        <h3 className="mt-6 font-display font-bold">Elements held</h3>
        <div className="mt-2 grid md:grid-cols-2 gap-3">
          {elementBoards.map((board) => {
            const fam = board.family as keyof typeof FAMILY_FILL;
            return (
              <div key={board.symbol} className="bg-white rounded-2xl p-4 shadow-card">
                <div className="flex items-center gap-2">
                  <span className="w-9 h-9 rounded-xl grid place-items-center font-display font-bold text-sm" style={{ background: FAMILY_FILL[fam] ?? "#fff" }}>{board.symbol}</span>
                  <div>
                    <div className="font-extrabold text-sm">{board.symbol} {board.name}</div>
                    <div className="text-xs text-muted">{board.rows.length} startups bidding</div>
                  </div>
                </div>
                <div className="mt-2 flex flex-col gap-1">
                  {board.rows.map((r, i) => (
                    <div key={r.startup.domain} className={`flex items-center gap-2 text-sm px-2 py-1 rounded-xl ${r.startup.domain === domain ? "bg-goldwash" : ""}`}>
                      <span className="text-xs text-muted w-6">{i === 0 ? "👑 #1" : `#${i + 1}`}</span>
                      <span className="font-bold">{r.startup.domain}</span>
                      <span className="ml-auto font-extrabold text-money">${r.amountUsd}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-6 rounded-card p-6 flex items-center gap-4 flex-wrap shadow-card" style={{ background: "linear-gradient(180deg,#FFEFC1,#FFCE4B)" }}>
          <div>
            <div className="font-display text-lg font-bold">Start your own empire</div>
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
