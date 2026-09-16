/** Data-subject erasure (R12-4): the routine behind "delete my data".
 *
 * The shape is forced by the schema rather than chosen. `Payment.startupId` and
 * `Payment.elementId` are ON DELETE RESTRICT (12 §5.7), so a request cannot be
 * served by deleting rows; the routine *scrubs* every column that holds the
 * person, keeps every row, and keeps every id. Ledgers, receipts, provider
 * registers and the audit trail stay internally consistent — only the identity
 * goes. `scripts/clear-launch-inventory.ts` is the one place that deletes, and
 * it exists to remove *inventory* rows; this file is its opposite number for
 * people.
 *
 * Three decisions are recorded here because the doc that asks for them (12
 * §5.12) explicitly leaves the policy to `16` and the runbook to `17`:
 *
 *   · **The window is an argument, never a default.** `days` is required and
 *     `0` means "keep nothing". A guessed window is a silently kept address, so
 *     the code refuses to guess: the operator states the retention decision at
 *     the point of the run, and the report echoes the cutoff it produced.
 *   · **The window covers the record scopes only** — the append-only rows whose
 *     retention is defensible while a delivery dispute or a refund window is
 *     open (`EmailLog`, `ProviderEvent`, the completed outbox, `AuditLog.detail`).
 *     Identity columns (`Payment.email`, `Startup.email`, …) are erased whatever
 *     their age: the request is the basis for those, not a retention rule. Each
 *     scope reports the rows it held back, so nothing is left behind quietly.
 *   · **Mail that has not gone out yet is never held back.** An uncompleted
 *     `OutboxEvent` whose payload names the subject is cancelled — payload
 *     scrubbed, `completedAt` set — because a send that happens *after* the
 *     request is the thing the request forbids.
 *
 * Known limit, stated rather than hidden: `ProviderEvent.payload` is rewritten,
 * but a provider *redelivery* for a row still in ERROR can write a fresh copy of
 * the delivery, because `lib/settle.ts` only refuses to rewrite terminal rows.
 * Re-run the sweep once the delivery queue is quiet.
 *
 * `previewErasure` and `eraseSubject` run the identical scan; the difference is
 * one boolean, so the printed plan is the plan.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { audit } from "./audit";
import { normalizeRecipient } from "./email";

/** What replaces a value that cannot be nulled — a unique column, or a row
 *  whose shape other code relies on. Deliberately not an address: no `@`, so a
 *  marker can never be normalized into a recipient or matched by a later sweep. */
export const ERASURE_MARKER = "[erased]";

/** Unique columns need one marker per row, or the second erasure would collide. */
const erasedValue = (id: string): string => `erased-${id}`;

/** The interactive transaction runs one statement per matched row, so it needs
 *  more headroom than Prisma's 5s default — an erasure that times out halfway
 *  would roll back, which is safe but useless to the operator. */
const TX = { timeout: 120_000, maxWait: 20_000 } as const;

type Db = Prisma.TransactionClient;

export type ErasureSubject = {
  /** The address as the operator typed it; normalized here. */
  email?: string;
  /** `Report.ipHash` / `ClickEvent.ipHash` value, for a subject who never
   *  supplied an address (already a hash — the column is the PII-adjacent
   *  fingerprint, so it is erased on request too). */
  ipHash?: string;
};

export type ErasureRequest = ErasureSubject & {
  /** Retention window in whole days; `0` erases every matching record. */
  days: number;
};

export type ErasureScopeReport = {
  scope: string;
  /** What this scope is, in the operator's terms. */
  note: string;
  /** Whether the retention window applies here. */
  windowed: boolean;
  /** Rows the sweep found (window already applied). */
  matched: number;
  /** Rows the window held back — non-zero means a later run has work to do. */
  kept: number;
  /** Rows changed; always 0 for a preview. */
  scrubbed: number;
  /** Set when the subject does not carry what this scope needs. */
  skipped?: string;
};

