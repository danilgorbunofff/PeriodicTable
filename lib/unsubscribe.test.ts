/* Unsubscribe, re-pointed at the address (app/api/unsubscribe/route.ts, R10-5).

   Two regressions live here. The first is RFC 8058: the route used to read the
   token only from the request body, and a one-click POST puts it in the URL and
   sends `List-Unsubscribe=One-Click` as the body — which parses as valid form
   data, so the query-string fallback in the catch never ran. Every one-click
   request became a silent no-op that still redirected to `?unsub=done`, which
   mail clients render as success while the mail keeps arriving.

   The second is what the click does. It used to clear `Startup.email`, a
   delivery address rather than a permission: the next payment carrying the same
   address re-mailed the same person, and a receipt addressed to `payment.email`
   was never affected. The refusal is now a row on the address and the address
   stays on the listing. */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { GET as unsubGET, POST as unsubPOST } from "../app/api/unsubscribe/route";
import { addressToken, suppressionFor, unsuppressEmail } from "./email";

const prisma = testPrisma();
const hasDb = hasTestDb;
const DOMAIN = "unsub-route.dev";
const EMAIL = "unsub-tester@example.com";
let token = "";
let legacy = "";

const req = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  new NextRequest(`http://localhost${url}`, init);

/** RFC 8058: token in the URL, fixed one-click body. */
const oneClick = (t: string) =>
  req(`/api/unsubscribe?token=${t}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });

const jsonPost = (body: object) =>
  unsubPOST(req("/api/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

const formPost = (body: string) =>
  unsubPOST(
    req("/api/unsubscribe", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body })
  );

const emailOf = async () =>
  (await prisma.startup.findUnique({ where: { domain: DOMAIN }, select: { email: true } }))?.email ?? null;

beforeAll(async () => {
  if (!hasDb) return;
  const s = await prisma.startup.upsert({
    where: { domain: DOMAIN },
    create: {
      domain: DOMAIN,
      title: "unsub route",
      pitch: "unsubscribe route fixture",
      url: `https://${DOMAIN}`,
      logoUrl: "x",
      email: EMAIL,
    },
    update: { email: EMAIL },
  });
  legacy = s.unsubToken;
  // A leftover refusal from an interrupted run would make "not suppressed yet"
  // assertions lie, so each run starts from a clean address.
  await prisma.auditLog.deleteMany({ where: { detail: EMAIL } });
  await unsuppressEmail(EMAIL);
  token = await addressToken(EMAIL);
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
  await prisma.auditLog.deleteMany({ where: { detail: EMAIL } });
  await prisma.emailAddress.deleteMany({ where: { email: EMAIL } });
  await prisma.startup.deleteMany({ where: { domain: DOMAIN } });
  await prisma.$disconnect().catch(() => undefined);
});

describe("unsubscribe route (RFC 8058, address-scoped)", () => {
  it("GET renders the confirm form and never mutates", async () => {
    if (!hasDb) return;
    const res = await unsubGET(req(`/api/unsubscribe?token=${token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Unsubscribe?");
    expect(html).toContain("Stop all mail");
    expect(html).toContain(`value="${token}"`);
    // A link scanner prefetching this URL must not unsubscribe anyone.
    expect(await suppressionFor(EMAIL)).toBeNull();
  });

  it("GET on an unknown token is a dead link, not an oracle", async () => {
    if (!hasDb) return;
    const res = await unsubGET(req("/api/unsubscribe?token=not-a-real-token"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Link expired");
  });

  it("the HTML confirm page carries its own CSP and never reflects a crafted token (R14-6)", async () => {
    if (!hasDb) return;
    const crafted = await unsubGET(
      req(`/api/unsubscribe?token=${token}%22%3E%3Cscript%3Ealert(1)%3C/script%3E`)
    );
    const csp = crafted.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    // No script-src at all, not even 'self': the page runs no script.
    expect(csp).not.toContain("script-src");
    expect(csp).toContain("form-action 'self'");
    const html = await crafted.text();
    // Only a token we minted resolves, and a token with a payload appended does
    // not, so the crafted value never reaches the document at all: the page is
    // the same dead link an unknown token gets, and nothing of the payload —
    // not even the script tag — is reflected as markup. The whitelist and the
    // escape are the second lock behind that lookup; the byte-identical
    // reflection of a *live* token is pinned by the test above.
    expect(html).toContain("Link expired");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");

    // The resolved-token page is the same document, so it carries the same policy.
    const real = await unsubGET(req(`/api/unsubscribe?token=${token}`));
    expect(real.headers.get("content-security-policy")).toBe(csp);
  });

  it("the confirm-page POST takes the token from the body and stops mail at the address", async () => {
    if (!hasDb) return;
    const res = await formPost(`token=${token}&action=unsubscribe`);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/?unsub=done");
    expect(await suppressionFor(EMAIL)).toBe("unsubscribe");
    // The address is not the permission: the listing keeps its address, and the
    // refusal is what stops the mail.
    expect(await emailOf()).toBe(EMAIL);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "EMAIL_UNSUBSCRIBED", detail: EMAIL },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.actorType).toBe("owner");
  });

  it("one-click POST takes the token from the URL, with the body still saying One-Click", async () => {
    if (!hasDb) return;
    await unsuppressEmail(EMAIL);
    const res = await unsubPOST(oneClick(token));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/?unsub=done");
    expect(await suppressionFor(EMAIL)).toBe("unsubscribe");
  });

  it("stopping is idempotent and keeps the token, so the link stays reusable", async () => {
    if (!hasDb) return;
    expect((await unsubPOST(oneClick(token))).status).toBe(307);
    const rows = await prisma.emailAddress.findMany({ where: { email: EMAIL } });
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe(token);
    expect(rows[0].reason).toBe("unsubscribe");
  });

  it("?resubscribe=1 shows the way back and unmute turns mail on again", async () => {
    if (!hasDb) return;
    const page = await unsubGET(req(`/api/unsubscribe?token=${token}&resubscribe=1`));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Start mail again?");
    expect(await suppressionFor(EMAIL)).toBe("unsubscribe"); // a GET still mutates nothing

    const res = await jsonPost({ token, action: "unmute" });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ ok: true });
    expect(await suppressionFor(EMAIL)).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "EMAIL_RESUBSCRIBED", detail: EMAIL } })).toBe(1);

    // Nothing left to undo, and the page says so rather than offering it.
    expect(await (await unsubGET(req(`/api/unsubscribe?token=${token}&resubscribe=1`))).text()).toContain("Mail is on");
  });

  it("an unknown token succeeds silently and stops nothing", async () => {
    if (!hasDb) return;
    const json = await jsonPost({ token: "not-a-real-token" });
    expect(json.status).toBe(200);
    expect((await json.json()) as object).toEqual({ ok: true });
    expect((await unsubPOST(oneClick("not-a-real-token"))).status).toBe(307);
    expect(await suppressionFor(EMAIL)).toBeNull();
  });

  it("a pre-fix listing token still resolves (links in old inboxes keep working)", async () => {
    if (!hasDb) return;
    // The legacy handle names a listing; the route reads the address off it. The
    // page is listing-scoped, and the click still suppresses that address.
    const page = await unsubGET(req(`/api/unsubscribe?token=${legacy}`));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Unsubscribe?");
    expect(html).toContain(DOMAIN);

    expect((await unsubPOST(oneClick(legacy))).status).toBe(307);
    expect(await suppressionFor(EMAIL)).toBe("unsubscribe");
    await unsuppressEmail(EMAIL);
  });
});
