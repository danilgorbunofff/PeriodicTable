/**
 * Shared API boundary (Phase 4, P1-07 + remediation §Shared API boundary).
 *
 * - Every endpoint's wire shape is typed here (single source for server
 *   responses and client consumers).
 * - fetchJson rejects non-2xx with a structured ApiError {status, code,
 *   message} and optionally validates the payload shape via a guard.
 * - SWR consumers use fetchJson so loading / error / empty / populated
 *   states are explicit everywhere (never error bodies as business data).
 */

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type Guard<T> = (data: unknown) => data is T;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Extract {error, code} from an error JSON body (all our routes use it). */
function errorBody(json: unknown, status: number): { code: string; message: string } {
  if (isRecord(json) && typeof json.error === "string") {
    return {
      code: typeof json.code === "string" ? json.code : `HTTP_${status}`,
      message: json.error,
    };
  }
  return { code: `HTTP_${status}`, message: `Request failed (${status}).` };
}

export async function fetchJson<T>(url: string, guard?: Guard<T>): Promise<T> {
  const res = await fetch(url);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(res.status, `HTTP_${res.status}`, `Request failed (${res.status}).`);
  }
  if (!res.ok) {
    const { code, message } = errorBody(json, res.status);
    throw new ApiError(res.status, code, message);
  }
  if (guard && !guard(json)) {
    throw new ApiError(res.status, "BAD_SHAPE", "Unexpected response shape.");
  }
  return json as T;
}

/** Back-compat SWR fetcher (now error-aware — throws ApiError on non-2xx). */
export const fetcher = (url: string) => fetchJson<unknown>(url);

// ---------- shared wire contracts ----------

/** Live leaderboard row from /api/board */
export type BoardRow = {
  domain: string;
  logoUrl: string;
  elementSym: string;
  elementName: string;
  total: number;
  totalSpent?: number;
  /** R16-9: a seeded placeholder. Present only when the row is one, so `demo`
   *  alone decides the label — the same field the feed and the tiles use. */
  demo?: boolean;
};

/** Tile claim from /api/elements. Built from `leader`, which is filtered to
 *  directly-visible stakes — so this type must never carry a flag derived from
 *  the hidden-inclusive `count`, or the tile would advertise a concealed
 *  listing's existence. */
export type Claim = { price: number; logoUrl?: string; demo?: boolean };

/** Activity row from /api/activity — amount paid + resulting total. */
export type ActivityRow = {
  id: string;
  domain: string;
  elementSymbol: string;
  elementName: string;
  /** Payment delta for this event (pre-Phase-3 rows repeat the total). */
  delta: number;
  /** Resulting cumulative total after this event. */
  total: number;
  kind: string;
  city: string | null;
  createdAt: string;
  /** Live stake behind this event — rows deep-link via /go/:stakeId when set. */
  stakeId?: string | null;
  /** R16-9: a seeded placeholder listing, not a customer. Present only on the
   *  seeder's rows (see lib/demoLabels.ts), so `!!row.demo` is the whole test. */
  demo?: boolean;
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
  /**
   * The live take quote holding this element, when one exists (R09-1). It is
   * public — the amount and the end time only, never who holds it — because on
   * a floor-priced tile the hold is the reason every reachable amount is
   * refused, so a buyer needs to see it before bidding. `null`/absent means
   * nothing is held.
   */
  takeHold?: { reservedTotal: number; expiresAt: string } | null;
  stakes: {
    stakeId: string;
    domain: string;
    title: string;
    pitch: string;
    logo: string;
    preview?: string | null;
    siteUrl?: string;
    amount: number;
    clicks: number;
    rank: number;
    isLeader: boolean;
  }[];
  prices: {
    takeLead: number;
    joinMin: number;
    reclaim?: number;
    /**
     * False when concealed listings keep this board from being the whole
     * board, so the client cannot tell a newcomer from a returning holder
     * (R04-2). Absent on payloads cached before that field shipped; treat
     * anything but `true` as incomplete.
     */
    boardComplete?: boolean;
  };
};

/**
 * Homepage stats from /api/stats — exact quantities and units (P1-09).
 *
 * `claimedElements`/`unclaimedElements` count the tiles the board draws as
 * claimed, under the shared face predicate (`lib/moderation.ts`). `stakeCount`
 * and `totalStakedUsd` are money: every stake row, concealed and reversed
 * included (R03-2).
 */
export type StatsResponse = {
  elementsTotal: number;
  claimedElements: number;
  unclaimedElements: number;
  stakeCount: number;
  totalStakedUsd: number;
};

/** Table Order row from /api/table-order — ALL stakes summed (P1-10). */
export type TableOrderRow = {
  domain: string;
  logoUrl: string;
  totalSpent: number;
  crowns: number;
  elements: number;
  /** Biggest stake for the domain — rows link via /go/:stakeId. */
  stakeId?: string;
  /** R16-9: a seeded placeholder, so the rail's "most spent" figure is labelled
   *  as a figure nobody paid. */
  demo?: boolean;
};

