import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiRoute } from "@/lib/route";
import { upstreamFaviconUrl } from "@/lib/screenshots";

export const dynamic = "force-dynamic";
// R11-3: the same boundary as every other route — a request id on the answer,
// a JSON 405 for a verb this file does not implement, and one log line per
// origin invocation. The 200 and the 302 pass through `withContract` untouched.
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = apiRoute({ GET: favicon });

/**
 * Listing icons, fetched by our server instead of the visitor's browser (R16-3).
 *
 * Doc 16 §5.3: every `<img>` on a page with a staked listing pointed straight at
 * `google.com/s2/favicons?domain=…`, so a page view handed Google the visitor's
 * IP address together with the domain the visitor was looking at — a disclosure
 * the privacy page never made and a request the visitor never agreed to. The
 * same page permitted Microlink's PNG to be streamed to the browser on hover
 * (`shotUrlFor`, since removed).
 *
 * This route keeps the icons — they are how a listing is recognised on the
 * table — and moves the request: the browser asks us, we ask the icon service,
 * and the answer is cached like any other static image. Google sees one request
 * per listing per day from a server instead of one per page view per visitor.
 *
 * Not an open proxy: the upstream host is constructed in `lib/screenshots.ts`
 * (no caller-supplied host is ever fetched), only known sizes are accepted, and
 * the host must belong to a listing in this database — product listings are
 * their host, social listings are `host + path`, so a host match accepts
 * either.
 *
 * When there is no icon to serve the answer is **404**, not a stand-in image:
 * every caller is an `<img>` behind `components/Avatar.tsx`, whose own fallback
 * is an icy chip with the domain's initial — the honest mark for "this listing
 * has no icon". The route used to 302 to `/wikipedia-globe.png` (the drawer's
 * Wiki-link asset), which made every iconless listing look like Wikimedia.
 */

/** Sizes the table actually asks for (`Avatar` 20/24/32/48, hover 128). */
const ALLOWED_SIZES = new Set([20, 24, 32, 48, 64, 128]);
const UPSTREAM_TIMEOUT_MS = 4000;

async function favicon(req: Request) {
  const url = new URL(req.url);
  const size = Number(url.searchParams.get("sz") ?? "64");
  const domain = normaliseDomain(url.searchParams.get("domain"));

  if (!domain || !ALLOWED_SIZES.has(size)) return noIcon();

  // One indexed lookup: the icon service is reached only for a host this site
  // actually publishes — the host itself (a product listing) or the host of a
  // social listing, whose identity is `host + account path`. `count` rather
  // than `findUnique` because the question is yes/no and the row is not needed.
  const known = await prisma.startup
    .count({ where: { OR: [{ domain }, { domain: { startsWith: `${domain}/` } }] } })
    .catch(() => 0);
  if (known === 0) return noIcon();

  const upstream = await fetch(upstreamFaviconUrl(domain, size), {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    redirect: "follow",
  }).catch(() => null);

  const contentType = upstream?.headers.get("content-type") ?? "";
  if (!upstream || !upstream.ok || !contentType.startsWith("image/")) return noIcon();

  const bytes = await upstream.arrayBuffer().catch(() => null);
  if (!bytes || bytes.byteLength === 0) return noIcon();

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      // A favicon is one of the least volatile bytes on the web. `immutable` is
      // safe because the domain is the cache key: a listing that changes its
      // logo changes `Startup.logoUrl`, not the icon served for its domain.
      "Cache-Control": "public, max-age=86400, s-maxage=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** No icon: let the caller draw its own fallback. Briefly cached, because "the
 *  service has nothing for this domain yet" can change (a new listing's icon
 *  appears once the icon service indexes it), and a 404 is a small answer. */
function noIcon() {
  return new NextResponse(null, {
    status: 404,
    headers: { "Cache-Control": "public, max-age=600" },
  });
}

/** The query string is user-controlled, so only a bare host is accepted. The
 *  shape is the one intake stores (`lib/validate.ts`, www stripped), which is
 *  what the database lookup is then matched against. */
function normaliseDomain(raw: string | null): string | null {
  if (!raw) return null;
  const domain = raw.trim().toLowerCase().replace(/^www\./, "");
  if (domain.length === 0 || domain.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null;
  return domain;
}
