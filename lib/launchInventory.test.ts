/* Launch-inventory guard tests (no DB). Four jobs:
   1. the inventory allowlist can never drift from the seeder sources,
   2. a row that acquired a real-customer signal is always reported blocked,
   3. the cleanup CLI keeps its dry-run + guard contract,
   4. the inventory price contract: one seat per element, all at the floor, so
      every captured tile is beatable for exactly $6 and carries no ladder. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  LAUNCH_INVENTORY_DOMAINS,
  assessInventoryStartups,
  blockReasons,
  type InventoryStartupRow,
} from "./launchInventory";
import { MIN_STAKE, TAKEOVER_MARGIN, smallestFreeAmount, takeLeadPrice } from "./pricing";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const domainsIn = (src: string) => new Set([...src.matchAll(/domain:\s*"([^"]+)"/g)].map((m) => m[1]));
/** Element symbols a seeder can write — the `symbol: "…"` rows of both seeds. */
const symbolsIn = (src: string) => [...src.matchAll(/symbol:\s*"([^"]+)"/g)].map((m) => m[1]);

const clean = (over: Partial<InventoryStartupRow> = {}): InventoryStartupRow => ({
  id: "s1",
  domain: "stripe.com",
  email: null,
  moderatedBy: null,
  moderatedReason: null,
  paymentCount: 0,
  manageTokenCount: 0,
  manageSessionCount: 0,
  ...over,
});

describe("launch inventory allowlist", () => {
  it("is unique, lowercase, and non-empty", () => {
    expect(LAUNCH_INVENTORY_DOMAINS.length).toBeGreaterThan(0);
    expect(new Set(LAUNCH_INVENTORY_DOMAINS).size).toBe(LAUNCH_INVENTORY_DOMAINS.length);
    for (const d of LAUNCH_INVENTORY_DOMAINS) expect(d).toBe(d.toLowerCase());
  });

  it("covers every domain either seeder can write", () => {
    const seeded = new Set([...domainsIn(read("prisma/launch-seed.ts")), ...domainsIn(read("prisma/seed.ts")), ...domainsIn(read("mocks/startups.ts"))]);
    expect(seeded.size).toBeGreaterThan(0);
    const allowed: readonly string[] = LAUNCH_INVENTORY_DOMAINS;
    expect([...seeded].filter((d) => !allowed.includes(d))).toEqual([]);
  });

  it("does not list domains no seeder writes (no overreach)", () => {
    const seeded = new Set([...domainsIn(read("prisma/launch-seed.ts")), ...domainsIn(read("prisma/seed.ts")), ...domainsIn(read("mocks/startups.ts"))]);
    expect(LAUNCH_INVENTORY_DOMAINS.filter((d) => !seeded.has(d))).toEqual([]);
  });
});

describe("launch inventory price contract", () => {
  it("seats one tile per element, never two, so no tile carries a ladder", () => {
    const launch = symbolsIn(read("prisma/launch-seed.ts"));
    expect(launch.length).toBeGreaterThan(0);
    expect(new Set(launch).size).toBe(launch.length);
    // Every seat is the tile's only row, so the tile total is the floor.
    expect(launch.map(() => takeLeadPrice(MIN_STAKE))).toEqual(launch.map(() => MIN_STAKE + TAKEOVER_MARGIN));
  });

  it("leaves every captured tile biddable at exactly one dollar over its holder", () => {
    const launch = symbolsIn(read("prisma/launch-seed.ts"));
    for (const symbol of launch) {
      const totalsOnTile = [MIN_STAKE];
      expect([symbol, takeLeadPrice(MIN_STAKE)]).toEqual([symbol, 6]);
      // The next free whole dollar the client is offered is the same 6 — a
      // ladder would push this above the takeover quote and dead-end the tile.
      expect([symbol, smallestFreeAmount(totalsOnTile)]).toEqual([symbol, 6]);
    }
  });

  it("writes the seats at the floor, with no clicks and no city", () => {
    const seeder = read("prisma/launch-seed.ts");
    expect(seeder).toMatch(/amountUsd: MIN_STAKE/);
    expect(seeder).toMatch(/clicksDelivered: 0/);
    expect(seeder).toMatch(/city: null/);
    expect(seeder).not.toMatch(/amount: \d/);
  });

  it("keeps the seed list in the spreadsheet at the same price", () => {
    const rows = read("doc/phase-5-launch/seed-list.csv").trim().split("\n").slice(1);
    expect(rows.length).toBe(symbolsIn(read("prisma/launch-seed.ts")).length);
    for (const row of rows) expect([row.split(",")[3], Number(row.split(",")[4])]).toEqual([row.split(",")[3], MIN_STAKE]);
  });
});

describe("provenance guard", () => {
  it("a row the seed left untouched has no blocking signal", () => {
    expect(blockReasons(clean())).toEqual([]);
  });

  it.each([
    ["notification email", { email: "founder@stripe.com" }],
    ["a payment", { paymentCount: 1 }],
    ["a manage token", { manageTokenCount: 1 }],
    ["a manage session", { manageSessionCount: 1 }],
    ["operator moderation", { moderatedBy: "ops" }],
    ["operator moderation reason", { moderatedReason: "trademark" }],
  ])("blocks a row with %s", (_label, over) => {
    expect(blockReasons(clean(over)).length).toBeGreaterThan(0);
  });

  it("splits candidates and keeps blocked rows out of the delete set", () => {
    const { removable, blocked } = assessInventoryStartups([
      clean({ id: "a", domain: "stripe.com" }),
      clean({ id: "b", domain: "coinbase.com", email: "real@coinbase.com" }),
      clean({ id: "c", domain: "nvidia.com" }),
    ]);
    expect(removable.map((r) => r.id)).toEqual(["a", "c"]);
    expect(blocked.map((b) => b.row.id)).toEqual(["b"]);
    expect(blocked[0].reasons[0]).toContain("real@coinbase.com");
  });
});

describe("clear-launch-inventory CLI contract", () => {
  const src = read("scripts/clear-launch-inventory.ts");

  it("is dry-run by default and rolls the plan back", () => {
    expect(src).toMatch(/const APPLY = argv\.includes\("--apply"\)/);
    expect(src).toMatch(/if \(!APPLY\) throw new Rollback\(\)/);
  });

  it("refuses a remote target without --allow-remote", () => {
    expect(src).toMatch(/APPLY && !isLocal\(url\) && !ALLOW_REMOTE/);
  });

  it("refuses to delete a candidate that carries real-customer signals", () => {
    expect(src).toMatch(/assessInventoryStartups/);
    expect(src).toMatch(/if \(blocked\.length > 0\)/);
  });

  it("ranks through the shared invariant path, never ad hoc", () => {
    expect(src).toMatch(/rankStakes/);
    expect(src).toMatch(/assertLedgerInvariants/);
  });

  it("is the only delete path, and it deletes only what the allowlist names", () => {
    expect(src).toMatch(/domain: \{ in: \[\.\.\.LAUNCH_INVENTORY_DOMAINS\] \}/);
    expect(src).toMatch(/from "\.\.\/lib\/launchInventory"/);
  });
});
