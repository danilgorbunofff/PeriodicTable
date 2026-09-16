/* Suppression: "may we mail this address", and what a refusal covers.

   A refusal belongs to the address, not to a listing (R10-5) — the thing the
   person who clicked actually controls — and `refuses` is the policy that
   decides which messages it blocks (§9 Q1). Both halves are tested here: the
   reason taxonomy and precedence as rows, and the two families of reason as
   behaviour through real senders.

   `verifyResendWebhook` (R10-7) is here too because it is the only door an
   unauthenticated caller could use to put an address on this list. */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHmac } from "crypto";
import { NextRequest } from "next/server";
import { POST as resendWebhookPOST } from "../app/api/webhooks/resend/route";
import {
  WEBHOOK_TOLERANCE_SECONDS,
  addressToken,
  normalizeRecipient,
  refuses,
  resendEventEffect,
  resolveUnsubTarget,
  sendReceiptEmail,
  sendRefundEmail,
  sendWaitlistEmail,
  suppressEmail,
  suppressedCount,
  suppressionFor,
  suppressionStatus,
  unsuppressEmail,
  verifyResendWebhook,
} from "./email";

const prisma = testPrisma();
const hasDb = hasTestDb;
const LIST_ADDR = "sup-list@example.com";
const MONEY_ADDR = "sup-money@example.com";
const HOOK_ADDR = "sup-hook@example.com";
const QUIET_ADDR = "sup-quiet@example.com";
const ADDRS = [LIST_ADDR, MONEY_ADDR, HOOK_ADDR, QUIET_ADDR];

/** The Svix signature Resend sends, computed the way Resend computes it. */
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const ID = "msg_2abc";
const NOW = 1_700_000_000;
const BODY = JSON.stringify({ type: "email.bounced", data: { to: ["a@b.co"] } });
const sign = (opts: { id?: string; stamp?: number | string; body?: string; secret?: string } = {}) => {
  const id = opts.id ?? ID;
  const stamp = String(opts.stamp ?? NOW);
  const body = opts.body ?? BODY;
  const key = Buffer.from((opts.secret ?? SECRET).replace(/^whsec_/, ""), "base64");
  const mac = createHmac("sha256", key).update(`${id}.${stamp}.${body}`, "utf8").digest("base64");
  return new Headers({ "svix-id": id, "svix-timestamp": stamp, "svix-signature": `v1,${mac}` });
};
/** The same signature with the timestamp the route's own clock will accept:
 *  the unit tests pin `NOW`, but `verifyResendWebhook` compares against the real
 *  clock unless told otherwise, so a route call must be signed "just now". */
const fresh = (body: string) => sign({ body, stamp: Math.floor(Date.now() / 1000) });
/** Audit rows name the address inside a longer sentence, so cleanup matches on
 *  containment rather than equality. */
const AUDIT_WHERE = { OR: ADDRS.map((address) => ({ detail: { contains: address } })) };
const clean = async () => {
  await prisma.auditLog.deleteMany({ where: AUDIT_WHERE });
  await prisma.emailLog.deleteMany({ where: { to: { in: ADDRS } } });
  await prisma.emailAddress.deleteMany({ where: { email: { in: ADDRS } } });
};

beforeAll(async () => {
  if (!hasDb) return;
  await clean();
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
  await clean();
  await prisma.$disconnect().catch(() => undefined);
});

describe("the suppression matrix", () => {
  it("list mail stops for every reason; money and operator mail only for undeliverable ones", () => {
    for (const reason of ["unsubscribe", "complaint", "manual", "bounce", "invalid"] as const) {
      expect(refuses(reason, "list"), `${reason} must stop list mail`).toBe(true);
    }
    // "Stop telling me about listings" is not "do not tell me about my money".
    for (const reason of ["unsubscribe", "complaint", "manual"] as const) {
      expect(refuses(reason, "account"), `${reason} must not stop a reversal notice`).toBe(false);
      expect(refuses(reason, "internal"), `${reason} must not stop operator mail`).toBe(false);
    }
    for (const reason of ["bounce", "invalid"] as const) {
      expect(refuses(reason, "account")).toBe(true);
      expect(refuses(reason, "internal")).toBe(true);
    }
  });

  it("addresses are normalized once, at the edge", () => {
    expect(normalizeRecipient("  Someone@Example.COM ")).toBe("someone@example.com");
    expect(normalizeRecipient("a@b.co")).toBe("a@b.co");
  });

  it("the log status names the reason", () => {
    expect(suppressionStatus("bounce")).toBe("suppressed:bounce");
    expect(suppressionStatus("unsubscribe")).toBe("suppressed:unsubscribe");
  });
});