export type ErasureReport = {
  applied: boolean;
  subject: { email: string | null; ipHash: string | null };
  window: { days: number; cutoff: string };
  scopes: ErasureScopeReport[];
  totals: { matched: number; kept: number; scrubbed: number };
};

type Counts = { matched: number; kept: number; scrubbed: number };

/** A scope's scan and its scrub, kept apart so the preview runs the real scan
 *  and the scrub can never drift from the query that justified it. */
type Sweep<T> = {
  find: () => Promise<{ rows: T[]; kept: number }>;
  scrub: (rows: T[]) => Promise<number>;
};

type Scope = {
  scope: string;
  note: string;
  /** Which half of the subject this scope needs; the runner skips it otherwise,
   *  which is why a scope may read `ctx.email` without re-checking it. */
  requires: "email" | "ipHash";
  windowed: boolean;
  run: (db: Db, ctx: Ctx, apply: boolean) => Promise<Counts>;
};

type Ctx = { email: string; ipHash: string; cutoff: Date };

/** `%needle%` with LIKE's own metacharacters escaped — `_` and `%` are legal in
 *  an address, and an unescaped `_` would match any character. */
function likePattern(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** The same needle as a Postgres regex, for `regexp_replace` over free text. */
function regexPattern(needle: string): string {
  return needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const quote = (identifier: string): string => `"${identifier}"`;

/** Free-text columns that can hold an address: the audit trail's `detail` for
 *  `WAITLIST_JOINED`/`MANAGE_LINK_REQUESTED` (12 §5.11), the operator's own
 *  notes, and the provider errors that quote the recipient back at us. */
type TextColumn = { table: string; column: string };

const IDENTITY_TEXT: TextColumn[] = [
  { table: "Startup", column: "moderatedReason" },
  { table: "Report", column: "reason" },
  { table: "Report", column: "note" },
  { table: "EmailAddress", column: "detail" },
];

const RECORD_TEXT: TextColumn[] = [
  { table: "AuditLog", column: "detail" },
  { table: "EmailLog", column: "detail" },
  { table: "EmailLog", column: "error" },
  { table: "ProviderEvent", column: "detail" },
  { table: "OutboxEvent", column: "lastError" },
];

/** Every table the record scopes window is append-only and carries `createdAt`. */
const TIME_COLUMN = "createdAt";

const nameList = (columns: TextColumn[]): string =>
  columns.map((c) => `${c.table}.${c.column}`).join(", ");

async function countRows(db: Db, table: string, where: Prisma.Sql): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>(
    Prisma.sql`SELECT count(*)::int AS n FROM ${Prisma.raw(quote(table))} WHERE ${where}`
  );
  return rows[0]?.n ?? 0;
}

/** The scrub every free-text column shares: replace the address wherever it
 *  appears inside the value, and keep the rest of the sentence — an audit row
 *  says "the person behind an address unsubscribed", and that record is worth
 *  more with a marker in it than with a hole. */
async function sweepText(
  db: Db,
  ctx: Ctx,
  apply: boolean,
  columns: TextColumn[],
  windowed: boolean
): Promise<Counts> {
  const like = likePattern(ctx.email);
  const regex = regexPattern(ctx.email);
  let matched = 0;
  let kept = 0;
  let scrubbed = 0;

  for (const { table, column } of columns) {
    const tbl = Prisma.raw(quote(table));
    const field = Prisma.raw(quote(column));
    const where = windowed
      ? Prisma.sql`${field} ILIKE ${like} AND ${Prisma.raw(quote(TIME_COLUMN))} <= ${ctx.cutoff}`
      : Prisma.sql`${field} ILIKE ${like}`;

    matched += await countRows(db, table, where);
    if (windowed) {
      kept += await countRows(
        db,
        table,
        Prisma.sql`${field} ILIKE ${like} AND ${Prisma.raw(quote(TIME_COLUMN))} > ${ctx.cutoff}`
      );
    }
    if (apply) {
      // One statement per column: the UPDATE's own affected-row count is the
      // honest number, and it cannot disagree with the scan above.
      scrubbed += await db.$executeRaw(
        Prisma.sql`UPDATE ${tbl} SET ${field} = regexp_replace(${field}, ${regex}, ${ERASURE_MARKER}, 'gi') WHERE ${where}`
      );
    }
  }
  return { matched, kept, scrubbed };
}

/** Rewrite every string in a stored JSON payload, at any depth: the addresses
 *  in `OutboxEvent.payload.to` and in the provider's own event body sit under
 *  different keys, and a key list would rot the moment a provider adds one. */
function scrubJson(value: unknown, regex: RegExp): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const next = value.replace(regex, ERASURE_MARKER);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const result = scrubJson(entry, regex);
      changed ||= result.changed;
      return result.value;
    });
    return { value: next, changed };
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const result = scrubJson(entry, regex);
      changed ||= result.changed;
      next[key] = result.value;
    }
    return { value: next, changed };
  }
  return { value, changed: false };
}

