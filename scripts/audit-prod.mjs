#!/usr/bin/env node
/**
 * Phase 0 gate: production dependency audit.
 *
 * Runs `npm audit --omit=dev --json` and fails on any high/critical finding
 * whose package is NOT listed in ops/accepted-advisories.json. Accepted
 * entries require a reason + expiry; expired entries fail the gate.
 *
 * Usage: npm run audit:prod
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const allowlist = JSON.parse(readFileSync(join(root, "ops", "accepted-advisories.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const installed = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...((pkg.overrides ?? {})) };
const today = new Date().toISOString().slice(0, 10);
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

let audit;
try {
  const out = execFileSync("npm", ["audit", "--omit=dev", "--json"], { cwd: root, encoding: "utf8" });
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