describe("provider events decide suppression", () => {
  it("only evidence that the address is unusable, or that the person objected", () => {
    expect(resendEventEffect("email.bounced", "Permanent")).toMatchObject({ suppress: "bounce" });
    // A full mailbox or a greylisted server says "try later": suppressing there
    // would stop the money notices, which is the one thing we promised to send.
    expect(resendEventEffect("email.bounced", "Transient").suppress).toBeNull();
    expect(resendEventEffect("email.bounced", null).suppress).toBeNull();
    expect(resendEventEffect("email.complained").suppress).toBe("complaint");
    expect(resendEventEffect("email.failed").suppress).toBe("invalid");
    for (const quiet of ["email.sent", "email.delivered", "email.opened", "email.clicked", "email.delivery_delayed"]) {
      expect(resendEventEffect(quiet).suppress, quiet).toBeNull();
    }
    // An unknown type is described, not guessed at.
    expect(resendEventEffect("email.something_new")).toMatchObject({ suppress: null, note: "email.something_new" });
  });
});

describe("webhook signature verification (Svix scheme)", () => {
  const prev = process.env.RESEND_WEBHOOK_SECRET;

  beforeAll(() => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = prev;
  });

  it("accepts a well-formed delivery, including a rotated signature in the list", () => {
    expect(verifyResendWebhook(BODY, sign(), NOW)).toBe(true);
    const rotated = sign();
    rotated.set("svix-signature", `v1,AAAA ${rotated.get("svix-signature")}`);
    expect(verifyResendWebhook(BODY, rotated, NOW)).toBe(true);
  });

  it("refuses everything else", () => {
    expect(verifyResendWebhook(BODY, sign(), NOW + WEBHOOK_TOLERANCE_SECONDS + 1)).toBe(false);
    expect(verifyResendWebhook(`${BODY} `, sign(), NOW)).toBe(false); // body tampered
    // The id and the timestamp are signed too: a signature that is valid for a
    // different message must not be accepted for this one.
    const otherId = sign();
    otherId.set("svix-id", "msg_other");
    expect(verifyResendWebhook(BODY, otherId, NOW)).toBe(false);
    const restamped = sign();
    restamped.set("svix-timestamp", String(NOW + 1));
    expect(verifyResendWebhook(BODY, restamped, NOW)).toBe(false);
    expect(verifyResendWebhook(BODY, sign({ secret: "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }), NOW)).toBe(false);
    expect(verifyResendWebhook(BODY, sign({ stamp: "not-a-number" }), NOW)).toBe(false);
    const noHeaders = new Headers();
    expect(verifyResendWebhook(BODY, noHeaders, NOW)).toBe(false);
    const wrongVersion = sign();
    wrongVersion.set("svix-signature", wrongVersion.get("svix-signature")!.replace("v1,", "v2,"));
    expect(verifyResendWebhook(BODY, wrongVersion, NOW)).toBe(false);
    const unsigned = sign();
    unsigned.delete("svix-timestamp");
    expect(verifyResendWebhook(BODY, unsigned, NOW)).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    expect(verifyResendWebhook(BODY, sign(), NOW)).toBe(false);
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
  });
});

describe.skipIf(!hasDb)("refusals live on the address", () => {
  it("records, re-reasons, and never lets a provider signal narrow the person's own", async () => {
    const token = await addressToken(LIST_ADDR);
    await suppressEmail({ email: "  " + LIST_ADDR.toUpperCase() + "  ", reason: "manual", source: "ops", detail: "ticket 12" });
    expect(await suppressionFor(LIST_ADDR)).toBe("manual");

    await suppressEmail({ email: LIST_ADDR, reason: "unsubscribe", source: "unsubscribe-link", detail: "link clicked" });
    expect(await suppressionFor(LIST_ADDR)).toBe("unsubscribe");

    // The stronger reason wins: a permanent bounce says the address receives
    // nothing, so it must not be replaced by the weaker "no listing mail" —
    // otherwise the money notice keeps failing against a dead mailbox.
    await suppressEmail({ email: LIST_ADDR, reason: "bounce", source: "resend", detail: "permanent" });
    expect(await suppressionFor(LIST_ADDR)).toBe("bounce");
    expect(await prisma.emailAddress.count({ where: { email: LIST_ADDR } })).toBe(1);

    // The reverse does not narrow it: a person's request cannot be upgraded
    // back to a deliverable address by their own unsubscribe.
    await suppressEmail({ email: LIST_ADDR, reason: "unsubscribe", source: "unsubscribe-link", detail: "link clicked" });
    expect(await suppressionFor(LIST_ADDR)).toBe("bounce");

    // Re-subscribing lifts the refusal and keeps the handle: the same link in
    // the same inbox still resolves.
    expect(await unsuppressEmail(LIST_ADDR)).toBe(true);
    expect(await suppressionFor(LIST_ADDR)).toBeNull();
    expect(await unsuppressEmail(LIST_ADDR)).toBe(false);
    expect(await addressToken(LIST_ADDR)).toBe(token);
    expect(await resolveUnsubTarget(token)).toEqual({ kind: "address", email: LIST_ADDR });
    expect(await suppressedCount()).toBeGreaterThanOrEqual(0);
  });

  it("answers nothing for a token that does not exist", async () => {
    expect(await resolveUnsubTarget("not-a-real-token")).toBeNull();
    expect(await resolveUnsubTarget("")).toBeNull();
  });

  it("stops list mail but still sends the money notice (§9 Q1)", async () => {
    await suppressEmail({ email: MONEY_ADDR, reason: "unsubscribe", source: "unsubscribe-link", detail: "link clicked" });
    const waitlist = await sendWaitlistEmail({ to: MONEY_ADDR, domain: "sup-t.dev", source: "test" });
    expect(waitlist.status).toBe("suppressed");
    expect(waitlist.emailLogId).toBeTruthy();
    const logged = await prisma.emailLog.findUniqueOrThrow({ where: { id: waitlist.emailLogId! } });
    expect(logged.status).toBe("suppressed:unsubscribe");
    expect(logged.detail).toContain("refused (unsubscribe):");

    const receipt = await sendReceiptEmail({
      to: MONEY_ADDR,
      elementSymbol: "TST1",
      elementName: "Test One",
      amountUsd: 6,
      rank: 2,
      domain: "sup-t.dev",
    });
    expect(receipt.status).toBe("suppressed");

    // The reversal notice is the exception: it is about the buyer's money, and
    // the footer promise is about listings.
    const refund = await sendRefundEmail({
      to: MONEY_ADDR,
      elementSymbol: "TST1",
      elementName: "Test One",
      amountUsd: 6,
      domain: "sup-t.dev",
      providerRef: null,
    });
    expect(refund.status).toBe("logged"); // no RESEND_API_KEY in tests

    // An undeliverable address is the other family: even money mail stops.
    await suppressEmail({ email: MONEY_ADDR, reason: "bounce", source: "resend", detail: "permanent" });
    expect(
      (
        await sendRefundEmail({
          to: MONEY_ADDR,
          elementSymbol: "TST1",
          elementName: "Test One",
          amountUsd: 6,
          domain: "sup-t.dev",
          providerRef: null,
        })
      ).status
    ).toBe("suppressed");
  });
});

describe.skipIf(!hasDb)("what the provider's answer is kept for (R10-1, R10-11)", () => {
  const ADDR = "sup-provider@example.com";
  const env = process.env as unknown as Record<string, string | undefined>;
  const payload = {
    to: ADDR,
    elementSymbol: "TST1",
    elementName: "Test One",
    amountUsd: 6,
    rank: 1,
    domain: "sup-t.dev",
    dedupeKey: "sup-provider-key",
  };

  beforeAll(async () => {
    await prisma.emailLog.deleteMany({ where: { to: ADDR } });
    await prisma.emailAddress.deleteMany({ where: { email: ADDR } });
    env.RESEND_API_KEY = "re_test";
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete env.RESEND_API_KEY;
    await prisma.emailLog.deleteMany({ where: { to: ADDR } });
    await prisma.emailAddress.deleteMany({ where: { email: ADDR } });
  });

  it("records acceptance with the provider's message id, refusal with its words", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "msg_ok_1" }), { status: 200 }));
    const accepted = await sendReceiptEmail(payload);
    expect(accepted.status).toBe("sent");

    // The live R10-1 case: the provider refuses, and the refusal is the only
    // diagnosis anyone will ever have — so it is stored, not replaced by "error".
    vi.stubGlobal(
      "fetch",
      async () => new Response('{"message":"The example.com domain is not verified."}', { status: 403 })
    );
    const refused = await sendReceiptEmail({ ...payload, dedupeKey: "sup-provider-key-2" });
    expect(refused.status).toBe("error");
    expect(refused.error).toContain("resend 403");
    expect(refused.error).toContain("not verified");

    const logs = await prisma.emailLog.findMany({ where: { to: ADDR }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.status)).toEqual(["sent", "error"]);
    expect(logs[0].providerMessageId).toBe("msg_ok_1");
    expect(logs[0].providerStatus).toBe(200);
    expect(logs[0].dedupeKey).toBe("sup-provider-key");
    expect(logs[1].providerStatus).toBe(403);
    expect(logs[1].error).toContain("not verified");
    // A refused row is not a silent failure: the queue can name it by key.
    expect(logs[1].dedupeKey).toBe("sup-provider-key-2");
  });
});

