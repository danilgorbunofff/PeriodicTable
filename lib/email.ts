/**
 * Transactional email — Resend via fetch when RESEND_API_KEY is set;
 * without a key, sends are logged as EmailLog{status:"logged"} so the
 * pipeline is testable end-to-end locally. Suppression + EmailLog always.
 * The stored status vocabulary is `EmailLogStatus`, not a bare string (R12-3):
 * only `sent` means the vendor accepted the message.
 *
 * Four rules hold for every send (R10-1, R10-5, R10-7, R10-11, R13-8):
 * - The suppression list is consulted before the provider. An address that
 *   asked us to stop is never handed over, and the refusal is logged — a
 *   silent skip would be indistinguishable from a delivery.
 * - The outcome is never swallowed. Each send returns what happened, including
 *   the provider's own answer, so the outbox can fail the row instead of
 *   stamping a failed mail delivered.
 * - Every row carries the outbox dedupe key it was sent for, and the provider's
 *   receipt when there is one, so the log and the queue can be reconciled.
 * - The message's identity is asserted to the *provider*, not only to our own
 *   register: the same dedupe key travels as Resend's Idempotency-Key (R13-8),
 *   so a send whose response was lost to a timeout is retried without a second
 *   copy reaching the buyer.
 */
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { prisma } from "./prisma";
import { joinMin } from "./pricing";
import { outbidHtml, outbidSubject } from "../emails/outbid";
import { outbidReclaimUrl } from "./links";
import { receiptHtml, receiptSubject } from "../emails/receipt";
import { refundHtml, refundSubject } from "../emails/refund";
import { reportHtml, reportSubject } from "../emails/report";
import { waitlistHtml, waitlistSubject } from "../emails/waitlist";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/** How a send ended, plus the provider's own answer when there is one. */
export type DeliveryResult = {
  status: "sent" | "logged" | "error";
  providerStatus?: number;
  providerMessageId?: string;
  /** Why it failed: the provider's status and body, or the thrown error. */
  error?: string;
};

/** What a caller (the outbox) is told: enough to decide retry vs. give up. */
export type SendOutcome = {
  status: DeliveryResult["status"] | "suppressed";
  emailLogId: string;
  error?: string;
};

/**
 * Why an address must not be mailed (R10-5/R10-7).
 *
 * - `unsubscribe` — the person used the link; only the person can lift it.
 * - `invalid` — the address cannot receive mail at all (no mailbox there).
 * - `bounce` — the provider told us it is undeliverable.
 * - `complaint` — the provider told us the person marked our mail as spam.
 * - `manual` — an operator put it on the list.
 *
 * The reasons are not interchangeable, and `refuses` decides what each one
 * blocks: `bounce`/`invalid` say nothing can be delivered at all, the other
 * three say stop talking about listings. `suppressEmail` keeps the stronger of
 * a new and a recorded reason for that reason.
 */
export type SuppressionReason =
  "unsubscribe" | "invalid" | "bounce" | "complaint" | "manual";
const SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  "unsubscribe",
  "invalid",
  "bounce",
  "complaint",
  "manual",
];

/** The two reasons that block every kind of message, not only list mail. */
const UNDELIVERABLE_REASONS: readonly SuppressionReason[] = [
  "bounce",
  "invalid",
];
const isUndeliverable = (reason: SuppressionReason | null): boolean =>
  reason !== null &&
  (UNDELIVERABLE_REASONS as readonly string[]).includes(reason);

/** A reason as stored, coerced to this module's union — an unknown string was
 *  put on the table by hand, which is what `manual` means. */
function storedReason(
  raw: string | null | undefined,
): SuppressionReason | null {
  if (!raw) return null;
  return (SUPPRESSION_REASONS as readonly string[]).includes(raw)
    ? (raw as SuppressionReason)
    : "manual";
}

/** What kind of message a send is — the only thing that decides whether a
 *  recorded refusal applies to it (see `refuses`, and §9 Q1). */
export type MailKind = "list" | "account" | "internal";

/** The EmailLog status that records a refusal, distinct from every send. */
export const suppressionStatus = (
  reason: SuppressionReason,
): `suppressed:${SuppressionReason}` => `suppressed:${reason}`;

