/* RFC 8058 one-click unsubscribe (app/api/unsubscribe/route.ts).

   Regression guard: the route used to read the token only from the request
   body. RFC 8058 puts it in the URL and sends `List-Unsubscribe=One-Click` as
   the body, and that body parses as valid form data — so the query-string
   fallback in the catch never ran. Every one-click request became a silent
   no-op that still redirected to `?unsub=done`, which mail clients render as
   success while the mail keeps arriving. */
import { hasTestDb, testPrisma } from "./testDb"; // must stay first
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { GET as unsubGET, POST as unsubPOST } from "../app/api/unsubscribe/route";

const prisma = testPrisma();
const hasDb = hasTestDb;
const DOMAIN = "unsub-route.dev";
const EMAIL = "unsub-tester@example.com";
let token = "";

const req = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  new NextRequest(`http://localhost${url}`, init);

/** RFC 8058: token in the URL, fixed one-click body. */
const oneClick = (t: string) =>
  req(`/api/unsubscribe?token=${t}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });

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
  token = s.unsubToken;
});

afterAll(async () => {
  if (!hasDb) {
    await prisma.$disconnect().catch(() => undefined);
    return;
  }
  await prisma.startup.deleteMany({ where: { domain: DOMAIN } });
  await prisma.$disconnect().catch(() => undefined);
});

describe("unsubscribe route (RFC 8058)", () => {
  it("GET renders the confirm form and never mutates", async () => {
    if (!hasDb) return;
    const res = await unsubGET(req(`/api/unsubscribe?token=${token}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Unsubscribe?");
    expect(html).toContain(`value="${token}"`);
    // A link scanner prefetching this URL must not unsubscribe anyone.
    expect(await emailOf()).toBe(EMAIL);
  });

  it("one-click POST takes the token from the URL and clears the email", async () => {
    if (!hasDb) return;
    const res = await unsubPOST(oneClick(token));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/?unsub=done");
    expect(await emailOf()).toBeNull();
  });

  it("one-click is idempotent and keeps the token so the link stays reusable", async () => {
    if (!hasDb) return;
    const res = await unsubPOST(oneClick(token));
    expect(res.status).toBe(307);
    const row = await prisma.startup.findUnique({
      where: { domain: DOMAIN },
      select: { unsubToken: true, email: true },
    });
    expect(row?.unsubToken).toBe(token);
    expect(row?.email).toBeNull();
  });

  it("an unknown token succeeds silently and clears nothing", async () => {
    if (!hasDb) return;
    await prisma.startup.update({ where: { domain: DOMAIN }, data: { email: EMAIL } });
    const res = await unsubPOST(oneClick("not-a-real-token"));
    expect(res.status).toBe(307);
    // Same shape as success: the endpoint is not an oracle for which tokens exist.
    expect(await emailOf()).toBe(EMAIL);
  });

  it("the confirm-page POST still works with the token in the body", async () => {
    if (!hasDb) return;
    const res = await unsubPOST(
      req("/api/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${token}`,
      }),
    );
    expect(res.status).toBe(307);
    expect(await emailOf()).toBeNull();
  });
});
