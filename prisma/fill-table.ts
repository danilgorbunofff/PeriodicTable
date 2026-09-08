/* Fill-table (dev-only): claim EVERY element and stage rebid scenarios.
 *
 * - Deterministic (mulberry32 with a fixed seed) — same output every run.
 * - Idempotent: upserts startups, skips existing (element,startup) stakes,
 *   never mutates existing rows; re-runs converge.
 * - No ties within an element (bump on collision); all amounts integers.
 * - Ranking reuses shared rankStakes + assertLedgerInvariants (lib/pricing).
 *
 * Scenarios (by element id): solo first-claims, contested ladders (close
 * second at leader-1..4 + low joiners), takeover/reclaim stories (earliest
 * holder dethroned but still second), crowded 4-5 bidder ladders, and
 * marquee whales ($100+) on every 17th element.
 *
 * Usage: DATABASE_URL=... npx tsx prisma/fill-table.ts
 */
import { PrismaClient } from "@prisma/client";
import { ELEMENTS } from "../lib/elements";
import { rankStakes, assertLedgerInvariants } from "../lib/pricing";

const prisma = new PrismaClient();
const H = 3600_000;
const NOW = Date.now();

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Founder = { domain: string; title: string; pitch: string };
const FOUNDERS: Founder[] = [
  { domain: "nova-ledger.dev", title: "Nova Ledger", pitch: "Realtime books for onchain teams." },
  { domain: "quantumpost.io", title: "QuantumPost", pitch: "Quantum-safe messaging, today." },
  { domain: "driftlab.dev", title: "Driftlab", pitch: "Experiment flags without the flakiness." },
  { domain: "northbeam.io", title: "Northbeam", pitch: "Attribution that survives privacy." },
  { domain: "pixelforge.dev", title: "Pixelforge", pitch: "GPU image pipelines for indie hackers." },
  { domain: "loomworks.io", title: "Loomworks", pitch: "Async video with transcripts built in." },
  { domain: "moonshot.tools", title: "Moonshot", pitch: "Launch checklists for solo founders." },
  { domain: "deepfield.io", title: "Deepfield", pitch: "Observability for edge workers." },
  { domain: "brightpath.dev", title: "Brightpath", pitch: "Uptime pages people actually read." },
  { domain: "copperline.io", title: "Copperline", pitch: "Copper-fast CI for monorepos." },
  { domain: "silverpeak.dev", title: "Silverpeak", pitch: "Peak-traffic load testing." },
  { domain: "ironhold.cloud", title: "Ironhold", pitch: "Backups with restore drills." },
  { domain: "starboard.tools", title: "Starboard", pitch: "Changelogs your users will open." },
  { domain: "keelhaul.dev", title: "Keelhaul", pitch: "Ship-shape deploy previews." },
  { domain: "brightforge.io", title: "Brightforge", pitch: "Design tokens, enforced." },
  { domain: "northloop.dev", title: "Northloop", pitch: "Loop over logs like a local." },
  { domain: "datapilot.io", title: "DataPilot", pitch: "Autopilot for Postgres vacuums." },
  { domain: "cloudnest.dev", title: "Cloudnest", pitch: "Cozy staging per pull request." },
  { domain: "swiftlane.io", title: "Swiftlane", pitch: "Feature flags at edge speed." },
  { domain: "emberstack.dev", title: "Emberstack", pitch: "Serverless that stays warm." },
  { domain: "frostline.io", title: "Frostline", pitch: "Cache invalidation, solved-ish." },
  { domain: "goldrush.tools", title: "Goldrush", pitch: "Find your first ten users." },
  { domain: "prismpay.dev", title: "Prismpay", pitch: "Split payouts across borders." },
  { domain: "vantagepoint.io", title: "Vantage", pitch: "Status pages with a pulse." },
];
const CITIES = ["Berlin", "Singapore", "Prague", "Austin", "Toronto", "Zurich", "Oslo", "Lisbon", "Tokyo", "NYC"];
const KINDS = ["solo", "ladder", "ladder", "ladder", "ladder", "reclaim", "reclaim", "reclaim", "crowded", "crowded"] as const;

