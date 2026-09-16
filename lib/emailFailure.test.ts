/* R18-3 — a send that fails has to be diagnosable two ways: from the register
   row, where the provider's own words are the only evidence an operator gets,
   and from the log line, which is what is visible while it is happening.

   The sender is driven for real against a stubbed provider, so both of the
   acceptance box's shapes are exercised end to end: a non-2xx answer (the
   provider refused it) and a call that never answers (our timeout fired). No
   test here reaches Resend. */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first: pins DATABASE_URL before lib singletons bind
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import { sendReceiptEmail } from "./email";

/** One address per run, so the rows this file writes are its own to delete. */
const TO = "r18-3-mail-failure@example.com";

const savedResendKey = process.env.RESEND_API_KEY;
const savedDriver = process.env.MAIL_DRIVER;
process.env.RESEND_API_KEY = "re_test_key_r18_3";

const params = {
  to: TO,
  elementSymbol: "Au",
  elementName: "Gold",
  amountUsd: 5,
  rank: 1,
  domain: "r18-3.example",
};

/** The JSON line `logError` wrote, if the captured call parses as one. */
function lines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c) => c[0])
    .filter((a): a is string => typeof a === "string")
    .map((text) => {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((o): o is Record<string, unknown> => o !== null);
}

describe.skipIf(!hasTestDb)("failed sends, on the register and in the log (R18-3)", () => {
  const prisma = testPrisma();
  const errored: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    // The suite is DB-less elsewhere; this file is not, and the API key above
    // is what makes `mailDriver()` choose the provider path at all.
    errored.push(vi.spyOn(console, "error").mockImplementation(() => {}));
  });

  afterEach(() => {
    for (const spy of errored.splice(0)) spy.mockRestore();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    // The log is a shared table and this suite runs against one database (no
    // file parallelism): a row left behind is a row the next file's counts
    // inherit.
    await prisma.emailLog.deleteMany({ where: { to: TO } });
    await prisma.$disconnect();
    if (savedResendKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedResendKey;
    if (savedDriver === undefined) delete process.env.MAIL_DRIVER;
    else process.env.MAIL_DRIVER = savedDriver;
  });

  it("keeps the provider's status and words on the row, and says why in one line", async () => {
    const body = '{"statusCode":422,"message":"The from address is not verified"}';
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: false,
        status: 422,
        text: () => Promise.resolve(body),
      }),
    );

    const outcome = await sendReceiptEmail(params);
    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("resend 422");

    const row = await prisma.emailLog.findFirst({
      where: { to: TO },
      orderBy: { createdAt: "desc" },
    });
    expect(row?.status).toBe("error");
    expect(row?.providerStatus).toBe(422);
    // The reason leads the detail (R18-3): the register's failures list is read
    // as a diagnosis, and the subject stays where a human needs it — at the end.
    expect(row?.detail?.startsWith("failed (provider 422)")).toBe(true);
    expect(row?.detail).toContain("resend 422");
    expect(row?.detail).toContain("The from address is not verified");
    // The subject is still there — at the end, after the em dash that separates
    // it from the cause.
    expect(row?.detail).toContain(" — ");

    // One line for one failure — `error`, because this message did not arrive.
    const captured = lines(errored[0]);
    const failed = captured.filter((l) => l.msg === "send-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].level).toBe("error");
    expect(failed[0].scope).toBe("mail");
    expect(failed[0].template).toBe("receipt");
    expect(failed[0].providerStatus).toBe(422);
    expect(String(failed[0].error)).toContain("resend 422");
    // The address is a person, so it rides as a digest — nothing in the line
    // names the recipient or the key that was used.
    const text = JSON.stringify(captured);
    expect(text).not.toContain(TO);
    expect(text).not.toContain("re_test_key_r18_3");
    expect(String(failed[0].toRef).length).toBeGreaterThan(0);
  });

  it("records a call that never answered as its own shape, not a bare error", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    );

    const outcome = await sendReceiptEmail(params);
    expect(outcome.status).toBe("error");

    const row = await prisma.emailLog.findFirst({
      where: { to: TO },
      orderBy: { createdAt: "desc" },
    });
    expect(row?.status).toBe("error");
    // No response is distinguishable from a refusal: `no response` with no
    // status, so an operator can tell "Resend said no" from "we never heard".
    expect(row?.detail?.startsWith("failed (no response)")).toBe(true);
    expect(row?.detail).toContain("aborted");
    expect(row?.providerStatus).toBeNull();

    const failed = lines(errored[0]).filter((l) => l.msg === "send-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].providerStatus).toBeNull();
    expect(String(failed[0].error)).toContain("aborted");
  });
});
