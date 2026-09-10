/** Backfill Startup.previewImgUrl for existing stakes (Phase 4, spec 02).
 * Usage: tsx scripts/backfill-previews.ts [--limit=50]
 * Requires DATABASE_URL. Best-effort: probe Microlink shot, store URL on success.
 */
import { PrismaClient } from "@prisma/client";
import { probeShot } from "../lib/screenshots";

const prisma = new PrismaClient();

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = Math.min(Math.max(parseInt(limitArg?.split("=")[1] ?? "50", 10) || 50, 1), 500);
  const targets = await prisma.startup.findMany({ where: { previewImgUrl: null }, take: limit });
  console.log(`backfill-previews: ${targets.length} startups without preview`);
  let updated = 0;
  for (const s of targets) {
    let shot: string | null = null;
    for (let attempt = 0; attempt < 3 && !shot; attempt++) {
      shot = await probeShot(s.url);
    }
    if (shot) {
      await prisma.startup.update({ where: { id: s.id }, data: { previewImgUrl: shot } });
      updated++;
      console.log(`  + ${s.domain}`);
    } else {
      console.log(`  x ${s.domain} (shot unreachable, kept favicon fallback)`);
    }
  }
  console.log(`done: ${updated}/${targets.length} updated`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