/**
 * Everything `EmailLog.status` may hold, and nothing else (R12-3).
 *
 * The column is a plain `String`, so the database accepts any word here; before
 * this type the same was true of the writer, whose parameter was `string`. The
 * vocabulary the schema comment claimed (`sent | suppressed | error`) had
 * already lost a member — `deliver()` returns `logged` whenever there is no
 * RESEND_API_KEY, which is the state every local database is in, so all 32 rows
 * in the review's snapshot held a value the comment denied.
 *
 * Only `sent` means the provider accepted the message: `logged` is a rehearsed
 * send with no vendor in the loop, `suppressed:<reason>` never left the
 * building, and `error` was refused. Keep the distinction readable at the call
 * site rather than in a comment (schema.prisma, model EmailLog).
 */
export type EmailLogStatus =
  DeliveryResult["status"] | ReturnType<typeof suppressionStatus>;

export function normalizeRecipient(raw: string): string {
  return raw.trim().toLowerCase();
}

/** The standing of an address, or null when it may be mailed.
 *
 * The row is the address's record, not only a refusal: it also holds the
 * address's unsubscribe handle (`addressToken`), so the two questions every send
 * asks — "may we mail this" and "which link stops it" — are answered by one
 * lookup keyed on the thing a person actually controls.
 */
export async function suppressionFor(
  email: string,
): Promise<SuppressionReason | null> {
  const row = await prisma.emailAddress.findUnique({
    where: { email: normalizeRecipient(email) },
    select: { reason: true },
  });
  return storedReason(row?.reason);
}

/**
 * The opaque unsubscribe handle for an address (R10-5), minted on first use.
 *
 * The handle names the *address*, not a listing: a receipt's recipient is
 * `payment.email ?? listing.email` (`lib/settle.ts`), and the footer used to
 * carry the listing's token, so a link in a message sent to a payment address
 * resolved to a different listing — or to nothing at all. Whoever received the
 * message is the person the link belongs to.
 *
 * Minted rather than derived: a signed address would put the address itself (or
 * a reversible form of it) into every footer, and the token is also what the
 * confirm page shows. The row is created for every address we mail, so the
 * handle is stable across messages and after a re-subscribe.
 */
export async function addressToken(email: string): Promise<string> {
  const normalized = normalizeRecipient(email);
  const row = await prisma.emailAddress.upsert({
    where: { email: normalized },
    create: { email: normalized },
    update: {},
    select: { token: true },
  });
  return row.token;
}

/** What an unsubscribe link resolves to.
 *
 * `address` is the handle above. `startup` is the listing-scoped token the
 * footers carried before this fix (and the RFC 8058 `List-Unsubscribe` header
 * that shares it): links in mail already sitting in inboxes must keep working
 * for as long as that mail can be clicked.
 */
export type UnsubTarget =
  | { kind: "address"; email: string }
  | { kind: "startup"; startupId: string; email: string | null };

export async function resolveUnsubTarget(
  token: string,
): Promise<UnsubTarget | null> {
  if (!token) return null;
  const address = await prisma.emailAddress.findUnique({
    where: { token },
    select: { email: true },
  });
  if (address) return { kind: "address", email: address.email };
  const startup = await prisma.startup.findUnique({
    where: { unsubToken: token },
    select: { id: true, email: true },
  });
  return startup
    ? { kind: "startup", startupId: startup.id, email: startup.email }
    : null;
}

/**
 * Record a refusal. Idempotent; a later reason replaces an earlier one, with
 * one exception.
 *
 * Suppressed is suppressed — the reason says *why* the operator sees no mail,
 * so a bounce after a manual entry changes the account of the refusal, not
 * whether one exists. The exception is the stronger reason: `bounce`/`invalid`
 * mean the address receives nothing at all, and a later, weaker reason must not
 * quietly promote it back to "list mail only" (`refuses`), which would restart
 * money notices to a mailbox the provider has already refused. The reverse
 * direction is not a narrowing: a consent reason refuses list mail just as
 * absolutely, and only the money mail it never covered stops. The history of
 * both is in `AuditLog` and in the `suppressed:<reason>` rows this writes.
 */
export async function suppressEmail(p: {
  email: string;
  reason: SuppressionReason;
  source?: string | null;
  detail?: string | null;
}): Promise<void> {
  const email = normalizeRecipient(p.email);
  const existing = storedReason(
    (
      await prisma.emailAddress.findUnique({
        where: { email },
        select: { reason: true },
      })
    )?.reason,
  );
  // A person's own request and an operator's are both weaker than evidence that
  // nothing can be delivered: an unsubscribe arriving after a permanent bounce
  // keeps the bounce, because the attempt would only produce a provider error.
  let reason = p.reason;
  if (existing && isUndeliverable(existing) && !isUndeliverable(p.reason))
    reason = existing;
  const data = { reason, source: p.source ?? null, detail: p.detail ?? null };
  await prisma.emailAddress.upsert({
    where: { email },
    create: { email, ...data },
    update: data,
  });
}

