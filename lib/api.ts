export const fetcher = (url: string) => fetch(url).then((r) => r.json());

/** Live leaderboard row from /api/board */
export type BoardRow = { domain: string; logoUrl: string; elementSym: string; elementName: string; total: number; totalSpent?: number };

/** Tile claim from /api/elements */
export type Claim = { price: number; contested?: boolean; logoUrl?: string };

/** Activity row from /api/activity */
export type ActivityRow = {
  domain: string;
  elementSymbol: string;
  elementName: string;
  amount: number;
  kind: string;
  city: string | null;
  createdAt: string;
};

/** Element detail from /api/elements/[sym] */
export type ElementDetail = {
  symbol: string;
  name: string;
  atomicMass: string;
  family: string;
  tier: string;
  pool: number;
  count: number;
  stakes: {
    stakeId: string;
    domain: string;
    title: string;
    pitch: string;
    logo: string;
    amount: number;
    clicks: number;
    rank: number;
    isLeader: boolean;
  }[];
  prices: { takeLead: number; joinMin: number; reclaim?: number };
};
