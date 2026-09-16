/* R18-13: the analytics consent gate.
 *
 * The finding was that one env var both configured the vendor and started
 * collecting from every visitor, with no gate and no notice. These tests pin the
 * gate's four states — unconfigured, configured-and-unasked, granted, denied —
 * and every failure mode's direction: unreadable, corrupt or unusable storage
 * must read as "not allowed", because a gate that fails open is a disclosure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ANALYTICS_CONSENT_KEY,
  ANALYTICS_CONSENT_VERSION,
  ANALYTICS_SCRIPT_ID,
  ANALYTICS_SCRIPT_URL,
  analyticsAllowed,
  analyticsDomain,
  ensureAnalyticsScript,
  readAnalyticsConsent,
  writeAnalyticsConsent,
  type ConsentStorage,
} from "./analyticsConsent";

const DOMAIN = { NEXT_PUBLIC_PLAUSIBLE_DOMAIN: "periodictable.lol" };
const NO_DOMAIN = { NEXT_PUBLIC_PLAUSIBLE_DOMAIN: "" };

/** An in-memory Web Storage stand-in. */
function fakeStorage(seed: Record<string, string> = {}): ConsentStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe("the analytics consent gate (R18-13)", () => {
  it("treats an unconfigured deployment as off, whatever the visitor stored", () => {
    const storage = fakeStorage();
    expect(analyticsDomain({})).toBeNull();
    expect(analyticsDomain(NO_DOMAIN)).toBeNull();
    expect(analyticsAllowed(NO_DOMAIN, storage)).toBe(false);
    // A whitespace-only variable is a misconfiguration, not a domain.
    expect(analyticsDomain({ NEXT_PUBLIC_PLAUSIBLE_DOMAIN: "   " })).toBeNull();
    expect(analyticsAllowed({ NEXT_PUBLIC_PLAUSIBLE_DOMAIN: "   " }, storage)).toBe(false);
    // Even a recorded grant stays inert until the deployment asks for one.
    writeAnalyticsConsent("granted", storage);
    expect(analyticsAllowed(NO_DOMAIN, storage)).toBe(false);
  });

  it("is off until the visitor answers, and off after a decline", () => {
    const storage = fakeStorage();
    expect(analyticsDomain(DOMAIN)).toBe("periodictable.lol");
    expect(readAnalyticsConsent(storage)).toBeNull();
    expect(analyticsAllowed(DOMAIN, storage)).toBe(false);

    expect(writeAnalyticsConsent("denied", storage)).toBe(true);
    expect(readAnalyticsConsent(storage)).toBe("denied");
    expect(analyticsAllowed(DOMAIN, storage)).toBe(false);

    // The stored record is what the gate reads: schema version plus the choice.
    const stored: unknown = JSON.parse(storage.data[ANALYTICS_CONSENT_KEY]);
    expect(stored).toMatchObject({ v: ANALYTICS_CONSENT_VERSION, choice: "denied" });
    expect((stored as { at: string }).at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(writeAnalyticsConsent("granted", storage)).toBe(true);
    expect(analyticsAllowed(DOMAIN, storage)).toBe(true);
  });

  it("fails closed on every damaged or unavailable storage", () => {
    // No storage at all: server render, blocked storage, private mode.
    expect(readAnalyticsConsent(null)).toBeNull();
    expect(analyticsAllowed(DOMAIN, null)).toBe(false);
    expect(writeAnalyticsConsent("granted", null)).toBe(false);

    // Corrupt and non-object payloads read as never-asked.
    for (const raw of ["", "{", "null", "[]", '"granted"', "{\"v\":1}", "{\"v\":1,\"choice\":\"maybe\"}"]) {
      const storage = fakeStorage({ [ANALYTICS_CONSENT_KEY]: raw });
      expect(readAnalyticsConsent(storage), raw).toBeNull();
      expect(analyticsAllowed(DOMAIN, storage), raw).toBe(false);
    }

    // A record from a future schema is not a grant: the question it answered is
    // not necessarily this question.
    const old = fakeStorage({
      [ANALYTICS_CONSENT_KEY]: JSON.stringify({ v: ANALYTICS_CONSENT_VERSION + 1, choice: "granted" }),
    });
    expect(readAnalyticsConsent(old)).toBeNull();
    expect(analyticsAllowed(DOMAIN, old)).toBe(false);

    // A storage whose write throws reports the failure rather than pretending.
    const readOnly: ConsentStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(writeAnalyticsConsent("granted", readOnly)).toBe(false);

    // And one whose *read* throws.
    const angry: ConsentStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(readAnalyticsConsent(angry)).toBeNull();
    expect(analyticsAllowed(DOMAIN, angry)).toBe(false);
  });

  it("finds localStorage off the global, and treats its absence as no storage", () => {
    const store = fakeStorage();
    const global = globalThis as { localStorage?: ConsentStorage };
    const had = "localStorage" in global;
    const previous = global.localStorage;
    try {
      global.localStorage = store;
      expect(writeAnalyticsConsent("granted")).toBe(true);
      expect(readAnalyticsConsent()).toBe("granted");
      expect(analyticsAllowed(DOMAIN)).toBe(true);
      delete global.localStorage;
      expect(readAnalyticsConsent()).toBeNull();
    } finally {
      if (had) global.localStorage = previous;
      else delete global.localStorage;
    }
  });
});

/** A document stand-in that records appended tags the way the real one would:
 * `getElementById` finds what was appended, which is what makes the injector
 * idempotent. */
function fakeDocument() {
  const children: { id: string; src?: string; defer?: boolean; attrs: Record<string, string> }[] = [];
  const doc = {
    children,
    getElementById: (id: string) => children.find((c) => c.id === id) ?? null,
    createElement: () => {
      const el = {
        id: "",
        src: "",
        defer: false,
        attrs: {} as Record<string, string>,
        setAttribute(k: string, v: string) {
          el.attrs[k] = v;
          if (k === "id") el.id = v;
        },
      };
      return el;
    },
    head: {
      appendChild: (el: (typeof children)[number]) => {
        children.push(el);
      },
    },
  };
  return doc;
}

describe("the analytics script injector (R18-13)", () => {
  it("injects once, for the configured domain, and only when asked", () => {
    const doc = fakeDocument();
    expect(ensureAnalyticsScript(DOMAIN.NEXT_PUBLIC_PLAUSIBLE_DOMAIN, doc as unknown as Document)).toBe(true);
    expect(doc.children).toHaveLength(1);
    expect(doc.children[0]).toMatchObject({
      id: ANALYTICS_SCRIPT_ID,
      src: ANALYTICS_SCRIPT_URL,
      defer: true,
    });
    expect(doc.children[0].attrs["data-domain"]).toBe("periodictable.lol");

    // Idempotent: an accept twice, or a remount, must not load it twice.
    expect(ensureAnalyticsScript(DOMAIN.NEXT_PUBLIC_PLAUSIBLE_DOMAIN, doc as unknown as Document)).toBe(true);
    expect(doc.children).toHaveLength(1);
  });

  it("refuses without a domain or without a document", () => {
    const doc = fakeDocument();
    expect(ensureAnalyticsScript(null, doc as unknown as Document)).toBe(false);
    expect(doc.children).toHaveLength(0);
    expect(ensureAnalyticsScript("periodictable.lol", null)).toBe(false);
  });
});

describe("the funnel events are gated too (R18-13)", () => {
  const globals = globalThis as {
    localStorage?: ConsentStorage;
    window?: { plausible?: (e: string, o?: unknown) => void };
  };
  let sent: { event: string; opts?: unknown }[] = [];
  const hadWindow = "window" in globals;
  const hadStorage = "localStorage" in globals;
  const previousWindow = globals.window;
  const previousStorage = globals.localStorage;

  beforeEach(() => {
    sent = [];
    globals.localStorage = fakeStorage();
    globals.window = {
      plausible: (event: string, opts?: unknown) => sent.push({ event, opts }),
    };
  });

  afterEach(() => {
    if (hadWindow) globals.window = previousWindow;
    else delete globals.window;
    if (hadStorage) globals.localStorage = previousStorage;
    else delete globals.localStorage;
    delete process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN;
    vi.restoreAllMocks();
  });

  it("sends nothing to a plausible() global that no stored grant backs", async () => {
    const { track } = await import("./analytics");

    // Unconfigured: the vendor global is present, and it stays silent.
    track("tile_click", { element: "C" });
    expect(sent).toEqual([]);

    // Configured but unasked, and configured but declined: both silent.
    process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN = "periodictable.lol";
    track("tile_click", { element: "C" });
    expect(sent).toEqual([]);
    writeAnalyticsConsent("denied");
    track("tile_click", { element: "C" });
    expect(sent).toEqual([]);

    // Configured and granted is the only combination that reaches the vendor.
    writeAnalyticsConsent("granted");
    track("drawer_open", { element: "Au" });
    expect(sent).toEqual([{ event: "drawer_open", opts: { props: { element: "Au" } } }]);

    // And a grant that later becomes a decline stops the flow again.
    writeAnalyticsConsent("denied");
    track("go_click");
    expect(sent).toHaveLength(1);
  });
});
