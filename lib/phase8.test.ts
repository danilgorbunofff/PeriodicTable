/* Phase 8 tests (R08-1, R08-2, R08-5, R08-6, R08-7) — no DB, no network.
 *
 * The finding this file exists for: the register of provider deliveries was a
 * lossy overwrite. Six call sites in the webhook route wrote `ProviderEvent`
 * rows through an inline upsert whose `update` branch replaced the row with
 * whatever arrived last, so a replayed `checkout.session.completed` rewrote the
 * APPLIED row that had moved the money as `duplicate` and erased the detail
 * that explained it (R08-1). The only record of the delivery that settled a
 * payment read as though nothing had happened — and a reversal was silent to
 * the buyer entirely (R08-2). This file pins the two rules that came out of
 * that: a decision on file is never rewritten, and the writer is one function
 * so the rule cannot be applied inconsistently.
 *
 * Pure section: the precedence table, the abandonment predicate, the refund
 * template, the declined classifier. Static section: the wiring and the
 * response contract, asserted against the source because the route tests in
 * this repo are DB-backed and would otherwise be the only evidence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ProviderEventOutcome, PaymentStatus } from "@prisma/client";
import { providerEventUpdate } from "./settle";
import { refundSubject, refundHtml } from "../emails/refund";
import { stripePayloadIsDeclined } from "./stripe";
import {
  isAbandonable,
  abandonCutoff,
  CHECKOUT_ABANDON_TTL_MS,
  ABANDON_MAX_BATCH,
} from "./abandonedCheckouts";

const read = (...p: string[]) =>
  readFileSync(join(__dirname, "..", ...p), "utf8");
const E = ProviderEventOutcome;

describe("a decision on file is never rewritten (R08-1)", () => {
  const terminal = [
    E.APPLIED,
    E.DUPLICATE,
    E.IGNORED,
    E.FAILED,
    E.REFUNDED,
    E.RECEIVED,
  ] as const;

  it("writes the first delivery for an event id", () => {
    expect(
      providerEventUpdate(null, { outcome: E.APPLIED, detail: "settled" }),
    ).toEqual({
      outcome: E.APPLIED,
      detail: "settled",
    });
    // No detail is a valid record of a delivery that carries none.
    expect(
      providerEventUpdate(null, { outcome: E.IGNORED, detail: null }),
    ).toEqual({
      outcome: E.IGNORED,
      detail: null,
    });
  });

  it("refuses the replay that used to erase the money-moving row", () => {
    // The exact regression: an APPLIED row, then the same event id again.
    // Nothing is written — not the outcome, not the detail.
    for (const outcome of terminal) {
      expect(
        providerEventUpdate(
          { outcome: E.APPLIED, detail: "settled" },
          { outcome, detail: "duplicate" },
        ),
      ).toBeNull();
      expect(
        providerEventUpdate(
          { outcome, detail: null },
          { outcome: E.APPLIED, detail: "settled" },
        ),
      ).toBeNull();
    }
  });

  it("lets a later attempt replace a failed one", () => {
    // The one non-terminal outcome: the row says "this attempt failed", and the
    // duplicate guards skip an ERROR row for that same reason.
    expect(
      providerEventUpdate(
        { outcome: E.ERROR, detail: "amount-mismatch" },
        { outcome: E.APPLIED, detail: "settled" },
      ),
    ).toEqual({
      outcome: E.APPLIED,
      detail: "settled",
    });
    // Now that it succeeded, the rejection text must not follow it into a row
    // that claims the money applied cleanly.
    expect(
      providerEventUpdate(
        { outcome: E.ERROR, detail: "amount-mismatch" },
        { outcome: E.APPLIED, detail: null },
      ),
    ).toEqual({
      outcome: E.APPLIED,
      detail: null,
    });
  });

  it("never erases the explanation of a failed attempt", () => {
    // A retry that fails again without stating a reason keeps the reason: the
    // detail is the only thing an operator has to act on.
    expect(
      providerEventUpdate(
        { outcome: E.ERROR, detail: "amount-mismatch" },
        { outcome: E.ERROR, detail: null },
      ),
    ).toEqual({
      outcome: E.ERROR,
      detail: "amount-mismatch",
    });
    expect(
      providerEventUpdate(
        { outcome: E.ERROR, detail: "amount-mismatch" },
        { outcome: E.ERROR, detail: "reference-claimed:cs_1" },
      ),
    ).toEqual({
      outcome: E.ERROR,
      detail: "reference-claimed:cs_1",
    });
    // A first failure with no detail stays a row with no detail.
    expect(
      providerEventUpdate(null, { outcome: E.ERROR, detail: null }),
    ).toEqual({ outcome: E.ERROR, detail: null });
  });
});

describe("one writer for the register (R08-1, R08-7)", () => {
  it("has exactly one upsert on ProviderEvent in the app's source", () => {
    // Six copies of an upsert are six chances to apply the precedence rule
    // differently, which is how the row got overwritten in the first place.
    const files = [
      "app/api/webhooks/stripe/route.ts",
      "lib/settle.ts",
      "lib/abandonedCheckouts.ts",
      "lib/outbox.ts",
    ];
    const writers = files.filter((f) =>
      read(f).includes("providerEvent.upsert("),
    );
    expect(writers).toEqual(["lib/settle.ts"]);
    expect(read("lib/settle.ts")).toContain(
      "export async function recordProviderEvent(",
    );
    expect(read("lib/settle.ts")).toContain(
      "export function providerEventUpdate(",
    );
  });

  it("records every delivery the webhook route decides on", () => {
    const route = read("app/api/webhooks/stripe/route.ts");
    expect(route).not.toContain("providerEvent.upsert");
    expect(route).not.toContain("providerEvent.create");
    // Every branch that answers — unknown payment, ignored, money mismatch,
    // reference mismatch/claimed, duplicate, reversal — records a row, so a
    // delivery that changed nothing is still visible in the register.
    expect(route.match(/await recordProviderEvent\(\{/g)).toHaveLength(7);
    // The two deliveries that could not be attributed to a payment carry no id:
    // a fabricated one would violate the foreign key and misattribute the row.
    expect(route.match(/paymentId: null/g)).toHaveLength(2);
    expect(route).toContain('detail: "unknown-payment"');
    expect(route).toContain('detail: "no-paymentId"');
  });

  it("marks the reversal path's register rows with what was reversed", () => {
    // R08-7: `paymentId` is ON DELETE SET NULL, so the copied attribution is
    // what survives a deleted payment — it is resolved in the writer, where no
    // call site can forget it.
    const settle = read("lib/settle.ts");
    expect(settle).toContain("select: { elementId: true, startupId: true }");
    expect(settle).toContain("elementId: attribution?.elementId ?? null");
    expect(settle).toContain("startupId: attribution?.startupId ?? null");
    // Never written back to null by a delivery that has no attribution to add.
    expect(settle).toContain("...(params.paymentId");
  });

  it("keeps the register's attribution columns on the row, not behind the FK (R08-7)", () => {
    const schema = read("prisma/schema.prisma");
    const model = schema.slice(
      schema.indexOf("model ProviderEvent"),
      schema.indexOf("model ProviderEvent") + 1200,
    );
    expect(model).toContain("elementId");
    expect(model).toContain("startupId");
    expect(model).toContain("@@index([outcome, createdAt])");
    // The index is what the reconcile report scans; the columns must not be
    // relations, because a relation is exactly what nulls out on delete.
    expect(model).not.toMatch(/elementId\s+Int\?.*@relation/);
    const migration = read(
      "prisma/migrations/0007_provider_event_attribution/migration.sql",
    );
    expect(migration).toContain('ADD COLUMN     "elementId" INTEGER');
    expect(migration).toContain('ADD COLUMN     "startupId" TEXT');
    expect(migration).toContain(
      'CREATE INDEX "ProviderEvent_outcome_createdAt_idx"',
    );
  });
});

describe("the buyer is told their money came back (R08-2)", () => {
  const base = {
    elementSymbol: "C",
    elementName: "Carbon",
    amountUsd: 5,
    domain: "acme.dev",
    providerRef: null as string | null,
    unsubUrl: "https://www.periodictable.lol/api/unsubscribe?token=t1",
  };

  it("states the refund and the consequence it had", () => {
    const html = refundHtml(base);
    expect(refundSubject(base)).toBe("Refunded: your $5 stake on C");
    expect(html).toContain("$5");
    expect(html).toContain("C (Carbon)");
    // The listing lost the position: that consequence is the reason to send this
    // at all rather than let the provider's notice stand alone.
    expect(html).toContain("acme.dev");
    expect(html).toContain(base.unsubUrl);
  });

  it("quotes the provider reference only when there is one", () => {
    expect(refundHtml(base)).not.toContain("reference ");
    expect(refundHtml({ ...base, providerRef: "cs_test_123" })).toContain(
      "reference cs_test_123",
    );
  });

  it("does not sell anything to someone whose money was just returned", () => {
    const html = refundHtml({ ...base, providerRef: "cs_test_123" });
    expect(html).not.toMatch(/pricing|upgrade|Try again|re-?purchase|Browse/i);
    // One link out, and it is the unsubscribe.
    expect(html.match(/href="http/g)).toHaveLength(1);
  });

  it("escapes the buyer's own domain", () => {
    // The domain is user-supplied at checkout; the two other templates that
    // print it escape it, and a mail body is the one place an operator cannot
    // fix a rendering surprise.
    expect(
      refundHtml({ ...base, domain: '<img src=x onerror="alert(1)">' }),
    ).not.toContain("<img");
  });

  it("is delivered as its own outbox type, inside the reversing transaction", () => {
    const settle = read("lib/settle.ts");
    const outbox = read("lib/outbox.ts");
    expect(outbox).toContain('case "REFUND_EMAIL":');
    expect(outbox).toContain("sendRefundEmail");
    expect(read("lib/email.ts")).toContain('template: "refund"');

    // Ordering is the finding: the notice is enqueued by the reversal itself, so
    // it exists durably whether or not anything drains mail afterwards...
    const reversals = settle.indexOf("export async function reversePayment");
    const enqueue = settle.indexOf('type: "REFUND_EMAIL"');
    const txEnd = settle.indexOf("MONEY_TX", reversals);
    expect(reversals).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(reversals);
    expect(enqueue).toBeLessThan(txEnd);
    // ...and the key makes redelivery of the same reversal produce one mail.
    expect(settle).toContain("dedupeKey: `refund-${paymentId}`");
    // The inline drain is after the transaction, and it does drain this type.
    const drain = settle.indexOf('"post-reversal-drain"');
    expect(drain).toBeGreaterThan(txEnd);
    expect(settle.slice(enqueue, drain)).toContain('"REFUND_EMAIL"');
  });

  it("never sends a receipt for money going the other way", () => {
    // A receipt documents a purchase, and this purchase no longer stands.
    const settle = read("lib/settle.ts");
    const reversals = settle.indexOf("export async function reversePayment");
    const reversalBody = settle.slice(reversals);
    expect(reversalBody).toContain("Deliberately no RECEIPT_EMAIL");
    expect(reversalBody).not.toContain('type: "RECEIPT_EMAIL"');
  });
});

describe("a declined attempt is not noise (R08-6)", () => {
  it("classifies a single declined card attempt", () => {
    expect(
      stripePayloadIsDeclined({
        type: "payment_intent.payment_failed",
        data: {},
      }),
    ).toBe(true);
  });

  it("does not confuse it with a failure, a payment, or a reversal", () => {
    expect(
      stripePayloadIsDeclined({ type: "checkout.session.expired", data: {} }),
    ).toBe(false);
    expect(
      stripePayloadIsDeclined({ type: "checkout.session.completed", data: {} }),
    ).toBe(false);
    expect(stripePayloadIsDeclined({ type: "charge.refunded", data: {} })).toBe(
      false,
    );
    expect(stripePayloadIsDeclined({})).toBe(false);
    expect(stripePayloadIsDeclined(null)).toBe(false);
  });

  it("reaches the register as a declined attempt, with the payment untouched", () => {
    const route = read("app/api/webhooks/stripe/route.ts");
    expect(route).toContain(
      'detail: stripePayloadIsDeclined(payload) ? "declined-attempt" : "unrelated-event"',
    );
    // Status quo kept: a declined attempt must not cancel the session.
    expect(route).toContain('outcome: "ignored"');
  });
});

describe("an abandoned checkout stops being pending (R08-5)", () => {
  const row = (over: Partial<Parameters<typeof isAbandonable>[0]> = {}) => ({
    status: PaymentStatus.PENDING,
    providerCheckoutUrl: null as string | null,
    providerRef: null as string | null,
    createdAt: new Date(Date.now() - CHECKOUT_ABANDON_TTL_MS - 60_000),
    ...over,
  });

  it("requires pending, no provider session, and age", () => {
    expect(isAbandonable(row())).toBe(true);
    // Too young: the create response may still be in flight for this one.
    expect(
      isAbandonable(row({ createdAt: new Date(Date.now() - 60_000) })),
    ).toBe(false);
    // A buyer can still be at a page we already opened.
    expect(
      isAbandonable(
        row({ providerCheckoutUrl: "https://checkout.stripe.com/c/pay/cs_1" }),
      ),
    ).toBe(false);
    // A reference means a charge exists or may exist; never silently closed.
    expect(isAbandonable(row({ providerRef: "cs_1" }))).toBe(false);
  });

  it("never touches a payment that reached a decision", () => {
    for (const status of [
      PaymentStatus.PAID,
      PaymentStatus.FAILED,
      PaymentStatus.CANCELED,
      PaymentStatus.REFUNDED,
    ]) {
      expect(isAbandonable(row({ status }))).toBe(false);
    }
  });

  it("is strictly older than the horizon, not equal to it", () => {
    const now = new Date("2026-01-02T00:00:00Z");
    expect(abandonCutoff(now).getTime()).toBe(
      now.getTime() - CHECKOUT_ABANDON_TTL_MS,
    );
    const atCutoff = new Date(abandonCutoff(now));
    expect(isAbandonable(row({ createdAt: atCutoff }), now)).toBe(false);
    expect(
      isAbandonable(row({ createdAt: new Date(atCutoff.getTime() - 1) }), now),
    ).toBe(true);
  });

  it("is exposed as an authenticated, bounded job", () => {
    const route = read("app/api/jobs/abandoned-checkouts/route.ts");
    expect(route).toContain("jobGate");
    expect(route).toContain("ABANDON_MAX_BATCH");
    // Both verbs through the route boundary that fills in the 405/OPTIONS
    // answers and the request id (R11-3). Every route destructures all seven
    // verb names since R11-3 — the boundary is what answers the ones a route
    // does not implement — so what this pins is that two are implemented.
    expect(route).toMatch(
      /export const \{ GET, POST, PUT, PATCH, DELETE, OPTIONS \} = apiRoute\(\{/,
    );
    expect(route).toMatch(/^ {2}GET: \w+,$/m);
    expect(route).toMatch(/^ {2}POST: \w+,$/m);
    expect(route).not.toMatch(/^ {2}(PUT|PATCH|DELETE): /m);
    // The status it writes has to be reachable and auditable, or CANCELED is
    // still a state nothing produces.
    expect(read("lib/abandonedCheckouts.ts")).toContain(
      "status: PaymentStatus.CANCELED",
    );
    expect(read("lib/audit.ts")).toContain('"CHECKOUT_ABANDONED"');
    expect(ABANDON_MAX_BATCH).toBeGreaterThan(0);
  });
});

describe("money that contradicts itself reaches a human (R08-3)", () => {
  it("answers 503 for the three findings that can only mean a real defect", () => {
    const route = read("app/api/jobs/reconcile/route.ts");
    // Three since R12-2 added `aggregate`: a drifted stored aggregate is the
    // same class of claim as the other two — it cannot be a quiet week. The
    // expression is read out of the source rather than matched as one line, so
    // a reformat cannot pass for a change of policy.
    const failing = /const failing =([\s\S]*?);/.exec(route)?.[1] ?? "";
    expect(failing).not.toBe("");
    for (const arm of [
      "divergentRows.length > 0",
      "unappliedRows.length > 0",
      "aggregateRows.length > 0",
    ]) {
      expect(failing).toContain(arm);
    }
    // The advisory findings must not be in that expression: a report that pages
    // on them is muted before the money case ever fires.
    expect(failing).not.toContain("stale");
    expect(route).toContain("status: failing ? 503 : 200");
    expect(route).toContain("unapplied: {");
    expect(route).toContain("stale: {");
  });

  it("finds a rejected delivery that was never superseded", () => {
    const route = read("app/api/jobs/reconcile/route.ts");
    // Grace first: a 5xx retry in flight is not a page.
    expect(route).toContain("UNAPPLIED_GRACE_MS");
    expect(route).toContain('outcome: "ERROR"');
    expect(route).toContain("paymentId: { not: null }");
    // PENDING = captured and never applied; PAID past its paidAt = a reversal
    // that never unwound. Both are the money case.
    expect(route).toContain('if (p.status === "PENDING") return true;');
    expect(route).toContain(
      'return p.status === "PAID" && p.paidAt !== null && r.createdAt > p.paidAt;',
    );
  });

  it("is polled every ten minutes, and the money step runs first", () => {
    const wf = read(".github/workflows/outbox-tick.yml");
    // A third cron is impossible on the deployed plan, which is why this tick
    // is the alerting channel — the workflow is the fix site, not vercel.json.
    expect(wf).toContain("*/10 * * * *");
    expect(read("vercel.json")).not.toContain("reconcile");

    const guard = wf.indexOf("- name: Fail loudly when CRON_SECRET is missing");
    const sweep = wf.indexOf("- name: Abandon stale checkouts");
    const reconcile = wf.indexOf("- name: Reconcile");
    const config = wf.indexOf("- name: Config gaps");
    expect(guard).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(guard);
    expect(reconcile).toBeGreaterThan(sweep);
    expect(config).toBeGreaterThan(reconcile);
    expect(wf).toContain("/api/jobs/abandoned-checkouts");

    // Both read the status code AND the body: a 200 carrying findings must fail
    // the step, and both diagnostic steps must run whatever the other answered,
    // or one 503 keeps the other's findings out of the log.
    expect(wf.slice(reconcile, config)).toContain("if: ${{ !cancelled() }}");
    expect(wf.slice(config)).toContain("if: ${{ !cancelled() }}");
    expect(wf).toContain("jq -r '.divergent.count // 0'");
    expect(wf).toContain("jq -r '.unapplied.count // 0'");
    expect(wf).toContain(
      'if [ "$code" != "200" ] || [ "$div" != "0" ] || [ "$un" != "0" ]; then',
    );
    expect(wf).toContain("::error::/api/jobs/reconcile HTTP $code");
    expect(wf).toContain('echo "::error::/api/jobs/config answered $code');
  });
});
