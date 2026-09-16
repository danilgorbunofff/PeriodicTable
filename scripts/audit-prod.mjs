#!/usr/bin/env node
/**
 * Phase 0 gate: production dependency audit.
 *
 * Runs `npm audit --omit=dev --json` and fails on any high/critical finding
 * whose package is NOT listed in ops/accepted-advisories.json. Accepted
 * entries require a reason + expiry; expired entries fail the gate.
 *
 * An accepted entry may also carry `tripwires`: repo conditions that must
 * still hold for the acceptance to be valid (R20-1). They are checked on
 * every run, so an acceptance cannot quietly survive the change that voids it.
 *
 * Usage: npm run audit:prod
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const allowlist = JSON.parse(readFileSync(join(root, "ops", "accepted-advisories.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const installed = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...((pkg.overrides ?? {})) };
const today = new Date().toISOString().slice(0, 10);

/**
 * A source file with its comments removed: block comments, and `//` runs that
 * are not part of a URL. Every tripwire matches against this, so an acceptance
 * that says "this config key is absent" stays checkable in a file that talks
 * about the key in prose (R20-1).
 */
function withoutComments(file) {
  return readFileSync(join(root, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * R20-1's mechanical half: a tripwire is a condition that must still hold for
 * an acceptance to be valid, re-checked on every run instead of remembered.
 * Each entry names a repo file and a substring that must NOT appear in it;
 * anything missing — the file, a field, the substring found where it must not
 * be — fails the gate rather than warning.
 */
function checkTripwires() {
  for (const a of allowlist.accepted ?? []) {
    const tripwires = a.tripwires ?? [];
    if (!Array.isArray(tripwires)) {
      console.error(`audit:prod: ${a.package}'s tripwires is not an array — failing closed.`);
      process.exit(1);
    }
    for (const t of tripwires) {
      if (!t.file || !t.must_not_contain || !t.because) {
        console.error(`audit:prod: a tripwire on ${a.package} is missing file/must_not_contain/because — failing closed.`);
        process.exit(1);
      }
      let body;
      try {
        body = withoutComments(t.file);
      } catch {
        console.error(`audit:prod: ${a.package}'s tripwire names ${t.file}, which cannot be read — failing closed.`);
        process.exit(1);
      }
      if (body.toLowerCase().includes(t.must_not_contain.toLowerCase())) {
        console.error(
          `audit:prod: ${a.package} acceptance is void — ${t.file} now contains "${t.must_not_contain}".\n` +
            `  ${t.because}`,
        );
        process.exit(1);
      }
    }
  }
}

for (const a of allowlist.accepted ?? []) {
  if (!a.reason) {
    console.error(`audit:prod: accepted entry for ${a.package} has no reason — failing closed.`);
    process.exit(1);
  }
  if (a.expires && a.expires < today) {
    console.error(`audit:prod: accepted entry for ${a.package} expired on ${a.expires} — re-assess.`);
    process.exit(1);
  }
}

checkTripwires();

let audit;
try {
  // Single-string form on purpose: npm is a batch shim on Windows, which
  // CreateProcess cannot launch directly (execFileSync -> EINVAL), and the
  // args+shell workaround is deprecated in Node 22 (DEP0190) because those
  // args are concatenated unescaped. A fixed literal through the shell is
  // the one form that behaves identically on both platforms.
  const out = execSync("npm audit --omit=dev --json", { cwd: root, encoding: "utf8" });
  audit = JSON.parse(out);
} catch (e) {
  // npm exits non-zero when vulnerabilities are found; stdout still has JSON.
  const out = e.stdout?.toString() ?? "";
  try {
    audit = JSON.parse(out);
  } catch {
    console.error("audit:prod: could not parse npm audit output.");
    process.exit(1);
  }
}

const vulns = audit.vulnerabilities ?? audit.advisories ?? {};
const unaccepted = [];
for (const [name, v] of Object.entries(vulns)) {
  const sev = v.severity ?? "";
  if (sev !== "high" && sev !== "critical") continue;
  // Match package AND pinned version when the allowlist pins one: a future
  // major (e.g. next@15 with a new high) must not be auto-accepted by a
  // stale next@14 entry. The pinned version must equal the installed version.
  const ok = (allowlist.accepted ?? []).some((a) => {
    if (a.package !== name) return false;
    if (a.version) {
      const inst = (installed[name] ?? "").replace(/^[\^~>=<\s$]+/, "").split(" ")[0];
      if (inst && inst !== a.version && !inst.includes(a.version)) return false;
    }
    return true;
  });
  if (!ok) unaccepted.push(`${name}@${v.range ?? v.version ?? "?"} (${sev})`);
}

if (unaccepted.length > 0) {
  console.error(`audit:prod: unaccepted high/critical runtime advisories:\n- ${unaccepted.join("\n- ")}`);
  process.exit(1);
}
console.log("audit:prod: no unaccepted high/critical runtime advisories.");
