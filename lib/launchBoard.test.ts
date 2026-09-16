/* Launch board reading tests (no DB). The module exists to make one claim
   checkable against a live database: the seeded inventory opens one unpaid seat
   per element at the floor, so a captured tile is beaten for exactly $6. These
   tests pin the two halves of that reading — the price it derives, and which
   rows count as residue rather than as customers.

   The four cases worth naming:
   1. the seeded shape reads ready, and a paid rival does not spoil it,
   2. an *unpaid* row above the floor is the "rebid" a visitor complained about,
   3. an unpaid holder outside the allowlist is residue, whatever its price,
   4. an inventory domain that acquired a payment is a customer (info, not a
      failure) — the FAQ copy is what needs re-reading. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { readLaunchBoard, type BoardStakeRow } from "./launchBoard";
import { MIN_STAKE, takeLeadPrice } from "./pricing";
import { LAUNCH_INVENTORY_DOMAINS } from "./launchInventory";

const seat = (over: Partial<BoardStakeRow> = {}): BoardStakeRow => ({
  domain: "resend.com",
  symbol: "C",
  amountUsd: MIN_STAKE,
  paid: false,
  ...over,
});

describe("readLaunchBoard — the seeded shape", () => {
  it("reads ready and quotes the $6 takeover when every unpaid seat is inventory at the floor", () => {
    const reading = readLaunchBoard([
      seat({ domain: "resend.com", symbol: "C" }),
      seat({ domain: "lemonsqueezy.com", symbol: "Au" }),
      seat({ domain: "cal.com", symbol: "Si" }),
    ]);

    expect(reading.ready).toBe(true);
    expect(reading.issues).toEqual([]);
    expect(reading.totals).toEqual({ elements: 3, seats: 3, poolUsd: 15, takeoverUsd: takeLeadPrice(MIN_STAKE) });
    expect(reading.tiles.map((t) => [t.symbol, t.takeoverUsd, t.stakeCount])).toEqual([
      ["Au", 6, 1],
      ["C", 6, 1],
      ["Si", 6, 1],
    ]);
    expect(reading.totals.takeoverUsd).toBe(6);
  });

  it("counts tiles and dollars per holder, and marks inventory holders", () => {
    const reading = readLaunchBoard([
      seat({ domain: "replicate.com", symbol: "DM" }),
      seat({ domain: "replicate.com", symbol: "U" }),
      seat({ domain: "replicate.com", symbol: "Pu" }),
    ]);

    expect(reading.domains).toEqual([
      { domain: "replicate.com", tiles: 3, usd: 15, paid: false, inventory: true },
    ]);
  });

  it("reads an empty board as ready — nothing to contradict yet", () => {
    const reading = readLaunchBoard([]);
    expect(reading.ready).toBe(true);
    expect(reading.totals.elements).toBe(0);
  });
});

describe("readLaunchBoard — what breaks the claim", () => {
  it("warns on an unpaid row above the floor, naming the price to beat", () => {
    const reading = readLaunchBoard([seat({ domain: "adyen.com", symbol: "C", amountUsd: 24 })]);

    expect(reading.ready).toBe(false);
    expect(reading.tiles[0].takeoverUsd).toBe(25);
    expect(reading.issues.map((i) => i.kind).sort()).toEqual(["not-floor", "unpaid-residue"]);
    for (const issue of reading.issues) expect(issue.severity).toBe("warn");
    expect(reading.issues.find((i) => i.kind === "not-floor")?.message).toContain("$24 with no payment");
  });

  it("warns on a ladder of seeded seats — the takeover is no longer $6", () => {
    const reading = readLaunchBoard([
      seat({ domain: "resend.com", symbol: "C", amountUsd: 50 }),
      seat({ domain: "adyen.com", symbol: "C", amountUsd: 24 }),
      seat({ domain: "squareup.com", symbol: "C", amountUsd: 9 }),
    ]);

    expect(reading.ready).toBe(false);
    const ladder = reading.issues.find((i) => i.kind === "ladder");
    expect(ladder?.severity).toBe("warn");
    expect(ladder?.message).toContain("beating it costs $51, not $6");
    expect(reading.tiles[0]).toMatchObject({ symbol: "C", poolUsd: 83, stakeCount: 3, takeoverUsd: 51, leader: "resend.com" });
  });

  it("flags an unpaid holder the seeders never wrote, even at the floor", () => {
    const reading = readLaunchBoard([seat({ domain: "huggingface.co", symbol: "U" })]);

    expect(reading.ready).toBe(false);
    expect(reading.issues).toEqual([
      {
        kind: "unpaid-residue",
        severity: "warn",
        message: "U: huggingface.co holds $5 and is not a launch inventory domain",
      },
    ]);
  });

  it("settles equal totals by domain so two readings agree", () => {
    const rows = [seat({ domain: "cal.com", symbol: "U", amountUsd: 39 }), seat({ domain: "huggingface.co", symbol: "U", amountUsd: 39 })];
    expect(readLaunchBoard(rows).tiles[0].leader).toBe("cal.com");
    expect(readLaunchBoard([...rows].reverse()).tiles[0].leader).toBe("cal.com");
  });
});

describe("readLaunchBoard — paid bidders are not failures", () => {
  it("keeps a paid ladder as info and stays ready", () => {
    const reading = readLaunchBoard([
      seat({ domain: "resend.com", symbol: "C", paid: true }),
      seat({ domain: "example.com", symbol: "C", amountUsd: 12, paid: true }),
    ]);

    expect(reading.ready).toBe(true);
    expect(reading.issues.map((i) => [i.kind, i.severity])).toEqual([
      ["ladder", "info"],
      // resend.com is inventory and now paid: the FAQ copy is the thing to fix.
      ["paid-inventory", "info"],
    ]);
    expect(reading.issues[0].message).toContain("example.com $12 (paid)");
  });

  it("reports an inventory domain that paid as info, not as a warn", () => {
    const reading = readLaunchBoard([seat({ domain: "resend.com", symbol: "C", paid: true })]);

    expect(reading.ready).toBe(true);
    expect(reading.issues).toEqual([
      {
        kind: "paid-inventory",
        severity: "info",
        message: "resend.com is a paying customer now (1 tile(s)) — the FAQ sentence about seats we did not sell needs a re-read",
      },
    ]);
  });

  it("says a paying customer once, not once per tile it holds", () => {
    const reading = readLaunchBoard([
      seat({ domain: "resend.com", symbol: "C", paid: true }),
      seat({ domain: "resend.com", symbol: "Ne", paid: true }),
      seat({ domain: "resend.com", symbol: "Ti", paid: true }),
    ]);

    expect(reading.issues.filter((i) => i.kind === "paid-inventory")).toHaveLength(1);
    expect(reading.domains[0]).toMatchObject({ domain: "resend.com", tiles: 3, paid: true, inventory: true });
  });

  it("does not warn about a paid holder's price on a tile nobody else wants", () => {
    const reading = readLaunchBoard([seat({ domain: "linear.app", symbol: "Fe", amountUsd: 140, paid: true })]);

    expect(reading.ready).toBe(true);
    expect(reading.tiles[0].takeoverUsd).toBe(141);
    expect(reading.issues).toEqual([]);
  });
});

describe("launch board contract", () => {
  it("treats the seeder allowlist as inventory by default", () => {
    const symbols = ["C", "Ne", "Ti", "Au", "Ag", "Cu"];
    const reading = readLaunchBoard(
      LAUNCH_INVENTORY_DOMAINS.map((domain, i) => seat({ domain, symbol: symbols[i % symbols.length] }))
    );
    expect(reading.ready).toBe(true);
    expect(reading.issues).toEqual([]);
    expect(reading.domains.every((d) => d.inventory)).toBe(true);
  });

  it("accepts an explicit allowlist instead of the seeded one", () => {
    const reading = readLaunchBoard([seat({ domain: "acme.test", symbol: "C" })], ["acme.test"]);
    expect(reading.ready).toBe(true);
  });

  it("keeps the check read-only — the CLI reads no arguments and writes nothing", () => {
    const src = readFileSync(join(__dirname, "..", "scripts", "check-launch-board.ts"), "utf8");
    for (const write of ["create(", "update(", "delete(", "upsert(", "$executeRaw"]) {
      expect(src).not.toContain(write);
    }
    // No flags to parse: a flag would imply a mode, and the only mode is reading.
    expect(src).not.toContain("process.argv");
  });
});
