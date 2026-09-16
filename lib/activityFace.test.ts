/* R02-5 / R02-6: what the live-activity card may say.

   Two lies lived in components/ActivityCard.tsx and both are decided here now.
   An empty feed and a pending one were the same state (`!s0`), so a production
   response of `[]` sat on "loading…" forever above a footer reading `0 recent`.
   And the footer asserted `live · updates every 30s` unconditionally — including
   after a refresh failed, when the rows on screen were retained from an earlier
   success and look exactly like fresh ones.

   The truth table is the whole decision, so this file is exhaustive over it,
   plus the source pins that stop the card from re-deciding either question. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { activityFace, kindLabel, kindVerb } from "./activityFace";
import type { ActivityHeader } from "./activityFace";
import type { ActivityRow } from "./api";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

/** The copy of a headless header — the lead variant names an event instead. */
const copy = (header: ActivityHeader) => ("text" in header ? header.text : "");

const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  id: "evt_1",
  domain: "acme.io",
  elementSymbol: "he",
  elementName: "Helium",
  delta: 5,
  total: 5,
  kind: "join",
  city: "Tokyo",
  createdAt: "2026-09-01T12:00:00.000Z",
  stakeId: "stk_1",
  ...over,
});

const ROWS = [row()];

describe("an empty feed is not a loading feed (R02-5)", () => {
  it("says so explicitly instead of pulsing forever", () => {
    const empty = activityFace("ok", []);
    expect(empty.header.kind).toBe("empty");
    expect(copy(empty.header)).toMatch(/no stakes yet/i);
    expect(copy(empty.header)).not.toMatch(/loading/i);
  });

  it("is a different state from a pending one", () => {
    const empty = activityFace("ok", []);
    const loading = activityFace("loading", undefined);
    expect(loading.header.kind).toBe("loading");
    expect(copy(loading.header)).not.toBe(copy(empty.header));
    expect(copy(loading.header)).toMatch(/loading/i);
  });

  it("still counts as a healthy feed", () => {
    // Nothing is wrong — there is simply nothing to show yet.
    expect(activityFace("ok", []).live).toBe(true);
    expect(activityFace("ok", []).status).toBe("live");
  });

  it("shows the newest event when there is one", () => {
    const face = activityFace("ok", [row({ elementSymbol: "he", kind: "reclaim", city: null })]);
    expect(face.header).toEqual({ kind: "lead", symbol: "HE", verb: "Crown reclaimed", city: "somewhere", demo: false });
  });
});

describe("the footer claims live only when the last request succeeded (R02-6)", () => {
  it("says live for a successful response", () => {
    const face = activityFace("ok", ROWS);
    expect(face).toMatchObject({ status: "live", detail: "updates every 30s", live: true, lastKnown: false });
    expect(face.dot.ping).toBe(true);
    expect(face.dot.className).toMatch(/green/);
  });

  it("drops every live claim in the other three states", () => {
    for (const state of ["loading", "stale", "unavailable"] as const) {
      const face = activityFace(state, ROWS);
      expect(face.status, state).not.toMatch(/^live$/i);
      expect(face.detail, state).not.toMatch(/30s/);
      expect(face.dot.ping, state).toBe(false);
      expect(face.dot.className, state).not.toMatch(/green/);
    }
  });

  it("marks retained rows as last known rather than fresh", () => {
    const face = activityFace("stale", ROWS);
    expect(face).toMatchObject({ status: "last known", detail: "live updates paused", lastKnown: true });
    // The rows are real, so they stay on screen — marked, not hidden.
    expect(face.header.kind).toBe("lead");
  });

  it("admits when it has nothing at all to fall back on", () => {
    const loading = activityFace("loading", undefined);
    expect(loading).toMatchObject({ status: "waiting", detail: "no response yet", lastKnown: false });
    const offline = activityFace("unavailable", undefined);
    expect(offline).toMatchObject({ status: "offline", detail: "not updating", lastKnown: false });
    expect(offline.header).toEqual({ kind: "error", text: "Couldn't load activity — retrying…" });
  });

  it("does not call a stale empty feed last known", () => {
    // There is nothing retained: an empty board is the whole truth here.
    expect(activityFace("stale", []).lastKnown).toBe(false);
  });

  it("treats unknown kinds as the common case rather than crashing", () => {
    expect(kindVerb("mystery")).toBe("Stake bumped");
    expect(kindLabel("mystery")).toBe("topped up");
    expect(kindVerb("join")).toBe("New bid");
    expect(kindLabel("refund")).toBe("refunded");
  });
});

describe("the card stops deciding these questions itself (R02-5, R02-6)", () => {
  it("asks activityFace, and takes the page's state when it is given one", () => {
    const s = src("components/ActivityCard.tsx");
    expect(s).toMatch(/activityFace\(state, data\)/);
    expect(s).toMatch(/state\?: LiveState/);
    expect(s).toMatch(/pageState \?\? liveState\(!!own\.data, own\.error\)/);
  });

  it("keeps no footer claim of its own", () => {
    const s = src("components/ActivityCard.tsx");
    expect(s).not.toMatch(/updates every 30s/);
    expect(s).toMatch(/face\.status/);
    expect(s).toMatch(/face\.detail/);
  });

  it("draws the skeleton from the loading state, not from absent rows", () => {
    const s = src("components/ActivityCard.tsx");
    expect(s).toMatch(/face\.header\.kind === "loading"/);
  });

  it("is handed the page's feed state on both placements", () => {
    const page = src("app/page.tsx");
    expect(page.match(/state=\{activityState\}/g)).toHaveLength(2);
    expect(page).toMatch(/const activityState = liveState\(!!activity, activityError\)/);
  });

  it("pulses the FAB dot off the same face as the panel footer", () => {
    // Two surfaces, one claim: a green beating dot on a failed feed is the same
    // lie the footer used to tell.
    const page = src("app/page.tsx");
    expect(page).toMatch(/activityFace\(activityState, activity\)\.dot/);
    expect(page.match(/<ActivityDot dot=\{activityDot\} \/>/g)).toHaveLength(2);
  });
});