/** Search hits from /api/search (P1-06). Startup rows carry everything the
 * client renders, including where selecting them goes. */
export type SearchHit =
  | {
      type: "startup";
      domain: string;
      title: string;
      logoUrl: string;
      symbol: string;
      elementName: string;
      amount: number;
      profileUrl: string;
      /** Every owned element, lead stake first (capped by the API). */
      elements: { symbol: string; elementName: string; amount: number }[];
      /** Total owned elements (may exceed elements.length). */
      elementCount: number;
    }
  | { type: "element"; symbol: string; elementName: string };

/** Checkout POST response (success). */
export type CheckoutResponse = {
  paymentId: string;
  checkoutUrl: string;
  provider: string;
  reservation?: { reservedTotal: number; expiresAt: string; guaranteedTake: boolean };
};

/** Report POST response. */
export type ReportResponse = { ok: true };

/**
 * Report triage states — one list for both operator routes (R11-6): the queue
 * filter and the PATCH transition validate against the same values, so a typo
 * returns 400 instead of an empty queue that looks like a real one.
 */
export const REPORT_STATUSES = ["OPEN", "TRIAGED", "ACTIONED", "DISMISSED"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const isReportStatus = (v: unknown): v is ReportStatus =>
  typeof v === "string" && (REPORT_STATUSES as readonly string[]).includes(v);

/** Waitlist POST response. */
export type WaitlistResponse = { ok: true; id: string };

/** Management link request/verify/session responses.
 *  `__devToken` is the development-only raw token (R14-7): a doubled underscore
 *  so the shape cannot be mistaken for a shipped feature in a response dump. */
export type ManageResponse = { ok: true; note: string; __devToken?: string } | { ok: true; domain: string };

// ---------- shape guards (fetchJson validation) ----------

export const isStringArray = (v: unknown): v is unknown[] => Array.isArray(v);

export function isStatsResponse(v: unknown): v is StatsResponse {
  return (
    isRecord(v) &&
    typeof v.elementsTotal === "number" &&
    typeof v.claimedElements === "number" &&
    typeof v.unclaimedElements === "number" &&
    typeof v.stakeCount === "number" &&
    typeof v.totalStakedUsd === "number"
  );
}

export function isTableOrderRows(v: unknown): v is TableOrderRow[] {
  return (
    Array.isArray(v) &&
    v.every(
      (r) =>
        isRecord(r) &&
        typeof r.domain === "string" &&
        typeof r.logoUrl === "string" &&
        typeof r.totalSpent === "number" &&
        typeof r.crowns === "number" &&
        typeof r.elements === "number" &&
        (r.stakeId === undefined || typeof r.stakeId === "string") &&
        (r.demo === undefined || typeof r.demo === "boolean")
    )
  );
}

export function isBoardRows(v: unknown): v is BoardRow[] {
  return (
    Array.isArray(v) &&
    v.every(
      (r) =>
        isRecord(r) &&
        typeof r.domain === "string" &&
        typeof r.logoUrl === "string" &&
        typeof r.elementSym === "string" &&
        typeof r.elementName === "string" &&
        typeof r.total === "number"
    )
  );
}

export function isActivityRows(v: unknown): v is ActivityRow[] {
  return (
    Array.isArray(v) &&
    v.every(
      (r) =>
        isRecord(r) &&
        typeof r.id === "string" &&
        typeof r.domain === "string" &&
        typeof r.elementSymbol === "string" &&
        typeof r.delta === "number" &&
        typeof r.total === "number" &&
        typeof r.kind === "string" &&
        typeof r.createdAt === "string" &&
        (r.stakeId === undefined || r.stakeId === null || typeof r.stakeId === "string") &&
        (r.demo === undefined || typeof r.demo === "boolean")
    )
  );
}

export function isSearchHits(v: unknown): v is SearchHit[] {
  return (
    Array.isArray(v) &&
    v.every(
      (h) =>
        isRecord(h) &&
        (h.type === "element"
          ? typeof h.symbol === "string" && typeof h.elementName === "string"
          : h.type === "startup" &&
            typeof h.domain === "string" &&
            typeof h.symbol === "string" &&
            typeof h.elementName === "string" &&
            typeof h.amount === "number" &&
            typeof h.profileUrl === "string" &&
            Array.isArray(h.elements) &&
            (h.elements as unknown[]).every(
              (e) =>
                isRecord(e) &&
                typeof e.symbol === "string" &&
                typeof e.elementName === "string" &&
                typeof e.amount === "number"
            ) &&
            typeof h.elementCount === "number")
    )
  );
}

export function isElementDetail(v: unknown): v is ElementDetail {
  return (
    isRecord(v) &&
    typeof v.symbol === "string" &&
    Array.isArray((v as { stakes?: unknown }).stakes) &&
    isRecord((v as { prices?: unknown }).prices)
  );
}
