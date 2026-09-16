import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiJson, apiRoute } from "@/lib/route";
import { ELEMENTS } from "@/lib/elements";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: listActivity });

const ELEMENT_NAMES = new Map(ELEMENTS.map((e) => [e.symbol, e.name] as const));

type ActivityFeedRow = {
  id: string;
  domain: string;
  elementSymbol: string;
  amountUsd: number;
  deltaUsd: number | null;
  resultTotalUsd: number | null;
  kind: string;
  city: string | null;
  createdAt: Date;
  stakeId: string | null;
};

/**
 * Live activity feed (Phase 4, P2-06 display + validation matrix): stable
 * activity ids, the PAYMENT DELTA as the headline figure (never implying a
 * larger transaction), the resulting total alongside, and truthful kinds.
 *
 * R15-5: this was five round trips — count the hidden startups, fetch the page,
 * dedupe it into (domain, symbol) pairs, resolve the live stake behind each
 * pair, map them back together — and two of the five had no ceiling an attacker
 * could not move. One statement now does the whole job: `NOT EXISTS` resolves
 * visibility inside the query (so it stays correct however large the hidden set
 * grows, and stays before the `LIMIT`, which is what keeps the requested page
 * size exact), and the three LEFT JOINs are unique-index lookups
 * (`Startup.domain`, `Element.symbol`, `Stake(startupId, elementId)`).
 *
 * Raw SQL because Prisma has no subquery filter: the previous shape had to
 * materialise `hiddenDomains` into a JS array to feed `notIn`, and *that* array
 * was the unbounded thing — a `take` on it would have been worse than the scan
 * it saved, because truncating the list lets a hidden listing leak back into a
 * feed that publishes its domain, city, and amount. Same for the stake lookup:
 * it is bounded by construction (at most one row per (domain, symbol) pair, and
 * at most `limit` pairs, since `Stake` is unique on `(elementId, startupId)`),
 * which is a real bound — unlike the outer `limit`, which the caller sets.
 *
 * `moderationState::text = 'hidden'` is deliberate: the enum's database values
 * are lower-case (`@map("hidden")` in schema.prisma), and casting to text keeps
 * this comparison from depending on the enum type's name or on Postgres's
 * implicit coercion.
 */
async function listActivity(req: NextRequest) {
  // Clamped at both ends (R11-2). The upper bound was always there; the lower
  // one was not, and `?limit=-1` reached Prisma as `take: -1` — the newest row
  // instead of a bounded page, which the review caught as a silently wrong
  // feed. Junk still falls back to the six the widget asks for.
  const requested = parseInt(req.nextUrl.searchParams.get("limit") ?? "6", 10);
  const limit = Number.isNaN(requested) ? 6 : Math.min(Math.max(requested, 1), 20);

  // ActivityLog keeps a denormalised domain string, so visibility is resolved
  // against Startup here. Hidden listings must not appear: this feed publishes
  // domain, city, and amount, which would undo the concealment that hiding is
  // for. UNLISTED stays in — it is already shown on tiles and element detail,
  // so omitting it would conceal nothing.
  const rows = await prisma.$queryRaw<ActivityFeedRow[]>`
    SELECT
      a.id,
      a.domain,
      a."elementSymbol",
      a."amountUsd",
      a."deltaUsd",
      a."resultTotalUsd",
      a.kind,
      a.city,
      a."createdAt",
      s.id AS "stakeId"
    FROM "ActivityLog" a
    LEFT JOIN "Startup" st ON st.domain = a.domain
    LEFT JOIN "Element" e ON e.symbol = a."elementSymbol"
    LEFT JOIN "Stake" s ON s."startupId" = st.id AND s."elementId" = e.id
    WHERE NOT EXISTS (
      SELECT 1 FROM "Startup" h
      WHERE h.domain = a.domain AND h."moderationState"::text = 'hidden'
    )
    ORDER BY a."createdAt" DESC
    LIMIT ${limit}::int
  `;

  return apiJson(
    rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      elementSymbol: r.elementSymbol,
      elementName: ELEMENT_NAMES.get(r.elementSymbol) ?? r.elementSymbol,
      delta: r.deltaUsd ?? r.amountUsd,
      total: r.resultTotalUsd ?? r.amountUsd,
      kind: r.kind,
      city: r.city,
      createdAt: r.createdAt,
      stakeId: r.stakeId,
    }))
  );
}