describe.skipIf(!hasDb)("the Resend webhook route (R10-7)", () => {
  const prev = process.env.RESEND_WEBHOOK_SECRET;
  const post = (raw: string, headers: Headers) =>
    resendWebhookPOST(
      new NextRequest("http://localhost/api/webhooks/resend", { method: "POST", body: raw, headers })
    );
  const event = (fields: { type: string; to?: string; id?: string; bounce?: object }) =>
    JSON.stringify({
      type: fields.type,
      data: {
        email_id: fields.id ?? "msg_hook_1",
        to: fields.to ? [fields.to] : [],
        ...(fields.bounce ? { bounce: fields.bounce } : {}),
      },
    });

  beforeAll(async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = prev;
  });

  it("refuses an unsigned caller, and that caller cannot suppress anyone", async () => {
    const body = event({ type: "email.bounced", to: HOOK_ADDR, bounce: { type: "Permanent" } });
    expect((await post(body, new Headers())).status).toBe(401);
    // The list is only credible if every entry is evidence-backed.
    expect(await suppressionFor(HOOK_ADDR)).toBeNull();
    // A signature minted for one delivery does not authenticate another: the id
    // is inside the signed content, so swapping it must break the check.
    const tampered = fresh(body);
    tampered.set("svix-id", "msg_tampered");
    expect((await post(body, tampered)).status).toBe(401);
    expect(await suppressionFor(HOOK_ADDR)).toBeNull();
  });

  it("suppresses a permanent bounce, names it, and annotates the row we sent", async () => {
    const messageId = `msg_hook_${Date.now()}`;
    const sent = await prisma.emailLog.create({
      data: { to: HOOK_ADDR, template: "receipt", status: "sent", providerMessageId: messageId, detail: "subject" },
    });
    const body = event({
      type: "email.bounced",
      to: HOOK_ADDR.toUpperCase(),
      id: messageId,
      bounce: { type: "Permanent", message: "The recipient address does not exist." },
    });

    const res = await post(body, fresh(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, acted: true, suppressed: "bounce" });

    // Keyed on the address the provider named, normalized like every other write.
    expect(await suppressionFor(HOOK_ADDR)).toBe("bounce");
    const row = await prisma.emailAddress.findUniqueOrThrow({ where: { email: HOOK_ADDR } });
    expect(row.source).toBe("resend:email.bounced");
    expect(row.detail).toContain("does not exist");

    // The provider's later account of a message we believed we had delivered.
    const annotated = await prisma.emailLog.findUniqueOrThrow({ where: { id: sent.id } });
    expect(annotated.error).toContain("The recipient address does not exist.");
    expect(annotated.status).toBe("sent"); // an annotation, not a rewrite

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: "EMAIL_UNDELIVERABLE", detail: { contains: HOOK_ADDR } },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow.detail).toContain("bounced (permanent)");
    expect(auditRow.detail).toContain(messageId);

    // And the refusal is now load-bearing: the next send is refused, not attempted.
    expect((await sendWaitlistEmail({ to: HOOK_ADDR, domain: "sup-t.dev", source: "test" })).status).toBe(
      "suppressed"
    );
  });

  it("answers 200 for a transient bounce and for an event it does not know, without suppressing", async () => {
    // A full mailbox says "try later": suppressing would stop the money notices.
    const transient = event({ type: "email.bounced", to: QUIET_ADDR, bounce: { type: "Transient" } });
    expect(await (await post(transient, fresh(transient))).json()).toMatchObject({ acted: false });
    expect(await suppressionFor(QUIET_ADDR)).toBeNull();

    const unknown = event({ type: "email.something_new", to: QUIET_ADDR });
    const res = await post(unknown, fresh(unknown));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: "email.something_new" });
    expect(await suppressionFor(QUIET_ADDR)).toBeNull();

    // Still audited: a pattern of transients is how an operator sees a mailbox
    // filling up before it starts bouncing permanently.
    const noted = await prisma.auditLog.findMany({
      where: { action: "EMAIL_UNDELIVERABLE", detail: { contains: QUIET_ADDR } },
    });
    expect(noted.length).toBe(1);
    expect(noted[0].detail).toContain("not permanent, not suppressed");
  });

  it("rejects a body that is not JSON, and one that names no event", async () => {
    const notJson = "{not json";
    expect((await post(notJson, fresh(notJson))).status).toBe(400);
    const noType = JSON.stringify({ data: { to: [HOOK_ADDR] } });
    expect((await post(noType, fresh(noType))).status).toBe(400);
    const noRecipient = event({ type: "email.complained" });
    expect(await (await post(noRecipient, fresh(noRecipient))).json()).toMatchObject({
      ok: true,
      acted: false,
    });
  });
});
