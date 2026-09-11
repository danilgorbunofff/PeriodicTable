/* Phase 5 unit tests (no DB): flags kill-switch, analytics event contract. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ANALYTICS_EVENTS } from "./analytics";

describe("launch flags", () => {
  it("PAYMENTS_LIVE=false kills payments on server and client", async () => {
    const prev = process.env.PAYMENTS_LIVE;
    const prevPub = process.env.NEXT_PUBLIC_PAYMENTS_LIVE;
    process.env.PAYMENTS_LIVE = "false";
    process.env.NEXT_PUBLIC_PAYMENTS_LIVE = "false";
    const { paymentsLiveServer, paymentsLiveClient } = await import("./flags");
    expect(paymentsLiveServer()).toBe(false);
    expect(paymentsLiveClient()).toBe(false);
    if (prev === undefined) delete process.env.PAYMENTS_LIVE;
    else process.env.PAYMENTS_LIVE = prev;
    if (prevPub === undefined) delete process.env.NEXT_PUBLIC_PAYMENTS_LIVE;
    else process.env.NEXT_PUBLIC_PAYMENTS_LIVE = prevPub;
    const { paymentsLiveServer: on1, paymentsLiveClient: on2 } = await import("./flags");
    expect(on1()).toBe(true);
    expect(on2()).toBe(true);
  });
});

describe("analytics contract", () => {
  it("covers all 7 funnel events", () => {
    expect([...ANALYTICS_EVENTS].sort()).toEqual(
      ["checkout_paid", "checkout_start", "drawer_open", "go_click", "reclaim_click", "search_submit", "tile_click"].sort()
    );
  });
  it("track() is a no-op without plausible (never throws)", async () => {
    const { track } = await import("./analytics");
    expect(() => track("tile_click", { element: "C" })).not.toThrow();
  });
  it("checkout API honors the kill switch (403 waitlist)", () => {
    const src = readFileSync(join(__dirname, "..", "app", "api", "checkout", "route.ts"), "utf8");
    expect(src).toMatch(/paymentsLiveServer/);
    expect(src).toMatch(/waitlist/);
  });
});

/* The click path hashes the IP, but the waitlist audit write did not: it stored
 * the raw address in AuditLog.actorRef *alongside* the email in `detail`, so a
 * single row carried both a person and their address. These pin the invariant
 * across every writer, since the failure mode is one route quietly differing
 * from the rest and no behavioural test being able to see it. */
describe("IP privacy — the address is never persisted raw", () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");

  it("waitlist audit stores a hash, not the raw IP", () => {
    const src = read("app", "api", "waitlist", "route.ts");
    expect(src).toMatch(/hashIp\(ip\)/);
    // exactly the regression this pins: `actorRef: ip` (bare), not `hashIp(ip)`
    expect(src).not.toMatch(/actorRef:\s*ip\s*[,}\n]/);
  });

  it("click attribution hashes before writing", () => {
    const src = read("app", "go", "[stakeId]", "route.ts");
    expect(src).toMatch(/hashIp\(ip\)/);
  });

  it("hashIp() is a salted digest that does not leak the address", async () => {
    process.env.CLICK_SALT = "unit-test-salt";
    const { hashIp } = await import("./clicks");
    const h = hashIp("203.0.113.9");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("203.0.113.9");
    expect(hashIp("203.0.113.9")).toBe(h); // deterministic → same-IP correlation survives
    expect(hashIp("203.0.113.10")).not.toBe(h); // distinct addresses stay distinct
    expect(hashIp("203.0.113.9", "other-salt")).not.toBe(h); // the salt actually does work
  });
});