/** Lift a refusal — only from the person asking to be mailed again (R10-5).
 *  The row (and the address's handle) stays: re-subscribing is a new standing,
 *  not a forgotten address. Returns whether anything changed. */
export async function unsuppressEmail(email: string): Promise<boolean> {
  const { count } = await prisma.emailAddress.updateMany({
    where: { email: normalizeRecipient(email), reason: { not: null } },
    data: { reason: null, source: "unsubscribe", detail: "re-subscribed" },
  });
  return count > 0;
}

/** How many addresses we are refusing to mail (operator report). */
export async function suppressedCount(): Promise<number> {
  return prisma.emailAddress.count({ where: { reason: { not: null } } });
}

/** Svix (Resend webhooks) replays a delivery for up to this long. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
function timingSafeBase64Equal(expected: Buffer, candidate: string): boolean {
  let given: Buffer;
  try {
    given = Buffer.from(candidate, "base64");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Verify a delivery from Resend (R10-7).
 *
 * Resend signs webhooks with Svix: the secret is base64 (usually written
 * `whsec_<base64>`), the signed content is `${id}.${timestamp}.${rawBody}`, and
 * `svix-signature` carries one or more space-separated `v1,<base64 hmac>`
 * entries so a rotation can overlap. Timestamps outside the tolerance are
 * refused so a captured delivery cannot be replayed at leisure.
 *
 * Fails closed in every direction: no secret configured, no headers, unparseable
 * timestamp, or no matching signature all return false. An unauthenticated
 * caller must not be able to suppress an address — the whole point of the
 * suppression list is that only real evidence puts an address on it.
 */
