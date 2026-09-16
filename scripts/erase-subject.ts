/** Data-subject erasure (R12-4): serve a "delete my data" request.
 *
 *  The routine is `lib/erasure.ts`; this file is the operator's handle on it.
 *  Nothing is deleted — `Payment.startupId`/`elementId` are ON DELETE RESTRICT
 *  (12 §5.7), and the ledger has to keep adding up — so the sweep scrubs every
 *  column that holds the person and keeps every row and id.
 *
 *  Dry run by default: the preview runs the identical scan the erase runs, so
 *  the printed plan is the plan. `--confirm` is what makes it write, and a
 *  non-local host needs `--allow-remote` on top (the runbook's `17` step).
 *
 *  The retention window is not this script's opinion: `--days` is required, and
 *  `--days 0` means "hold nothing back". The policy belongs to `16`; the runbook
 *  to `17`. Rows the window kept are printed and exit non-zero, so a partial
 *  erasure can never read as a finished one.
 *
 *  Usage:
 *    npm run db:erase-subject -- --email someone@example.com --days 30            # plan only
 *    npm run db:erase-subject -- --email someone@example.com --days 30 --confirm  # write
 *    npm run db:erase-subject -- --ip-hash 9f2… --days 0 --confirm --allow-kept
 *  Flags:
 *    --email <address>   the subject's address (matched case-insensitively)
 *    --ip-hash <hash>    the subject's `Report.ipHash`/`ClickEvent.ipHash`, for a
 *                        subject who never supplied an address
 *    --days <n>          retention window in whole days; 0 erases every record
 *    --confirm           write (default: print the plan, write nothing)
 *    --allow-remote      required with --confirm for a non-local host
 *    --allow-kept        exit 0 even when the window held rows back
 *    --json              print the report as JSON (the plan, or the run)
 */
import { prisma } from "../lib/prisma";
import { ERASURE_SCOPES, eraseSubject, previewErasure, type ErasureReport } from "../lib/erasure";

const argv = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

const EMAIL = flagValue("--email");
const IP_HASH = flagValue("--ip-hash");
const DAYS_RAW = flagValue("--days");
const CONFIRM = argv.includes("--confirm");
const ALLOW_REMOTE = argv.includes("--allow-remote");
const ALLOW_KEPT = argv.includes("--allow-kept");
const JSON_OUT = argv.includes("--json");

const isLocal = (url: string) => /(localhost|127\.0\.0\.1)/.test(url);

