/* Launch-cleanup guard tests (no DB). Two jobs:
   1. the demo-domain allowlist can never drift from the seeder sources,
   2. a demo row that acquired a real-customer signal is always reported blocked. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { DEMO_STARTUP_DOMAINS, assessDemoStartups, blockReasons, type DemoStartupRow } from "./demoData";
import { isDemoListing } from "./demoLabels";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const domainsIn = (src: string) => new Set([...src.matchAll(/domain:\s*"([^"]+)"/g)].map((m) => m[1]));

const clean = (over: Partial<DemoStartupRow> = {}): DemoStartupRow => ({
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

describe("demo domain allowlist", () => {
  it("is unique, lowercase, and non-empty", () => {
    expect(DEMO_STARTUP_DOMAINS.length).toBeGreaterThan(0);
    expect(new Set(DEMO_STARTUP_DOMAINS).size).toBe(DEMO_STARTUP_DOMAINS.length);
    for (const d of DEMO_STARTUP_DOMAINS) expect(d).toBe(d.toLowerCase());
  });

  it("covers every domain either seeder can write", () => {
    const seeded = new Set([...domainsIn(read("prisma/launch-seed.ts")), ...domainsIn(read("prisma/seed.ts"))]);
    expect(seeded.size).toBeGreaterThan(0);
    const allowed: readonly string[] = DEMO_STARTUP_DOMAINS;
    expect([...seeded].filter((d) => !allowed.includes(d))).toEqual([]);
  });

  it("does not list domains no seeder writes (no overreach)", () => {
    const seeded = new Set([...domainsIn(read("prisma/launch-seed.ts")), ...domainsIn(read("prisma/seed.ts"))]);
    expect(DEMO_STARTUP_DOMAINS.filter((d) => !seeded.has(d))).toEqual([]);
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
    const { removable, blocked } = assessDemoStartups([
      clean({ id: "a", domain: "stripe.com" }),
      clean({ id: "b", domain: "coinbase.com", email: "real@coinbase.com" }),
      clean({ id: "c", domain: "adyen.com" }),
    ]);
    expect(removable.map((r) => r.id)).toEqual(["a", "c"]);
    expect(blocked.map((b) => b.row.id)).toEqual(["b"]);
    expect(blocked[0].reasons[0]).toContain("real@coinbase.com");
  });
});

describe("clear-demo-data CLI contract", () => {
  const src = read("scripts/clear-demo-data.ts");

  it("is dry-run by default and rolls the plan back", () => {
    expect(src).toMatch(/const APPLY = argv\.includes\("--apply"\)/);
    expect(src).toMatch(/if \(!APPLY\) throw new Rollback\(\)/);
  });

  it("refuses a remote target without --allow-remote", () => {
    expect(src).toMatch(/APPLY && !isLocal\(url\) && !ALLOW_REMOTE/);
  });

  it("refuses to delete a candidate that carries real-customer signals", () => {
    expect(src).toMatch(/assessDemoStartups/);
    expect(src).toMatch(/if \(blocked\.length > 0\)/);
  });

  it("ranks through the shared invariant path, never ad hoc", () => {
    expect(src).toMatch(/rankStakes/);
    expect(src).toMatch(/assertLedgerInvariants/);
  });
});

/**
 * The direction of the R16-9 rule (regression, fixed in the phase-16 fix pass).
 *
 * `isDemoListing(domain, set)` and `demoListingDomains()` are two halves of one
 * rule, and the set they exchange has no type-level direction: an inverted arm
 * (`!paid.has(d)` against a set that already means "unpaid") compiles, passes
 * every unit test that only checks the negative case, and silently labels
 * nothing anywhere in the product. These cases pin the direction.
 */
describe("the provenance label and the set it is handed agree (R16-9)", () => {
  const eligible = new Set<string>(DEMO_STARTUP_DOMAINS);

  it("marks every inventory domain while none of them has paid", () => {
    for (const d of DEMO_STARTUP_DOMAINS) expect([d, isDemoListing(d, eligible)]).toEqual([d, true]);
  });

  it("marks none of them once every one has paid", () => {
    for (const d of DEMO_STARTUP_DOMAINS) expect([d, isDemoListing(d, new Set<string>())]).toEqual([d, false]);
  });

  it("is case-insensitive, and the inventory arm backstops a bad set", () => {
    expect(isDemoListing("Stripe.COM", eligible)).toBe(true);
    // A set that wrongly contains a customer's domain must not be able to call
    // that customer a placeholder: the inventory arm is not redundant.
    const tainted = new Set([...DEMO_STARTUP_DOMAINS, "customer.example"]);
    expect(isDemoListing("customer.example", tainted)).toBe(false);
  });

  it("builds the set from the unpaid side of the predicate", () => {
    expect(read("lib/demoData.ts")).toContain("DEMO_STARTUP_DOMAINS.filter((d) => !paidDomains.has(d))");
  });

  it("marks the ranked board rows, not the rows the rankers discard", () => {
    // `rankCrowns`/`rankByElement`/`rankEarlyAdopters` rebuild every row, so
    // marking before the sort leaves the response unlabelled. The route must
    // map over the ranker's output.
    const src = read("app/api/board/route.ts");
    expect(src).toContain(").map(mark)");
    expect(src).not.toMatch(/map\(\(\[domain, r\]\) => mark\(/);
  });
});
