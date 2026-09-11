/**
 * Server-side leaderboard math (Phase 4, P1-10).
 *
 * Pure functions over plain rows so the ranking truth is unit-testable;
 * routes fetch bounded datasets and call these. All orders are total
 * (deterministic tie-breaks) so leaderboards never shuffle between renders.
 */
import type { BoardRow, TableOrderRow } from "./api";

export type SpendRow = {
  domain: string;
  logoUrl: string;
  amountUsd: number;
  isLeader: boolean;
  elementSymbol: string;
  id: string;
  createdAt: Date | string;
};

/** Table Order: total cumulative spend across EVERY stake (not leaders only),
 * then crowns, then domain. */
export function aggregateTableOrder(stakes: SpendRow[]): TableOrderRow[] {
  const byDomain = new Map<string, { logoUrl: string; totalSpent: number; crowns: number; elements: Set<string>; topId: string; topAmount: number; topAt: number }>();
  for (const s of stakes) {
    const row = byDomain.get(s.domain) ?? { logoUrl: s.logoUrl, totalSpent: 0, crowns: 0, elements: new Set<string>(), topId: "", topAmount: -1, topAt: Infinity };
    row.totalSpent += s.amountUsd;
    if (s.isLeader) row.crowns += 1;
    row.elements.add(s.elementSymbol);
    row.logoUrl = s.logoUrl;
    // Attribute the row's outbound link to the startup's biggest stake
    // (deterministic: amount desc, then earliest createdAt, then id).
    const at = s.createdAt instanceof Date ? s.createdAt.getTime() : new Date(s.createdAt).getTime();
    if (s.amountUsd > row.topAmount || (s.amountUsd === row.topAmount && (at < row.topAt || (at === row.topAt && s.id < row.topId)))) {
      row.topId = s.id;
      row.topAmount = s.amountUsd;
      row.topAt = at;
    }
    byDomain.set(s.domain, row);
  }
  return [...byDomain.entries()]
    .map(([domain, r]) => ({ domain, logoUrl: r.logoUrl, totalSpent: r.totalSpent, crowns: r.crowns, elements: r.elements.size, stakeId: r.topId }))
    .sort((a, b) => b.totalSpent - a.totalSpent || b.crowns - a.crowns || a.domain.localeCompare(b.domain));
}

export type LeaderRow = {
  domain: string;
  logoUrl: string;
  amountUsd: number;
  elementSymbol: string;
  elementName: string;
  createdAt: Date | string;
  id: string;
};

/** By Element: biggest single-territory (leader) stake, deterministic. */
export function rankByElement(leaders: LeaderRow[]): BoardRow[] {
  return [...leaders]
    .sort((a, b) => {
      if (b.amountUsd !== a.amountUsd) return b.amountUsd - a.amountUsd;
      const ta = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt).getTime();
      const tb = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt).getTime();
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    })
    .map((l) => ({
      domain: l.domain,
      logoUrl: l.logoUrl,
      elementSym: l.elementSymbol,
      elementName: l.elementName,
      total: l.amountUsd,
    }));
}

export type CrownRow = { domain: string; logoUrl: string; crowns: number; totalSpent: number };

/** #1 Crowns: crown count, then cumulative spend, then domain. */
export function rankCrowns(rows: CrownRow[]): BoardRow[] {
  return [...rows]
    .sort((a, b) => b.crowns - a.crowns || b.totalSpent - a.totalSpent || a.domain.localeCompare(b.domain))
    .map((r) => ({
      domain: r.domain,
      logoUrl: r.logoUrl,
      elementSym: "",
      elementName: "",
      total: r.crowns,
      totalSpent: r.totalSpent,
    }));
}

export type MedalRow = {
  domain: string;
  logoUrl: string;
  medals: number;
  firstClaimedAt: Date | string;
  elementSymbol: string;
  elementName: string;
};

export type ClaimRow = {
  domain: string;
  logoUrl: string;
  elementSymbol: string;
  elementName: string;
  claimedAt: Date | string;
};

/** Early Adopter, one row per startup: how many FirstClaim records it holds and
 * which element the tile names when it says "first on <element>".
 *
 * That element must belong to the startup's EARLIEST claim, because
 * `firstClaimedAt` is what the sort and the copy both point at — naming the
 * element of some other claim would assert a "first" the row's own date
 * contradicts. Ties on an identical timestamp fall back to the element symbol
 * so the answer never depends on the order rows arrive in.
 *
 * Deliberately consumes unordered input: the caller's query order is not a
 * contract, and this must not become one. */
export function aggregateEarlyAdopters(claims: ClaimRow[]): MedalRow[] {
  const ms = (v: Date | string) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
  const byDomain = new Map<string, MedalRow>();
  for (const c of claims) {
    const row = byDomain.get(c.domain);
    if (!row) {
      byDomain.set(c.domain, {
        domain: c.domain,
        logoUrl: c.logoUrl,
        medals: 1,
        firstClaimedAt: c.claimedAt,
        elementSymbol: c.elementSymbol,
        elementName: c.elementName,
      });
      continue;
    }
    row.medals += 1;
    row.logoUrl = c.logoUrl;
    if (
      ms(c.claimedAt) < ms(row.firstClaimedAt) ||
      (ms(c.claimedAt) === ms(row.firstClaimedAt) && c.elementSymbol < row.elementSymbol)
    ) {
      row.firstClaimedAt = c.claimedAt;
      row.elementSymbol = c.elementSymbol;
      row.elementName = c.elementName;
    }
  }
  return [...byDomain.values()];
}

/** Early Adopter: first-claim medals from immutable FirstClaim records. */
export function rankEarlyAdopters(rows: MedalRow[]): BoardRow[] {
  const time = (v: Date | string) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
  return [...rows]
    .sort((a, b) => b.medals - a.medals || time(a.firstClaimedAt) - time(b.firstClaimedAt) || a.domain.localeCompare(b.domain))
    .map((r) => ({
      domain: r.domain,
      logoUrl: r.logoUrl,
      elementSym: r.elementSymbol,
      elementName: r.elementName,
      total: r.medals,
    }));
}