/** The window's two halves, for the scopes that keep JSON: the JSON payload is
 *  matched as text (`payload::text`) because the address can sit anywhere in
 *  the document, then rewritten through Prisma so the column stays valid JSON. */
async function sweepJson<T extends { id: string }>(
  db: Db,
  ctx: Ctx,
  apply: boolean,
  options: {
    table: string;
    windowed: boolean;
    find: (ids: string[]) => Promise<T[]>;
    /** Rewrites one row and reports whether it had to; only called to apply. */
    write: (row: T, regex: RegExp) => Promise<number>;
    /** Extra `WHERE` text appended to the JSON containment scan. */
    extra?: Prisma.Sql;
  }
): Promise<Counts> {
  const like = likePattern(ctx.email);
  const window = options.windowed
    ? Prisma.sql` AND ${Prisma.raw(quote(TIME_COLUMN))} <= ${ctx.cutoff}`
    : Prisma.empty;
  const found = await db.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM ${Prisma.raw(quote(options.table))} WHERE payload::text ILIKE ${like}${window}${options.extra ?? Prisma.empty}`
  );
  const rows = found.length > 0 ? await options.find(found.map((r) => r.id)) : [];
  const kept = options.windowed
    ? await countRows(
        db,
        options.table,
        Prisma.sql`payload::text ILIKE ${like} AND ${Prisma.raw(quote(TIME_COLUMN))} > ${ctx.cutoff}${options.extra ?? Prisma.empty}`
      )
    : 0;
  const regex = new RegExp(regexPattern(ctx.email), "gi");
  let scrubbed = 0;
  if (apply) {
    for (const row of rows) {
      scrubbed += await options.write(row, regex);
    }
  }
  return { matched: rows.length, kept, scrubbed };
}

/** Run one `Sweep`, applying the scrub only when the operator asked for it. */
async function sweep<T>(apply: boolean, s: Sweep<T>): Promise<Counts> {
  const { rows, kept } = await s.find();
  const scrubbed = apply && rows.length > 0 ? await s.scrub(rows) : 0;
  return { matched: rows.length, kept, scrubbed };
}

const addressEq = (email: string) => ({ equals: email, mode: "insensitive" as const });

/** The full sweep, in report order: identity first, records second. */
const SCOPES: Scope[] = [
  {
    scope: "Payment.email",
    note: "the payer address captured at checkout — nulled; the payment, its amounts and its provider refs stay",
    requires: "email",
    windowed: false,
    run: (db, ctx, apply) =>
      sweep(apply, {
        find: async () => ({
          rows: await db.payment.findMany({ where: { email: addressEq(ctx.email) }, select: { id: true } }),
          kept: 0,
        }),
        scrub: async (rows) =>
          (
            await db.payment.updateMany({
              where: { id: { in: rows.map((r) => r.id) } },
              data: { email: null },
            })
          ).count,
      }),
  },
  {
    scope: "Startup.email + unsubToken",
    note: "the listing's notification address, and a fresh unsubscribe token so any link already sent stops working",
    requires: "email",
    windowed: false,
    run: (db, ctx, apply) =>
      sweep(apply, {
        find: async () => ({
          rows: await db.startup.findMany({ where: { email: addressEq(ctx.email) }, select: { id: true } }),
          kept: 0,
        }),
        // Per row, because the replacement token has to be unique.
        scrub: async (rows) => {
          for (const row of rows) {
            await db.startup.update({
              where: { id: row.id },
              data: { email: null, unsubToken: randomUUID() },
            });
          }
          return rows.length;
        },
      }),
  },
  {
    scope: "WaitlistEntry.email",
    note: "the waitlist row — its address is replaced with a per-row marker, so the consent record survives without the person in it",
    requires: "email",
    windowed: false,
    run: (db, ctx, apply) =>
      sweep(apply, {
        find: async () => ({
          rows: await db.waitlistEntry.findMany({ where: { email: addressEq(ctx.email) }, select: { id: true } }),
          kept: 0,
        }),
        scrub: async (rows) => {
          for (const row of rows) {
            await db.waitlistEntry.update({ where: { id: row.id }, data: { email: erasedValue(row.id) } });
          }
          return rows.length;
        },
      }),
  },
  {
    scope: "ManageToken.email",
    note: "the address a profile link was sent to — the token row stays, so an unused link is not silently revived later",
    requires: "email",
    windowed: false,
    run: (db, ctx, apply) =>
      sweep(apply, {
        find: async () => ({
          rows: await db.manageToken.findMany({ where: { email: addressEq(ctx.email) }, select: { id: true } }),
          kept: 0,
        }),
        scrub: async (rows) => {
          for (const row of rows) {
            await db.manageToken.update({ where: { id: row.id }, data: { email: erasedValue(row.id) } });
          }
          return rows.length;
        },
      }),
  },
  {
    scope: "EmailAddress.email + token",
    note: "the suppression record: address and unsubscribe handle replaced. Note this releases the address — a later signup from it is fresh consent, which is exactly what an erasure means for a suppression list",
    requires: "email",
    windowed: false,
    run: (db, ctx, apply) =>
      sweep(apply, {
        find: async () => ({
          rows: await db.emailAddress.findMany({ where: { email: addressEq(ctx.email) }, select: { id: true } }),
          kept: 0,
        }),
        scrub: async (rows) => {
          for (const row of rows) {
            await db.emailAddress.update({
              where: { id: row.id },
              data: { email: erasedValue(row.id), token: erasedValue(`${row.id}-t`) },
            });
          }
          return rows.length;
        },
      }),
  },
  {
    scope: "Report.ipHash + ClickEvent.ipHash",
    note: "the abuse fingerprint, in both tables that hold one — nulled in the report, marked in the click record",
    requires: "ipHash",
    windowed: false,
    run: async (db, ctx, apply) => {
      const reports = await db.report.findMany({ where: { ipHash: ctx.ipHash }, select: { id: true } });
      const clicks = await db.clickEvent.findMany({ where: { ipHash: ctx.ipHash }, select: { id: true } });
      let scrubbed = 0;
      if (apply) {
        scrubbed += (
          await db.report.updateMany({
            where: { id: { in: reports.map((r) => r.id) } },
            data: { ipHash: null },
          })
        ).count;
        scrubbed += (
          await db.clickEvent.updateMany({
            where: { id: { in: clicks.map((c) => c.id) } },
            data: { ipHash: ERASURE_MARKER },
          })
        ).count;
      }
      return { matched: reports.length + clicks.length, kept: 0, scrubbed };
    },
  },
  {
    scope: "free text (identity)",
    note: `addresses quoted inside ${nameList(IDENTITY_TEXT)} — the quoted address is replaced, the sentence around it is kept`,
    requires: "email",
    windowed: false,
    run: (db, ctx, apply) => sweepText(db, ctx, apply, IDENTITY_TEXT, false),
  },
  {
    scope: "EmailLog.to",
    note: "the delivery log's recipient — marked; the row, its template and its provider ids stay",
    requires: "email",
    windowed: true,
    run: (db, ctx, apply) =>
      sweep(apply, {
        find: async () => {
          const where = { to: addressEq(ctx.email) };
          const rows = await db.emailLog.findMany({
            where: { ...where, createdAt: { lte: ctx.cutoff } },
            select: { id: true },
          });
          return { rows, kept: await db.emailLog.count({ where: { ...where, createdAt: { gt: ctx.cutoff } } }) };
        },
        scrub: async (rows) =>
          (
            await db.emailLog.updateMany({
              where: { id: { in: rows.map((r) => r.id) } },
              data: { to: ERASURE_MARKER },
            })
          ).count,
      }),
  },
  {
    scope: "free text (records)",
    note: `addresses quoted inside ${nameList(RECORD_TEXT)} — audit detail included`,
    requires: "email",
    windowed: true,
    run: (db, ctx, apply) => sweepText(db, ctx, apply, RECORD_TEXT, true),
  },
  {
    scope: "ProviderEvent.payload",
    note: "the provider's own copy of the delivery — rewritten wherever the address appears inside the JSON",
    requires: "email",
    windowed: true,
    run: (db, ctx, apply) =>
      sweepJson<{ id: string; payload: unknown }>(db, ctx, apply, {
        table: "ProviderEvent",
        windowed: true,
        find: (ids) => db.providerEvent.findMany({ where: { id: { in: ids } }, select: { id: true, payload: true } }),
        write: async (row, regex) => {
          const next = scrubJson(row.payload, regex);
          if (!next.changed) return 0;
          await db.providerEvent.update({
            where: { id: row.id },
            data: { payload: next.value as Prisma.InputJsonValue },
          });
          return 1;
        },
      }),
  },
  {
    scope: "OutboxEvent.payload (not sent yet)",
    note: "a queued send naming the subject is cancelled, not merely scrubbed: payload rewritten and the row closed, so the worker cannot mail a marker (R12-4 — never windowed)",
    requires: "email",
    windowed: false,
    run: (db, ctx, apply) =>
      sweepJson<{ id: string; payload: unknown }>(db, ctx, apply, {
        table: "OutboxEvent",
        windowed: false,
        extra: Prisma.sql` AND ${Prisma.raw(quote("completedAt"))} IS NULL`,
        find: (ids) => db.outboxEvent.findMany({ where: { id: { in: ids } }, select: { id: true, payload: true } }),
        write: async (row, regex) => {
          const next = scrubJson(row.payload, regex);
          await db.outboxEvent.update({
            where: { id: row.id },
            data: {
              payload: next.value as Prisma.InputJsonValue,
              completedAt: new Date(),
              lastError: "subject-erased (R12-4): send cancelled by a data-subject request",
            },
          });
          return 1;
        },
      }),
  },
  {
    scope: "OutboxEvent.payload (sent)",
    note: "the queue's completed rows — payload and last provider error rewritten",
    requires: "email",
    windowed: true,
    run: (db, ctx, apply) =>
      sweepJson<{ id: string; payload: unknown; lastError: string | null }>(db, ctx, apply, {
        table: "OutboxEvent",
        windowed: true,
        extra: Prisma.sql` AND ${Prisma.raw(quote("completedAt"))} IS NOT NULL`,
        find: (ids) =>
          db.outboxEvent.findMany({ where: { id: { in: ids } }, select: { id: true, payload: true, lastError: true } }),
        write: async (row, regex) => {
          const next = scrubJson(row.payload, regex);
          const error = row.lastError === null ? null : (scrubJson(row.lastError, regex).value as string);
          if (!next.changed && error === row.lastError) return 0;
          await db.outboxEvent.update({
            where: { id: row.id },
            data: { payload: next.value as Prisma.InputJsonValue, lastError: error },
          });
          return 1;
        },
      }),
  },
];

/** What a data-subject request covers, in report order — cited by the runbook,
 *  so the list lives where the sweep does rather than in prose that can drift. */
export const ERASURE_SCOPES: readonly string[] = SCOPES.map((s) => s.scope);

function prepare(request: ErasureRequest): { email: string | null; ipHash: string | null; ctx: Ctx } {
  const email = request.email ? normalizeRecipient(request.email) : null;
  const ipHash = request.ipHash?.trim() || null;
  if (!email && !ipHash) {
    throw new Error("erasure: a subject needs an email address, an ip hash, or both");
  }
  if (!Number.isInteger(request.days) || request.days < 0) {
    throw new Error(`erasure: days must be a whole number of days or more (got ${request.days})`);
  }
  const cutoff = new Date(Date.now() - request.days * 86_400_000);
  return { email, ipHash, ctx: { email: email ?? "", ipHash: ipHash ?? "", cutoff } };
}

async function build(db: Db, subject: { email: string | null; ipHash: string | null }, ctx: Ctx, apply: boolean, days: number): Promise<ErasureReport> {
  const scopes: ErasureScopeReport[] = [];
  for (const scope of SCOPES) {
    const missing = scope.requires === "email" ? !subject.email : !subject.ipHash;
    if (missing) {
      scopes.push({
        scope: scope.scope,
        note: scope.note,
        windowed: scope.windowed,
        matched: 0,
        kept: 0,
        scrubbed: 0,
        skipped: `no ${scope.requires === "email" ? "email address" : "ip hash"} supplied`,
      });
      continue;
    }
    const counts = await scope.run(db, ctx, apply);
    scopes.push({ scope: scope.scope, note: scope.note, windowed: scope.windowed, ...counts });
  }
  const totals = scopes.reduce(
    (sum, s) => ({ matched: sum.matched + s.matched, kept: sum.kept + s.kept, scrubbed: sum.scrubbed + s.scrubbed }),
    { matched: 0, kept: 0, scrubbed: 0 }
  );
  return {
    applied: apply,
    subject: { email: subject.email, ipHash: subject.ipHash },
    window: { days, cutoff: ctx.cutoff.toISOString() },
    scopes,
    totals,
  };
}

/** The plan: the identical scan the erase will run, with nothing written. */
export async function previewErasure(request: ErasureRequest): Promise<ErasureReport> {
  const { email, ipHash, ctx } = prepare(request);
  return prisma.$transaction((db) => build(db, { email, ipHash }, ctx, false, request.days), TX);
}

/** The erase. `confirm: true` is part of the type, so no code path can reach a
 *  write by forgetting a flag; the runtime check stays for JS callers, and the
 *  only shipped caller is `scripts/erase-subject.ts` behind `--confirm`. */
export async function eraseSubject(request: ErasureRequest & { confirm: true }): Promise<ErasureReport> {
  if (request.confirm !== true) throw new Error("erasure: refusing to run without an explicit confirmation");
  const { email, ipHash, ctx } = prepare(request);
  return prisma.$transaction(async (db) => {
    const report = await build(db, { email, ipHash }, ctx, true, request.days);
    // The run is recorded whether or not it found anything: the audit row is the
    // evidence a request was served. It carries counts and the cutoff, never the
    // address — a trail that names the subject would defeat the exercise.
    await audit(
      {
        action: "SUBJECT_ERASED",
        actorType: "operator",
        actorRef: "scripts/erase-subject.ts",
        detail: summary(report),
      },
      db
    );
    return report;
  }, TX);
}

/** The one-line record of a run, for the audit row and the CLI. */
export function summary(report: ErasureReport): string {
  const skipped = report.scopes.filter((s) => s.skipped).length;
  return (
    `subject-erased scopes=${report.scopes.length - skipped}` +
    ` scrubbed=${report.totals.scrubbed} matched=${report.totals.matched}` +
    ` kept=${report.totals.kept} window=${report.window.days}d` +
    ` cutoff=${report.window.cutoff}`
  );
}
