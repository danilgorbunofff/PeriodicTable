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
  elementName: string;
};

/** Table Order: total cumulative spend across EVERY stake (not leaders only),
 * then crowns, then domain. */
export function aggregateTableOrder(stakes: SpendRow[]): TableOrderRow[] {
  const byDomain = new Map<string, { logoUrl: string; totalSpent: number; crowns: number; elements: Set<string> }>();
  for (const s of stakes) {
    const row = byDomain.get(s.domain) ?? { logoUrl: s.logoUrl, totalSpent: 0, crowns: 0, elements: new Set<string>() };
    row.totalSpent += s.amountUsd;
    if (s.isLeader) row.crowns += 1;
    row.elements.add(s.elementSymbol);
    row.logoUrl = s.logoUrl;
    byDomain.set(s.domain, row);
  }
  return [...byDomain.entries()]
    .map(([domain, r]) => ({ domain, logoUrl: r.logoUrl, totalSpent: r.totalSpent, crowns: r.crowns, elements: r.elements.size }))
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
