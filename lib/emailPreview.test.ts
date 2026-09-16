/* R10-8/R10-9: the dev-only email preview surface (no DB).
 *
 * The route is how a template change is eyeballed, so what is checked here is
 * the surface itself rather than a template: that every template is reachable,
 * that the subject is delivered as page content (a header cannot carry the
 * default template's subject — see the first test), that a symbol which is not
 * an element is named instead of rendered, and that the gate asks the app-env
 * question rather than the NODE_ENV question.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/emails/preview/route";
import { esc } from "@/emails/escape";
import { outbidSubject } from "@/emails/outbid";
import { receiptSubject } from "@/emails/receipt";
import { refundSubject } from "@/emails/refund";
import { reportSubject } from "@/emails/report";
import { waitlistSubject } from "@/emails/waitlist";

type Env = Record<string, string | undefined>;
const env = process.env as unknown as Env;
const KEYS = ["NODE_ENV", "VERCEL_ENV", "VITEST"];
const saved: Env = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

function set(k: string, v: string | undefined) {
  if (v === undefined) delete env[k];
  else env[k] = v;
}

/** A local `next dev` is the environment this route exists for. */
function localDev() {
  set("VITEST", undefined);
  set("VERCEL_ENV", undefined);
  set("NODE_ENV", "development");
}

function preview(query = "") {
  return GET(new NextRequest(`http://localhost/api/emails/preview${query}`) as never);
}

describe("the email preview surface (R10-8, R10-9)", () => {
  it("answers 200 for its own default subject, which no header could carry", async () => {
    localDev();
    const res = await preview();
    const body = await res.text();
    const subject = outbidSubject({ elementSymbol: "C" });

    expect(subject).toContain("👑");
    // The retired mechanism, spelled out: this is the request the route used to
    // build for itself, and why the default template could not answer 200.
    expect(() => new Response(null, { headers: { "X-Subject-Preview": subject } })).toThrow(TypeError);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("x-subject-preview")).toBeNull();
    expect(body).toContain(`subject: <strong>${esc(subject)}</strong>`);
    expect(body).toContain("You were knocked off C"); // the message itself, not only the banner
  });

  it("reaches all five templates, not the two it used to", async () => {
    localDev();
    const cases: [string, string][] = [
      ["", outbidSubject({ elementSymbol: "C" })],
      ["?template=receipt", receiptSubject({ elementSymbol: "C", elementName: "Carbon", rank: 1 })],
      ["?template=refund", refundSubject({ elementSymbol: "C", amountUsd: 21 })],
      ["?template=report", reportSubject({ domain: "b.com" })],
      ["?template=waitlist", waitlistSubject()],
    ];
    for (const [query, subject] of cases) {
      const res = await preview(query);
      expect([query, res.status]).toEqual([query, 200]);
      const body = await res.text();
      expect([query, body.includes(`subject: <strong>${esc(subject)}</strong>`)]).toEqual([query, true]);
    }
  });

  it("shows the receipt top-up line the buyer's payment produced (R10-4)", async () => {
    localDev();
    const body = await (await preview("?template=receipt")).text();
    expect(body).toContain("Your $5 top-up adds to the stake you already held: <strong>$21</strong> now stands for you on C");
  });

  it("names a symbol that is not an element instead of rendering it", async () => {
    localDev();
    const unknown = await (await preview("?sym=Zz")).text();
    expect(unknown).toContain("sym=Zz is not an element, showing C");
    expect(unknown).toContain("knocked off C");

    const injected = await (await preview("?sym=%3Cscript%3Ealert(1)%3C/script%3E")).text();
    expect(injected).toContain("&lt;script&gt;");
    expect(injected).not.toContain("<script>");
  });

  it("gates on the app environment, not on NODE_ENV", async () => {
    set("VITEST", undefined);
    set("VERCEL_ENV", "production");
    set("NODE_ENV", "production");
    const prod = await preview();
    expect(prod.status).toBe(404);
    // The code is the boundary's: every non-2xx gets one (R11-3).
    expect(await prod.json()).toEqual({ error: "Not found.", code: "NOT_FOUND" });

    // A Vercel preview deployment is also NODE_ENV=production, and is exactly
    // where a template is checked after a change.
    set("VERCEL_ENV", "preview");
    const staged = await preview("?template=waitlist");
    expect(staged.status).toBe(200);
    expect(await staged.text()).toContain("subject:");
  });
});
