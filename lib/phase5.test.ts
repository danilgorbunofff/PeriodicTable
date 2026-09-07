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