async function main() {
  // 1) Upsert founder startups.
  const founderIds = new Map<string, string>();
  for (const f of FOUNDERS) {
    const s = await prisma.startup.upsert({
      where: { domain: f.domain },
      create: {
        domain: f.domain,
        title: f.title,
        pitch: f.pitch,
        url: `https://${f.domain}`,
        logoUrl: `https://www.google.com/s2/favicons?domain=${f.domain}&sz=64`,
        claimedAt: new Date(NOW - 30 * 24 * H),
      },
      update: {},
    });
    founderIds.set(f.domain, s.id);
  }
  const existing = await prisma.startup.findMany({ select: { id: true, domain: true } });
  const pool = existing.map((s) => ({ id: s.id, domain: s.domain }));

  let created = 0;
  for (const el of ELEMENTS) {
    const rnd = mulberry32(1000 + el.id * 97);
    const pick = (n: number, exclude: Set<string>) => {
      const out: { startupId: string; domain: string }[] = [];
      let guard = 0;
      while (out.length < n && guard++ < 500) {
        const c = pool[Math.floor(rnd() * pool.length)];
        if (exclude.has(c.id) || out.some((o) => o.startupId === c.id)) continue;
        out.push({ startupId: c.id, domain: c.domain });
      }
      return out;
    };
    const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
    const city = () => CITIES[Math.floor(rnd() * CITIES.length)];

    const current = await prisma.stake.findMany({
      where: { elementId: el.id },
      select: { startupId: true, amountUsd: true, createdAt: true },
    });
    const used = new Set(current.map((s) => s.amountUsd));
    const haveIds = new Set(current.map((s) => s.startupId));
    const fresh = (amount: number) => {
      // Newcomer joins need $5+; bump on ties (ties are rejected upstream).
      let a = Math.max(5, Math.round(amount));
      while (used.has(a)) a += 1;
      used.add(a);
      return a;
    };

    type Plan = { startupId: string; domain: string; amount: number; ageH: number; kind: string };
    const plans: Plan[] = [];
    const baseAgeH = ri(48, 24 * 30);
    if (current.length === 0) {
      const kind = el.id % 17 === 0 ? "whale" : KINDS[el.id % KINDS.length];
      if (kind === "whale") {
        const [a, b, c] = pick(3, haveIds);
        const leader = fresh(ri(100, 250));
        plans.push({ ...a, amount: leader, ageH: baseAgeH, kind: "join" });
        plans.push({ ...b, amount: fresh(leader - ri(6, 20)), ageH: Math.max(1, baseAgeH - ri(2, 30)), kind: "stake" });
        plans.push({ ...c, amount: fresh(ri(5, 12)), ageH: Math.max(1, baseAgeH - ri(1, 10)), kind: "stake" });
      } else if (kind === "solo") {
        const [a] = pick(1, haveIds);
        plans.push({ ...a, amount: fresh(ri(5, 20)), ageH: baseAgeH, kind: "join" });
      } else if (kind === "ladder") {
        const [a, b, c] = pick(3, haveIds);
        const leader = fresh(ri(12, 60));
        plans.push({ ...a, amount: leader, ageH: baseAgeH, kind: "join" });
        plans.push({ ...b, amount: fresh(leader - ri(1, 4)), ageH: Math.max(1, baseAgeH - ri(2, 24)), kind: "stake" });
        plans.push({ ...c, amount: fresh(ri(5, 9)), ageH: Math.max(1, baseAgeH - ri(1, 12)), kind: "stake" });
      } else if (kind === "reclaim") {
        // Dethroned-holder story: earliest claimant sits second, one take
        // above would have won — leader took it later at second + small gap.
        const [a, b] = pick(2, haveIds);
        const second = fresh(ri(25, 55));
        plans.push({ ...a, amount: second, ageH: baseAgeH, kind: "join" });
        plans.push({ ...b, amount: fresh(second + ri(2, 6)), ageH: Math.max(1, baseAgeH - ri(5, 40)), kind: "stake" });
        if (rnd() < 0.5) {
          const [c] = pick(1, new Set([...haveIds, ...plans.map((p) => p.startupId)]));
          plans.push({ ...c, amount: fresh(ri(5, 10)), ageH: 1, kind: "stake" });
        }
      } else {
        // crowded: 4-5 bidder ladder, distinct totals top to bottom.
        const members = pick(5, haveIds);
        let top = fresh(ri(30, 80));
        members.forEach((m, i) => {
          plans.push({ ...m, amount: top, ageH: Math.max(1, baseAgeH - i * ri(3, 20)), kind: i === 0 ? "join" : "stake" });
          top = fresh(top - ri(2, 9));
        });
      }
    } else if (current.length < 3 && rnd() < 0.55) {
      // Already claimed: add rebid pressure (challengers below the leader).
      const leader = Math.max(...current.map((s) => s.amountUsd));
      const need = Math.min(2, 3 - current.length);
      const members = pick(need, haveIds);
      members.forEach((m, i) => {
        plans.push({ ...m, amount: fresh(Math.max(5, leader - ri(2, 10) - i * 3)), ageH: ri(1, 30), kind: "stake" });
      });
    }
    if (plans.length === 0) continue;

    for (const p of plans) {
      const ts = new Date(NOW - p.ageH * H);
      await prisma.stake.create({
        data: {
          elementId: el.id,
          startupId: p.startupId,
          amountUsd: p.amount,
          clicksDelivered: Math.floor(p.amount * (1 + rnd() * 6)),
          createdAt: ts,
        },
      });
      await prisma.activityLog.create({
        data: {
          domain: p.domain,
          elementSymbol: el.symbol,
          amountUsd: p.amount,
          deltaUsd: p.amount,
          resultTotalUsd: p.amount,
          kind: p.kind,
          city: city(),
          createdAt: ts,
        },
      });
      created += 1;
    }
  }

  // 2) Recompute every element with stakes via the shared path + FirstClaim.
  const withStakes = await prisma.stake.findMany({ distinct: ["elementId"], select: { elementId: true } });
  for (const { elementId } of withStakes) {
    const stakes = await prisma.stake.findMany({ where: { elementId } });
    const ranked = rankStakes(stakes);
    const pool = ranked.reduce((s, x) => s + x.amountUsd, 0);
    const leaderId = ranked.length > 0 ? ranked[0].startupId : null;
    assertLedgerInvariants(
      ranked.map((r) => ({ id: r.id, startupId: r.startupId, amountUsd: r.amountUsd, rank: r.rank, isLeader: r.isLeader })),
      { totalPoolUsd: pool, stakeCount: ranked.length, currentLeaderId: leaderId }
    );
    for (const r of ranked) {
      await prisma.stake.update({ where: { id: r.id }, data: { rank: r.rank, isLeader: r.isLeader } });
    }
    await prisma.element.update({
      where: { id: elementId },
      data: { totalPoolUsd: pool, stakeCount: ranked.length, currentLeaderId: leaderId },
    });
    const first = await prisma.stake.findFirst({ where: { elementId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    if (first) {
      await prisma.firstClaim.upsert({
        where: { elementId },
        create: { elementId, startupId: first.startupId, stakeId: first.id, claimedAt: first.createdAt, source: "fill", confidence: "MEDIUM" },
        update: {},
      });
    }
  }
  const [elements, claimed, stakes] = await Promise.all([
    prisma.element.count(),
    prisma.element.count({ where: { stakeCount: { gt: 0 } } }),
    prisma.stake.count(),
  ]);
  console.log(`fill-table ok: ${elements} elements, ${claimed} claimed, ${stakes} stakes (${created} new)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