export function verifyResendWebhook(
  rawBody: string,
  headers: Headers,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const id = headers.get("svix-id");
  const stamp = headers.get("svix-timestamp");
  const signature = headers.get("svix-signature");
  if (!secret || !id || !stamp || !signature) return false;
  const timestamp = Number.parseInt(stamp, 10);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS)
    return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`, "utf8")
    .digest();
  return signature.split(" ").some((entry) => {
    const comma = entry.indexOf(",");
    if (comma < 0) return false;
    const version = entry.slice(0, comma).trim();
    return (
      version === "v1" &&
      timingSafeBase64Equal(expected, entry.slice(comma + 1).trim())
    );
  });
}

/** Event types Resend sends today. A delivery carrying anything else is
 *  acknowledged and logged rather than failed: we cannot tell a new provider
 *  event from a typo, and a non-2xx makes the provider retry a delivery we will
 *  never understand. */
export const RESEND_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.complained",
  "email.bounced",
  "email.opened",
  "email.clicked",
  "email.failed",
  "email.scheduled",
  "email.received",
] as const;

/**
 * What a provider event means for the address it names (R10-7).
 *
 * Only evidence that the address is unusable, or that the person objected,
 * suppresses anything:
 * - a **permanent** bounce is a dead mailbox → `bounce`;
 * - a complaint is the person (or their provider) saying stop → `complaint`;
 * - a send failure is the provider rejecting the address → `invalid`.
 *
 * A **transient** bounce is deliberately not a suppression: a full mailbox or a
 * greylisted server says try later, and an address suppressed there would stop
 * receiving the money notices that are the one thing we have promised to send.
 * Its event is still audited, so an operator can see the pattern.
 */
export function resendEventEffect(
  type: string,
  bounceType?: string | null,
): { suppress: SuppressionReason | null; note: string } {
  switch (type) {
    case "email.bounced": {
      const kind = (bounceType ?? "").trim() || "unspecified";
      return kind.toLowerCase() === "permanent"
        ? { suppress: "bounce", note: `bounced (${kind.toLowerCase()})` }
        : {
            suppress: null,
            note: `bounced (${kind.toLowerCase()}) — not permanent, not suppressed`,
          };
    }
    case "email.complained":
      return { suppress: "complaint", note: "marked as spam" };
    case "email.failed":
      return { suppress: "invalid", note: "provider rejected the send" };
    default:
      return { suppress: null, note: type };
  }
}

async function logEmail(row: {
  to: string;
  template: string;
  elementSymbol?: string | null;
  amountUsd?: number | null;
  status: EmailLogStatus;
  detail?: string | null;
  dedupeKey?: string | null;
  providerMessageId?: string | null;
  providerStatus?: number | null;
  error?: string | null;
}): Promise<string> {
  const created = await prisma.emailLog.create({
    data: {
      to: row.to,
      template: row.template,
      elementSymbol: row.elementSymbol ?? null,
      amountUsd: row.amountUsd ?? null,
      status: row.status,
      detail: row.detail ?? null,
      dedupeKey: row.dedupeKey ?? null,
      providerMessageId: row.providerMessageId ?? null,
      providerStatus: row.providerStatus ?? null,
      error: row.error ?? null,
    },
  });
  return created.id;
}

/**
 * Whether a recorded refusal applies to this kind of message (§9 Q1).
 *
 * `list` mail is about a listing's standing — a receipt, an outbid notice, a
 * waitlist confirmation — and stops for *any* recorded reason. That is what the
 * footer link promises, and the previous behaviour was the opposite accident: a
 * preference about marketing mail silently disabled "you lost #1".
 *
 * `account` mail is a money notice to the buyer (a reversal). It survives a
 * consent reason: the person asked us to stop telling them about a listing, not
 * to stop telling them about their money. It does not survive `bounce` or
 * `invalid`, where the address cannot receive anything and the attempt would
 * produce only a provider error.
 *
 * `internal` mail goes to our own inbox and is judged like `account` — nobody
 * subscribed to it, so a list preference has nothing to say about it.
 *
 * So the reasons split two ways: `bounce` and `invalid` say *nothing can be
 * delivered*, and the rest — `unsubscribe` (the person asked), `complaint`
 * (their provider asked), `manual` (an operator did) — say *stop talking about
 * listings*, which is what the footer offers.
 */
export function refuses(reason: SuppressionReason, kind: MailKind): boolean {
  if (kind === "list") return true;
  return reason === "bounce" || reason === "invalid";
}

/** The footer link and `List-Unsubscribe` URL for a message to this address. */
async function unsubUrlFor(to: string): Promise<string> {
  return `${APP_URL}/api/unsubscribe?token=${await addressToken(to)}`;
}

/**
 * The one path every template shares: refuse, deliver, log.
 *
 * The suppression check happens here rather than at the outbox so that a direct
 * caller (a refund notice, an operator report) cannot bypass it.
 */
async function sendMessage(p: {
  to: string;
  template: string;
  subject: string;
  html: string;
  kind: MailKind;
  /** The address's own handle, when this message carries an opt-out. */
  unsubUrl?: string | null;
  elementSymbol?: string | null;
  amountUsd?: number | null;
  /** Overrides the logged detail (which defaults to the subject). */
  detail?: string | null;
  dedupeKey?: string | null;
}): Promise<SendOutcome> {
  const to = normalizeRecipient(p.to);
  const detail = p.detail ?? p.subject;
  const suppressed = await suppressionFor(to);
  if (suppressed && refuses(suppressed, p.kind)) {
    const emailLogId = await logEmail({
      to,
      template: p.template,
      elementSymbol: p.elementSymbol,
      amountUsd: p.amountUsd,
      status: suppressionStatus(suppressed),
      // The reason rides in the status and in the detail: the operator's first
      // question about a mail that never arrived is "why not".
      detail: `refused (${suppressed}): ${detail}`,
      dedupeKey: p.dedupeKey,
    });
    return { status: "suppressed", emailLogId };
  }
  const result = await deliver(
    to,
    p.subject,
    p.html,
    p.unsubUrl ?? null,
    p.dedupeKey,
  );
  const emailLogId = await logEmail({
    to,
    template: p.template,
    elementSymbol: p.elementSymbol,
    amountUsd: p.amountUsd,
    status: result.status,
    detail,
    dedupeKey: p.dedupeKey,
    providerMessageId: result.providerMessageId,
    providerStatus: result.providerStatus,
    error: result.error,
  });
  return { status: result.status, emailLogId, error: result.error };
}

/** Resend caps Idempotency-Key at 256 characters. A longer dedupe key is
 *  hashed rather than truncated, so two long keys can never collide by sharing
 *  a prefix — and the `pt_mail_` prefix keeps our keys distinguishable from any
 *  other caller's if the account is ever shared. */
export function mailIdempotencyKey(dedupeKey: string): string {
  const key = `pt_mail_${dedupeKey}`;
  return key.length <= 256
    ? key
    : `pt_mail_sha256_${createHash("sha256").update(dedupeKey).digest("hex")}`;
}

async function deliver(
  to: string,
  subject: string,
  html: string,
  unsubUrl: string | null,
  dedupeKey?: string | null,
): Promise<DeliveryResult> {
  if (!process.env.RESEND_API_KEY) return { status: "logged" };
  try {
    // RFC 8058 one-click unsubscribe (P1-18): POST endpoint + headers. The
    // token is opaque; no email address ever appears in a URL.
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        ...(unsubUrl
          ? {
              "List-Unsubscribe": `<${unsubUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            }
          : {}),
        // R13-8: the provider is keyed by the same string our own register is
        // keyed by. `dedupeKey` is exactly "which logical message is this" — it
        // is unique per OutboxEvent row and stable across that row's attempts —
        // so a retry after a timed-out send (the response was lost, the mail
        // was not) returns the first response instead of mailing twice, and the
        // operator reading a dedupe key in /api/admin/outbox/retry is reading
        // the provider's key too. No key, no header: an inline send with nothing
        // to identify it must not borrow another message's identity.
        ...(dedupeKey
          ? { "Idempotency-Key": mailIdempotencyKey(dedupeKey) }
          : {}),
      },
      body: JSON.stringify({
        from:
          process.env.EMAIL_FROM ?? "periodictable.lol <hi@periodictable.lol>",
        to,
        subject,
        html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // The provider's own words are the only diagnosis an operator gets, so
      // they are kept rather than replaced by a bare "error" (R10-1).
      const body = await res.text().catch(() => "");
      return {
        status: "error",
        providerStatus: res.status,
        error: truncate(`resend ${res.status}: ${body}`),
      };
    }
    // Resend answers 200 with the message id; a body we cannot parse is still
    // a successful send, just one with no provider receipt on file.
    const receipt = (await res.json().catch(() => null)) as {
      id?: string;
    } | null;
    return {
      status: "sent",
      providerStatus: res.status,
      providerMessageId: receipt?.id,
    };
  } catch (e) {
    return {
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Provider bodies are unbounded; the register keeps the first 500 characters,
 *  the same width the outbox row's lastError uses. */
function truncate(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

export type OutbidEmailParams = {
  to: string;
  elementSymbol: string;
  elementName?: string;
  victimDomain: string;
  victimTotal: number;
  winnerDomain: string;
  winnerAmount: number;
  /** The outbox row this send belongs to (R10-11). */
  dedupeKey?: string | null;
};

export async function sendOutbidEmail(
  p: OutbidEmailParams,
): Promise<SendOutcome> {
  const reclaim = Math.max(1, p.winnerAmount + 1 - p.victimTotal);
  const subject = outbidSubject({ elementSymbol: p.elementSymbol });
  const unsubUrl = await unsubUrlFor(p.to);
  const html = outbidHtml({
    elementSymbol: p.elementSymbol,
    winnerDomain: p.winnerDomain,
    winnerAmount: p.winnerAmount,
    reclaim,
    // R09-5, mail half: a reclaim quoted below the first-join floor is a figure
    // only a live stake can take. If that stake was refunded in the meantime the
    // click is reclassified as a first join and refused, so the mail names the
    // floor instead of letting the intake answer with the newcomer message.
    reentryFloor: reclaim < joinMin() ? joinMin() : null,
    reclaimUrl: outbidReclaimUrl(APP_URL, {
      elementSymbol: p.elementSymbol,
      reclaim,
      domain: p.victimDomain,
    }),
    unsubUrl,
  });
  return sendMessage({
    to: p.to,
    template: "outbid",
    subject,
    html,
    kind: "list",
    unsubUrl,
    elementSymbol: p.elementSymbol,
    amountUsd: reclaim,
    dedupeKey: p.dedupeKey,
  });
}

export type ReceiptEmailParams = {
  to: string;
  elementSymbol: string;
  elementName: string;
  amountUsd: number;
  rank: number;
  domain: string;
  /** R09-2: present when the payment's take quote had lapsed before it
   *  settled — the quoted total, so the mail can own the downgrade. */
  lapsedTakeTotal?: number | null;
  /** R10-4: the top-up this payment added to a stake the buyer already had.
   *  The receipt's `amountUsd` is the applied total, which on a reclaim path is
   *  the whole holding rather than the increment that was charged; both are
   *  stated, because "$7" for a $2 charge and "$2" for a $7 holding are each
   *  wrong in the same way. */
  topUpUsd?: number | null;
  /** The outbox row this send belongs to (R10-11). */
  dedupeKey?: string | null;
};

export async function sendReceiptEmail(
  p: ReceiptEmailParams,
): Promise<SendOutcome> {
  const subject = receiptSubject({
    elementSymbol: p.elementSymbol,
    elementName: p.elementName,
    rank: p.rank,
  });
  const unsubUrl = await unsubUrlFor(p.to);
  const html = receiptHtml({
    elementSymbol: p.elementSymbol,
    elementName: p.elementName,
    amountUsd: p.amountUsd,
    rank: p.rank,
    domain: p.domain,
    lapsedTakeTotal: p.lapsedTakeTotal ?? null,
    topUpUsd: p.topUpUsd ?? null,
    viewUrl: `${APP_URL}/s/${encodeURIComponent(p.domain)}`,
    unsubUrl,
  });
  return sendMessage({
    to: p.to,
    template: "receipt",
    subject,
    html,
    kind: "list",
    unsubUrl,
    elementSymbol: p.elementSymbol,
    amountUsd: p.amountUsd,
    dedupeKey: p.dedupeKey,
  });
}

export type RefundEmailParams = {
  to: string;
  elementSymbol: string;
  elementName: string;
  amountUsd: number;
  domain: string;
  providerRef: string | null;
  /** The outbox row this send belongs to (R10-11). */
  dedupeKey?: string | null;
};

/** Buyer notice for a reversed payment (R08-2). Enqueued inside the reversal
 *  transaction, so the notice survives a process death between commit and
 *  delivery — a refund the buyer never hears about is the one mail in this
 *  system that cannot be left to best-effort. It is `account` mail for the
 *  suppression check for the same reason: it survives an unsubscribe. */
export async function sendRefundEmail(
  p: RefundEmailParams,
): Promise<SendOutcome> {
  const subject = refundSubject({
    elementSymbol: p.elementSymbol,
    amountUsd: p.amountUsd,
  });
  const unsubUrl = await unsubUrlFor(p.to);
  const html = refundHtml({
    elementSymbol: p.elementSymbol,
    elementName: p.elementName,
    amountUsd: p.amountUsd,
    domain: p.domain,
    providerRef: p.providerRef,
    unsubUrl,
  });
  return sendMessage({
    to: p.to,
    template: "refund",
    subject,
    html,
    kind: "account",
    unsubUrl,
    elementSymbol: p.elementSymbol,
    amountUsd: p.amountUsd,
    dedupeKey: p.dedupeKey,
  });
}

export type ReportEmailParams = {
  to: string;
  id: string;
  domain: string | null;
  stakeId: string | null;
  reason: string;
  createdAt: Date;
  /** The outbox row this send belongs to (R10-11). */
  dedupeKey?: string | null;
};

/** Operator notification for a new report (R05-7). No unsubscribe header: this
 *  is a one-off operational message to the moderation inbox, not a list — a
 *  list preference has nothing to say about it (see `refuses`). */
export async function sendReportEmail(
  p: ReportEmailParams,
): Promise<SendOutcome> {
  const subject = reportSubject({ domain: p.domain });
  const html = reportHtml({
    id: p.id,
    domain: p.domain,
    stakeId: p.stakeId,
    reason: p.reason,
    createdAt: `${p.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    queueUrl: `${APP_URL}/api/admin/reports`,
  });
  return sendMessage({
    to: p.to,
    template: "report",
    subject,
    html,
    kind: "internal",
    dedupeKey: p.dedupeKey,
  });
}

export type WaitlistEmailParams = {
  to: string;
  domain: string | null;
  source: string;
  /** The outbox row this send belongs to (R10-11). */
  dedupeKey?: string | null;
};

/** Confirmation to the address that joined the waitlist (R05-7).
 *
 *  R10-6: the waitlist confirmation was the one mail with no way out — no
 *  unsubscribe header and no link, only "reply and we'll remove you". The
 *  footer now carries the address's own handle, minted at send time (R10-5). */
export async function sendWaitlistEmail(
  p: WaitlistEmailParams,
): Promise<SendOutcome> {
  const subject = waitlistSubject();
  const unsubUrl = await unsubUrlFor(p.to);
  const html = waitlistHtml({ domain: p.domain, tableUrl: APP_URL, unsubUrl });
  return sendMessage({
    to: p.to,
    template: "waitlist",
    subject,
    html,
    kind: "list",
    unsubUrl,
    detail: `${subject} (${p.source})`,
    dedupeKey: p.dedupeKey,
  });
}
