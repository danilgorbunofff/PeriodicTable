/** Logo backfill: rewrite stored `Startup.logoUrl` values that still point at
 *  the icon service to this site's own proxy (`faviconFor`, lib/screenshots.ts).
 *
 *  Why it is needed: production rows written before the proxy existed hold an
 *  upstream `google.com/s2/favicons` URL. The production CSP is `img-src 'self'
 *  data:`, so the browser blocks that URL outright — the tile renders as an
 *  empty square. The render path already rewrites legacy URLs on the fly
 *  (`logoSrc`), so nothing is broken while this is not run; this script is what
 *  makes the *stored* value correct too, so `/api/favicon` is the only icon
 *  call the site ever makes and no list/detail payload carries the icon
 *  service's host to a client.
 *
 *  Dry run by default: prints every row it would touch, writes nothing.
 *  Usage:
 *    npm run db:backfill-logos                              # plan only
 *    npm run db:backfill-logos -- --apply --allow-remote     # write
 *  Flags:
 *    --apply             execute (default: print the plan only)
 *    --allow-remote      required with --apply for a non-local host
 */
import { PrismaClient } from "@prisma/client";
import { faviconFor, isUpstreamFaviconUrl } from "../lib/screenshots";

const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ALLOW_REMOTE = argv.includes("--allow-remote");

const isLocal = (url: string) => /(localhost|127\.0\.0\.1)/.test(url);

function die(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) die("DATABASE_URL is not set (use: npm run db:backfill-logos)");

  let host = "(unparseable url)";
  try {
    host = new URL(url).host || host;
  } catch {
    /* keep placeholder — the guard below still applies */
  }

  console.log(`target: ${host}`);
  console.log(`mode:   ${APPLY ? "APPLY (writes)" : "DRY RUN (nothing written)"}`);

  if (APPLY && !isLocal(url) && !ALLOW_REMOTE) {
    die(`refusing to write to a non-local database (${host}) without --allow-remote`);
  }

  // Coarse SQL filter, then the shared predicate decides: isUpstreamFaviconUrl
  // is the same rule the render path applies, so this script can never rewrite
  // a row the UI would have left alone, nor miss one it would have rewritten.
  const candidates = await prisma.startup.findMany({
    where: { logoUrl: { contains: "google.com/s2/favicons" } },
    select: { id: true, domain: true, logoUrl: true },
    orderBy: { domain: "asc" },
  });

  const legacy = candidates.filter((s) => isUpstreamFaviconUrl(s.logoUrl));

  if (legacy.length === 0) {
    console.log(`\nno legacy icon URL stored — nothing to backfill.\n`);
    return;
  }

  console.log(`\n${legacy.length} row(s) to rewrite:\n`);
  for (const s of legacy) {
    console.log(`  ${s.domain}`);
    console.log(`    ${s.logoUrl}`);
    console.log(`    -> ${faviconFor(s.domain, 64)}`);
  }

  if (!APPLY) {
    console.log(`\nnothing written. to execute:`);
    console.log(`  npm run db:backfill-logos -- --apply${isLocal(url) ? "" : " --allow-remote"}\n`);
    return;
  }

  for (const s of legacy) {
    await prisma.startup.update({
      where: { id: s.id },
      data: { logoUrl: faviconFor(s.domain, 64) },
    });
  }

  const stored = await prisma.startup.findMany({ select: { logoUrl: true } });
  const left = stored.filter((s) => isUpstreamFaviconUrl(s.logoUrl)).length;

  console.log(`\nrewrote ${legacy.length} row(s).`);
  if (left > 0) die(`${left} legacy icon URL(s) still stored — re-run and check for concurrent writes`);
  console.log(`verify: 0 legacy icon URL(s) left; every icon now goes through /api/favicon.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
