/* R01-7: one origin, decided in one place. The interesting cases are the ones
   that used to leak into what we publish — the apex host, a trailing slash, and
   a value that is not a URL at all. */
import { describe, it, expect } from "vitest";
import { siteOrigin, siteOriginStrict } from "./siteUrl";

describe("siteOrigin", () => {
  it("uses NEXT_PUBLIC_APP_URL when it is an absolute http(s) URL", () => {
    expect(siteOrigin({ NEXT_PUBLIC_APP_URL: "https://www.periodictable.lol" })).toBe("https://www.periodictable.lol");
  });

  it("normalises the apex to the host production serves (308 target)", () => {
    expect(siteOrigin({ NEXT_PUBLIC_APP_URL: "https://periodictable.lol" })).toBe("https://www.periodictable.lol");
    expect(siteOrigin({ NEXT_PUBLIC_APP_URL: "HTTPS://PeriodicTable.lol" })).toBe("https://www.periodictable.lol");
  });

  it("strips path, query and trailing slash so emitted URLs cannot double up", () => {
    expect(siteOrigin({ NEXT_PUBLIC_APP_URL: "https://www.periodictable.lol/" })).toBe("https://www.periodictable.lol");
    expect(siteOrigin({ NEXT_PUBLIC_APP_URL: "https://www.periodictable.lol/board?x=1" })).toBe(
      "https://www.periodictable.lol"
    );
  });

  it("keeps a real deploy host (preview) instead of rewriting it to production", () => {
    expect(siteOrigin({ NEXT_PUBLIC_APP_URL: "https://ptl-git-main.vercel.app" })).toBe("https://ptl-git-main.vercel.app");
    expect(siteOrigin({ NEXT_PUBLIC_APP_URL: "https://periodictable.lol:8443" })).toBe("https://www.periodictable.lol:8443");
  });

  it("falls back to the canonical origin only when nothing usable is set", () => {
    expect(siteOrigin({})).toBe("https://www.periodictable.lol");
    expect(siteOrigin({ NEXT_PUBLIC_APP_URL: "" })).toBe("https://www.periodictable.lol");
    expect(siteOrigin({ NEXT_PUBLIC_APP_URL: "   " })).toBe("https://www.periodictable.lol");
  });

  it("treats a non-absolute or non-http value as unset rather than emitting it", () => {
    for (const bad of ["periodictable.lol", "/board", "ftp://periodictable.lol", "javascript:alert(1)"]) {
      expect(siteOrigin({ NEXT_PUBLIC_APP_URL: bad })).toBe("https://www.periodictable.lol");
    }
  });
});

describe("siteOriginStrict", () => {
  it("refuses to guess in production (R01-7)", () => {
    expect(() => siteOriginStrict({}, { requireConfigured: true })).toThrow(/NEXT_PUBLIC_APP_URL/);
    expect(() => siteOriginStrict({ NEXT_PUBLIC_APP_URL: "not-a-url" }, { requireConfigured: true })).toThrow(
      /NEXT_PUBLIC_APP_URL/
    );
  });

  it("accepts a configured production origin, normalised", () => {
    expect(siteOriginStrict({ NEXT_PUBLIC_APP_URL: "https://periodictable.lol" }, { requireConfigured: true })).toBe(
      "https://www.periodictable.lol"
    );
  });

  it("still answers during `next build` and outside production", () => {
    expect(siteOriginStrict({}, { requireConfigured: false })).toBe("https://www.periodictable.lol");
  });
});
