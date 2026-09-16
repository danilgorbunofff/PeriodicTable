/* R16-4, R16-5, R16-7, R16-11: the receipt as a legal document.

   Doc 16 §5.6 opened the template and found the amount, a view link, the
   unsubscribe link and the tagline — and no tax line, no descriptor, no
   reference, no seller identity and no terms link. This file is the check that
   the block cannot quietly disappear again, and that it stays honest at both
   ends of the configuration: a deployment that knows nothing prints three lines,
   and one that knows everything prints seven.

   Two things it deliberately does not test: the copy of the rules (that is
   `lib/legalContent.test.ts`, over the corpus) and whether the mail is
   addressed (that is `lib/settle.test.ts`, over a real settlement). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { receiptHtml, type ReceiptTemplateProps } from "@/emails/receipt";
import * as operator from "@/lib/operator";
import { RECEIPT_TAX_LINE, SUPPORT, type ReceiptLegal } from "@/lib/legal";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

const BASE: ReceiptTemplateProps = {
  elementSymbol: "C",
  elementName: "Carbon",
  amountUsd: 21,
  rank: 1,
  domain: "b.com",
  viewUrl: "https://www.periodictable.lol/s/b.com",
  unsubUrl: "https://www.periodictable.lol/api/unsubscribe?token=x",
};

/* A deployment that knows everything — the same configuration the About page,
   the rules page and the advisories read (`lib/operator.ts`).

   `NodeJS.ProcessEnv` demands `NODE_ENV` (`next-env.d.ts` augments the global),
   so a partial snapshot needs one cast: the adapter is where it happens. */
type Env = Record<string, string | undefined>;
const receiptLegal = (args: Omit<Parameters<typeof operator.receiptLegal>[0], "env"> & { env?: Env }) =>
  operator.receiptLegal({ ...args, env: args.env as unknown as NodeJS.ProcessEnv });

const FULL_ENV: Env = {
  OPERATOR_NAME: "Example Labs Ltd",
  OPERATOR_COUNTRY: "Testland",
  OPERATOR_TAX_ID: "TEST-12345",
  OPERATOR_DESCRIPTOR: "PERIODICTABLE.LOL",
};

const full = (over: Partial<ReceiptLegal> = {}): ReceiptLegal => ({
  ...receiptLegal({ rulesUrl: "https://www.periodictable.lol/legal/rules", reference: "pi_123", env: FULL_ENV }),
  ...over,
});

const render = (legal: ReceiptLegal | null, over: Partial<ReceiptTemplateProps> = {}) =>
  receiptHtml({ ...BASE, legal, ...over });

describe("the receipt's legal block (R16-4, R16-5, R16-7)", () => {
  it("states the seller, the statement descriptor, the tax position and the reference", () => {
    const html = render(full());
    expect(html).toContain("Sold by");
    expect(html).toContain("Example Labs Ltd, established in Testland");
    expect(html).toContain("Card statement");
    expect(html).toContain("your statement shows <strong>PERIODICTABLE.LOL</strong>");
    expect(html).toContain("Tax");
    expect(html).toContain(RECEIPT_TAX_LINE);
    expect(html).toContain("Registration TEST-12345");
    expect(html).toContain("Payment reference");
    expect(html).toContain("pi_123");
  });

  it("names the revision of the rules the payer accepted, which is the one checkout recorded", () => {
    const html = render(full({ rulesAcceptedAt: "2026-09-16" }));
    expect(html).toContain("Rules");
    expect(html).toContain("version 2026-09-16");
    expect(html).toContain("the revision you accepted at checkout on 2026-09-16");
    // The link is the document itself, not a promise that one exists.
    expect(html).toContain('href="https://www.periodictable.lol/legal/rules"');
  });

  it("claims no consent date for a payment that predates the record (R16-6)", () => {
    const html = render(full({ rulesAcceptedAt: null }));
    expect(html).toContain("version 2026-09-16");
    expect(html).not.toContain("you accepted at checkout on");
  });

  it("tells the payer where to write before disputing, at the billing mailbox", () => {
    const html = render(full());
    expect(html).toContain(`mailto:${SUPPORT.billing}`);
    expect(html).toContain("before disputing it");
  });

  it("omits what the deployment does not know instead of printing a placeholder", () => {
    const html = render(full({ seller: null, descriptor: null, taxId: null, reference: null }));
    expect(html).not.toContain("Sold by");
    expect(html).not.toContain("Card statement");
    expect(html).not.toContain("Registration");
    expect(html).not.toContain("Payment reference");
    // Still a document: the tax position, the revision and the mailbox remain.
    expect(html).toContain(RECEIPT_TAX_LINE);
    expect(html).toContain("version 2026-09-16");
    expect(html).toContain(`mailto:${SUPPORT.billing}`);
    expect(html).not.toContain("not published in this deployment");
  });

  it("renders without the block at all, so an old caller still sends a receipt", () => {
    const html = render(null);
    expect(html).toContain("Your $21 stake puts you <strong>#1</strong> on C.");
    expect(html).not.toContain("Sold by");
    expect(html).not.toContain(RECEIPT_TAX_LINE);
  });

  it("escapes every operator value that reaches a mail client", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const html = render(full({ seller: hostile, descriptor: hostile, taxId: hostile, reference: hostile }));
    expect(html).not.toContain(hostile);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("the sent receipt always carries the block (R16-7)", () => {
  const email = src("lib/email.ts");

  it("assembles it from deployment configuration, not from the caller", () => {
    expect(email).toContain("receiptLegal({");
    expect(email).toContain("consentAt: p.consentAt ? new Date(p.consentAt) : null");
    expect(email).toContain("reference: p.reference ?? null");
  });

  it("addresses the terms link at the rules document", () => {
    expect(email).toContain("${APP_URL}/legal/rules");
  });

  it("is previewable end to end, so the document can be read without buying a stake", () => {
    const preview = src("app/api/emails/preview/route.ts");
    expect(preview).toContain("legal: receiptLegal({");
    expect(preview).toContain('reference: "pi_preview"');
  });
});