function die(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

/** The report as an operator reads it: one line per scope, and the ones the
 *  window held back marked, because that is the number that decides the exit. */
function printReport(report: ErasureReport, host: string, mode: string) {
  console.log(`\ntarget: ${host}`);
  console.log(`mode:   ${mode}`);
  console.log(
    `subject: ${report.subject.email ? `email=${report.subject.email}` : ""}` +
      `${report.subject.email && report.subject.ipHash ? " " : ""}` +
      `${report.subject.ipHash ? `ip-hash=${report.subject.ipHash}` : ""}`
  );
  console.log(`window: ${report.window.days} day(s), cutoff ${report.window.cutoff}\n`);

  const width = Math.max(...report.scopes.map((s) => s.scope.length), "scope".length);
  console.log(`${"scope".padEnd(width)}  matched  kept  scrubbed`);
  for (const s of report.scopes) {
    const marks = s.skipped ? `  (skipped: ${s.skipped})` : s.kept > 0 ? "  (window held rows back)" : "";
    console.log(
      `${s.scope.padEnd(width)}  ${String(s.matched).padStart(7)}  ${String(s.kept).padStart(4)}  ` +
        `${String(s.scrubbed).padStart(8)}${marks}`
    );
  }
  const { matched, kept, scrubbed } = report.totals;
  console.log(`${"total".padEnd(width)}  ${String(matched).padStart(7)}  ${String(kept).padStart(4)}  ${String(scrubbed).padStart(8)}`);
  // The scopes a request has to cover are the ones that did nothing only when
  // they were asked to; a skipped scope is a gap in the answer, so name it.
  const skipped = report.scopes.filter((s) => s.skipped);
  if (skipped.length > 0) {
    console.log(`\n! not swept (no subject half to match on): ${skipped.map((s) => s.scope).join(", ")}`);
  }
}

async function main() {
  if (argv.includes("--help") || argv.length === 0) {
    console.log(
      `usage: npm run db:erase-subject -- --email <address> [--ip-hash <hash>] --days <n> [--confirm]\n` +
        `  --days is required: 0 erases every matching record, N keeps the last N days (dry run by default)\n` +
        `  scopes swept: ${ERASURE_SCOPES.join(", ")}`
    );
    return;
  }

  const url = process.env.DATABASE_URL ?? "";
  if (!url) die("DATABASE_URL is not set (use: npm run db:erase-subject)");

  let host = "(unparseable url)";
  try {
    host = new URL(url).host || host;
  } catch {
    /* keep placeholder — the guard below still applies */
  }

  if (!EMAIL && !IP_HASH) die("a subject needs --email, --ip-hash, or both");
  if (DAYS_RAW === undefined) {
    die("--days is required: this script will not guess a retention window (0 = hold nothing back)");
  }
  const days = Number(DAYS_RAW);
  if (!Number.isInteger(days) || days < 0) die(`--days must be a whole number of days (got ${DAYS_RAW})`);
  if (CONFIRM && !isLocal(url) && !ALLOW_REMOTE) {
    die(`refusing to write to a non-local database (${host}) without --allow-remote`);
  }

  const request = { email: EMAIL, ipHash: IP_HASH, days };

  if (!CONFIRM) {
    const plan = await previewErasure(request);
    if (JSON_OUT) console.log(JSON.stringify(plan, null, 2));
    else printReport(plan, host, "DRY RUN (nothing written)");
    reportExit(plan, days, false);
    return;
  }

  // The plan first, then the run: the operator sees the same numbers twice when
  // nothing changed between them, which is the point of previewing at all.
  const plan = await previewErasure(request);
  if (JSON_OUT) console.log(JSON.stringify(plan, null, 2));
  else printReport(plan, host, "PLAN (previewed before writing)");

  const run = await eraseSubject({ ...request, confirm: true });
  if (JSON_OUT) console.log(JSON.stringify(run, null, 2));
  else printReport(run, host, "APPLIED");

  // Verification, on the public surface rather than on the report's own word:
  // a second scan must find no row the sweep would still have to touch. Only
  // `matched` is the check — `kept` is the window itself, and a non-zero window
  // reports it again here by design.
  const after = await previewErasure(request);
  if (!JSON_OUT) {
    console.log(`\nverify: re-scan finds matched=${after.totals.matched} kept=${after.totals.kept}`);
  }
  if (after.totals.matched !== 0) {
    die(`the re-scan still finds ${after.totals.matched} row(s) for this subject — investigate before announcing.`);
  }
  reportExit(run, days, true);
}

/** A run that left rows behind is not a finished erasure. */
function reportExit(report: ErasureReport, days: number, applied: boolean): never | void {
  const kept = report.totals.kept;
  if (kept === 0) {
    if (!JSON_OUT) {
      console.log(
        applied
          ? `\ndone: ${report.totals.scrubbed} row(s) scrubbed across ${report.scopes.filter((s) => !s.skipped).length} scope(s).\n`
          : `\nnothing written. to execute:\n  npm run db:erase-subject -- ${argv.join(" ")} --confirm\n`
      );
    }
    return;
  }
  const line =
    `${report.totals.kept} row(s) inside the ${days}-day window are still holding this address ` +
    `(cutoff ${report.window.cutoff}). Re-run once the window closes, or re-run with a smaller --days, ` +
    `or pass --allow-kept to accept the remainder deliberately.`;
  if (ALLOW_KEPT) {
    if (!JSON_OUT) console.log(`\n! ${line}`);
    return;
  }
  die(line);
}

main()
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
