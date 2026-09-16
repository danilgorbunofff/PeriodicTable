/* Review 06 (doc/review/06-checkout-before-payment.md) — the intake path's
   wiring, pinned without a browser. The decisions themselves are pure and live
   in lib/checkoutFace.ts (tested next door); a Next.js client component and a
   route handler still need a DOM and a database, and this repo has neither in
   tests (U06-1), so what can be asserted here is that the components call the
   decisions and that the route runs its gates in the order the findings
   require. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { CHECKOUT_MSG, FIELD_RENDERERS } from "./checkoutFace";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

const MODALS = src("components/Modals.tsx");
const WIDGET = src("components/TurnstileWidget.tsx");
const ROUTE = src("app/api/checkout/route.ts");
const PAGE = src("app/page.tsx");

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** The gate that runs before the request is made (R06-1, R06-5, R06-6). */
const gate = MODALS.slice(MODALS.indexOf("async function submit()"), MODALS.indexOf('track("checkout_start"'));

describe("the form cannot submit silently (R06-1)", () => {
  it("asks one pure function instead of returning with no text", () => {
    expect(gate).toContain("const blocked = submitBlocked({");
    expect(gate).toContain("if (submitting) return;");
    // The old gate: `if (badUrl || badEmail || badTitle || badPitch) return;`
    // (or the same with no domain) — a click that produced no request and no
    // sentence. Both halves of the condition now have to reach the buyer.
    expect(gate).not.toMatch(/if \(bad\w+[^)]*\) return;/);
    expect(gate).not.toMatch(/badUrl \|\| badEmail/);
    expect(count(gate, "return;")).toBe(2);
  });

  it("hands the gate the same state it renders", () => {
    expect(gate).toMatch(/submitBlocked\(\{[\s\S]{0,220}\btab,[\s\S]{0,40}\burl,[\s\S]{0,80}\bdomain,/);
    expect(gate).toMatch(/clientErr,[\s\S]{0,40}humanCheckFailed,/);
  });

  it("puts the sentence under the input, or on the one shared line (R06-4)", () => {
    expect(gate).toMatch(/if \(blocked\.field && fieldHasRenderer\(blocked\.field\)\)/);
    expect(gate).toMatch(/setServerField\(\{ field: blocked\.field, message: blocked\.message \}\)/);
    expect(gate).toContain("setServerErr(blocked.shown ? null : blocked.message);");
  });

  it("follows the tab for the one field the server answers two rules for (R06-5)", () => {
    expect(MODALS).toMatch(/\{serverField\?\.field === "url" \? <span className="font-bold">\{serverField\.message\}<\/span> : urlMessage\(tab\)\}/);
  });

  it("announces a human check that never loaded, once (R06-6)", () => {
    expect(MODALS).toMatch(/onLoadFail=\{\(\) => setHumanCheckFailed\(true\)\}/);
    expect(MODALS).toMatch(/onToken=\{\(t\) => \{[\s\S]{0,200}if \(t\) setHumanCheckFailed\(false\);/);
    expect(MODALS).toMatch(/humanCheckFailed \? CHECKOUT_MSG\.humanCheck/);
    // The widget prints it; the form only announces it (R06-6).
    expect(WIDGET).toMatch(/onLoadFail\?: \(\) => void;/);
    expect(WIDGET).toMatch(/setFailed\(true\);\s*\n?\s*fail\.current\?\.\(\);/);
    expect(WIDGET).toMatch(/\{failed && <p className=[^>]*>\{CHECKOUT_MSG\.humanCheck\}<\/p>\}/);
    // Childless container: Turningstile injects its iframe here.
    expect(WIDGET).toMatch(/<div className="mt-2" ref=\{container\} \/>/);
  });

  it("keeps one key per attempt so a retry resumes the row it wrote (R06-7)", () => {
    expect(count(MODALS, "crypto.randomUUID()")).toBe(1);
    expect(MODALS).toMatch(/if \(attempt\.current\?\.sig !== sig\) \{[\s\S]{0,260}attempt\.current = \{/);
    expect(MODALS).toMatch(/const sig = `\$\{elSymbol\}\|\$\{domain\}\|\$\{Math\.round\(amount\)\}\|\$\{email\.trim\(\)\}`/);
    expect(MODALS).toMatch(/const idempotencyKey = attempt\.current\.key;/);
    // A refused attempt keeps its key; a started checkout drops it.
    const refusal = MODALS.slice(MODALS.indexOf("const refusal = checkoutRefusal"), MODALS.indexOf("} catch {"));
    expect(refusal).not.toContain("attempt.current = null");
    expect(MODALS).toMatch(/attempt\.current = null; \/\/ the checkout started[\s\S]{0,120}window\.location\.href = json\.checkoutUrl/);
  });
});

describe("a refused response becomes a sentence (R06-3, R06-4, R06-7, R06-9)", () => {
  it("treats a replay that carries no session as a refusal", () => {
    // R06-9: a `200` whose checkout already ended has no `checkoutUrl`; before
    // this, the form read `json.checkoutUrl` as undefined and navigated nowhere.
    expect(MODALS).toMatch(/if \(!res\.ok \|\| !json\.checkoutUrl\) \{[\s\S]{0,600}const refusal = checkoutRefusal\(res\.status, json\);/);
    expect(MODALS).toMatch(/setPriceMoved\(refusal\.priceMoved\);[\s\S]{0,80}setServerField\(refusal\.field\);[\s\S]{0,80}setServerErr\(refusal\.serverErr\);/);
  });

  it("keeps the live floor the server quoted, and offers it back (R06-3)", () => {
    // The refusal sets `priceMoved` for a board that actually moved, and the
    // amount banner quotes that same live figure.
    expect(MODALS).toMatch(/priceMoved != null \? `Price moved to \$\$\{priceMoved\}\.`/);
    expect(MODALS).toMatch(/Price moved to \$\{priceMoved\} — continue\?/);
    // Accepting it is a buyer edit: the field becomes theirs, so the live quote
    // stops rewriting it (lib/stakeQuote.ts) and the next submit is a new claim
    // with a new key.
    expect(MODALS).toMatch(/onClick=\{\(\) => \{ onAmount\(priceMoved\); setPriceMoved\(null\); setServerErr\(null\); \}\}/);
    expect(PAGE).toMatch(/const onCheckoutAmount = useCallback\(\(v: number\) => \{\s*setCheckoutAmtMinted\(false\);/);
  });

  it("words the email rule exactly as the server does (R06-10)", () => {
    // One sentence, two places: the constant the form renders, and the literal
    // the route returns. They must not drift.
    expect(MODALS).toContain("CHECKOUT_MSG.email");
    expect(ROUTE).toContain(CHECKOUT_MSG.email);
    expect(ROUTE).toMatch(/error: "That email doesn't look right\.", field: "email"/);
  });

  it("renders a node for every field the refusal mapper may target (R06-4)", () => {
    for (const field of FIELD_RENDERERS) expect(count(MODALS, `id="co-${field}-error"`)).toBe(1);
  });
});

describe("the route's gate order (R06-2, R06-9, R06-10)", () => {
  // Multi-line regexes are avoided on purpose: on a CRLF checkout `\n` never
  // matches, and these assertions must hold on the Windows working copy too.
  const at = (needle: string) => ROUTE.indexOf(needle);

  it("runs the pure shape checks before it spends time or writes rows", () => {
    expect(at("isEmail(rawEmail)")).toBeGreaterThan(-1);
    expect(at("isEmail(rawEmail)")).toBeLessThan(at("const input = validateCheckoutInput("));
    expect(at("honeypotCaught(")).toBeLessThan(at("isEmail(rawEmail)"));
    expect(at("verifyTurnstile(")).toBeLessThan(at("isEmail(rawEmail)"));
    expect(at("const input = validateCheckoutInput(")).toBeLessThan(at("fingerprintCheckout("));
  });

  it("replays a key before the throttle can refuse it (R06-2)", () => {
    const lookup = at("prisma.payment.findUnique({ where: { idempotencyKey } })");
    expect(ROUTE).toMatch(/const byKey = await prisma\.payment\.findUnique[\s\S]{0,120}if \(byKey\) \{[\s\S]{0,80}return await idempotentReplay\(byKey, fingerprint, req\.nextUrl\.origin\);/);
    expect(lookup).toBeLessThan(at("rateLimitAsync(`checkout:${ip}`"));
    // …and the limiter still stands in front of every row-creating path.
    expect(at("rateLimitAsync(`checkout:${ip}`")).toBeLessThan(at("prisma.element.findUnique({ where: { symbol: elementSymbol } })"));
    expect(at("rateLimitAsync(`checkout:${ip}`")).toBeLessThan(at("prisma.$transaction("));
  });

  it("answers a replayed key with the envelope the first call would have (R06-9)", () => {
    const replay = ROUTE.slice(at("async function idempotentReplay"), at("async function postCheckout("));
    expect(replay).toMatch(/provider: getProviderMode\(\),[\s\S]{0,400}guaranteedTake: true/);
    expect(replay).toMatch(/held\.expiresAt\.toISOString\(\)/);
    // A key reused for a different claim is still a conflict.
    expect(replay).toMatch(/code: "IDEMPOTENCY_CONFLICT"/);
    // A row whose checkout already ended says so instead of opening nothing.
    expect(replay).toMatch(/status: state,[\s\S]{0,200}already \$\{state\} — nothing was charged again\./);
  });

  it("hands back the reference of a row a provider failure left pending (R06-7)", () => {
    // Both the create path and its replay name the pending row, so the buyer
    // can be told what exists and the form can reuse its key.
    expect(ROUTE).toMatch(/code: "PROVIDER_UNAVAILABLE", paymentId: byKey\.id/);
    expect(ROUTE).toMatch(/code: "PROVIDER_UNAVAILABLE", paymentId: quoted\.payment\.id/);
    expect(ROUTE).toContain("Bot check failed. Try again.");
  });

  it("sends a cancelled checkout back to the symbol the form can open (R06-8)", () => {
    expect(ROUTE).toMatch(/cancelUrl: `\$\{origin\}\/\?canceled=\$\{element\.symbol\}`/);
    expect(PAGE).toMatch(/const canceled = params\.get\("canceled"\);/);
    expect(PAGE).toMatch(/if \(canceled\) \{[\s\S]{0,400}findElementBySymbol\(canceled\)/);
    expect(PAGE).toMatch(/setCheckoutEl\(found\);[\s\S]{0,40}setCheckoutCanceled\(true\);/);
    expect(PAGE).toMatch(/if \(paid \|\| unsub \|\| canceled \|\| elParam\) window\.history\.replaceState/);
    expect(PAGE).toMatch(/canceled=\{checkoutCanceled\}/);
    expect(PAGE).toMatch(/onClose=\{\(\) => \{[\s\S]{0,60}setCheckoutCanceled\(false\);/);
  });

  it("does not promise a hold the server may never have created (R06-8)", () => {
    // The cancel URL carries no amount and no reservation id: the page may
    // acknowledge the claim, never a figure or a hold it cannot verify.
    const block = PAGE.slice(PAGE.indexOf("if (canceled) {"), PAGE.indexOf("if (elParam) {"));
    expect(block).not.toMatch(/hold|reserv|\$\d/i);
    // The form, which re-reads its own reservation, carries the detail.
    expect(MODALS).toContain("CHECKOUT_MSG.canceled");
    expect(CHECKOUT_MSG.canceled).toMatch(/nothing was charged/);
  });
});
