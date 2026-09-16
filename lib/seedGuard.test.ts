/* Phase 17 (R17-5) — the destructive-seed guard is pure, so every arm is
   asserted here rather than by pointing a script at a database. */
import { describe, it, expect } from "vitest";
import { seedGuard, REMOTE_FLAG } from "./seedGuard";

const REMOTE = "postgresql://u:p@ep-cool-pooler.us-east-2.aws.neon.tech/neondb";
const LOCAL = "postgresql://postgres:postgres@127.0.0.1:55433/periodictable_test";
const REMOTE_HOST = "ep-cool-pooler.us-east-2.aws.neon.tech";

describe("seedGuard (R17-5)", () => {
  it("lets a bare run through anywhere: appending deletes nothing", () => {
    const decision = seedGuard({ fresh: false, databaseUrl: REMOTE, argv: [] });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.host).toBe(REMOTE_HOST);
      expect(decision.local).toBe(false);
      expect(decision.fresh).toBe(false);
    }
  });

  it("lets --fresh run against a loopback database with no ceremony", () => {
    const decision = seedGuard({ fresh: true, databaseUrl: LOCAL, argv: ["--fresh"] });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.local).toBe(true);
  });

  it("refuses --fresh on a remote host without the second flag", () => {
    const decision = seedGuard({ fresh: true, databaseUrl: REMOTE, argv: ["--fresh"] });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("REMOTE_FLAG_REQUIRED");
      // The refusal names the host and both flags: it is also the instruction.
      expect(decision.message).toContain(REMOTE_HOST);
      expect(decision.message).toContain(REMOTE_FLAG);
      expect(decision.message).toContain(`--confirm=${REMOTE_HOST}`);
    }
  });

  it("still refuses when --allow-remote is passed and the host is not repeated back", () => {
    const missing = seedGuard({
      fresh: true,
      databaseUrl: REMOTE,
      argv: ["--fresh", REMOTE_FLAG],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("CONFIRM_REQUIRED");

    const wrong = seedGuard({
      fresh: true,
      databaseUrl: REMOTE,
      argv: ["--fresh", REMOTE_FLAG, "--confirm=some-other-host"],
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.code).toBe("CONFIRM_REQUIRED");
      expect(wrong.message).toContain("does not name the target host");
    }
  });

  it("allows the wipe only with both flags and the exact host", () => {
    const decision = seedGuard({
      fresh: true,
      databaseUrl: REMOTE,
      argv: ["--fresh", REMOTE_FLAG, `--confirm=${REMOTE_HOST}`],
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.host).toBe(REMOTE_HOST);
      expect(decision.fresh).toBe(true);
    }
  });

  it("refuses when there is no URL to check, or one it cannot parse", () => {
    const none = seedGuard({ fresh: true, databaseUrl: undefined, argv: ["--fresh"] });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.code).toBe("NO_DATABASE_URL");

    const junk = seedGuard({ fresh: true, databaseUrl: "not a url", argv: [] });
    expect(junk.ok).toBe(false);
    if (!junk.ok) expect(junk.code).toBe("UNPARSEABLE_DATABASE_URL");
  });
});
