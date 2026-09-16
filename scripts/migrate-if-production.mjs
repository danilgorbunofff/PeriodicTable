// Applies pending migrations during a Vercel *production* build, and only then.
//
// The deploy build is `package.json`'s `build` script (the Vercel project has no
// `buildCommand` override). `DATABASE_URL` is scoped Production *and* Preview and
// points at the same Neon database, so an unguarded `migrate deploy` in the build
// would let a preview of an unmerged branch migrate prod. `VERCEL_ENV` is what
// separates the two: it is "production" for the production deployment and
// "preview" for every branch deployment.
//
// Non-Vercel builds (local, CI) skip this entirely and keep migrating explicitly.
// A Vercel build with no VERCEL_ENV at all refuses instead of skipping: that state
// is indistinguishable from prod, and a skipped migration would surface later.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Spawn the CLI through `node` rather than the `prisma`/`npx` shim: on Windows those
// are `.cmd` files, which Node 20.12+ refuses to spawn without a shell (EINVAL).
function prismaCommand(...args) {
  const cli = resolvePrismaCli();
  if (cli) return { command: process.execPath, args: [cli, ...args], options: {} };
  return { command: "npx", args: ["prisma", ...args], options: { shell: process.platform === "win32" } };
}

function resolvePrismaCli() {
  try {
    return createRequire(import.meta.url).resolve("prisma/build/index.js");
  } catch {
    const local = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "node_modules",
      "prisma",
      "build",
      "index.js",
    );
    return existsSync(local) ? local : null;
  }
}

const env = process.env.VERCEL_ENV;

// A Vercel build always has VERCEL_ENV set. If it is missing we cannot tell prod
// from preview, and the safe reading of "cannot tell" is to refuse rather than skip
// silently — a skipped migration would only surface later, at the worst moment.
if (process.env.VERCEL === "1" && !env) {
  console.error("[migrate] VERCEL=1 but VERCEL_ENV is unset — refusing to build");
  process.exit(1);
}

if (env !== "production") {
  console.log(`[migrate] skipped (VERCEL_ENV=${env ?? "unset"})`);
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  console.error("[migrate] VERCEL_ENV=production but DATABASE_URL is unset — refusing to build");
  process.exit(1);
}

console.log("[migrate] VERCEL_ENV=production — applying pending migrations");

// 2026-09-16: a production build failed here with P1002 — "the database server
// was reached but timed out" — on a database that had gone idle (Neon suspends
// the compute, and the next connection pays for the wake). The migration was
// never the problem; the deploy just never happened. So the *connection* class
// is retried, and nothing else is: a retried schema error only fails slower, and
// every attempt still exits non-zero on a real one.
const CONNECT_FAILURE = /\bP1001\b|\bP1002\b|\bP1017\b|ECONNRESET|ETIMEDOUT|Connection terminated/i;
const BACKOFF_MS = [5_000, 15_000];

for (let attempt = 1; ; attempt += 1) {
  const { command, args, options } = prismaCommand("migrate", "deploy");
  // Piped rather than inherited so the retry decision can read the output. It is
  // printed either way, so the build log shows what it always showed.
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (output) process.stdout.write(output);

  if (result.error) {
    console.error(`[migrate] failed to run prisma: ${result.error.message}`);
    process.exit(1);
  }

  const status = result.status ?? 1;
  if (status === 0) process.exit(0);

  if (!CONNECT_FAILURE.test(output) || attempt > BACKOFF_MS.length) {
    // A failed migration must fail the build: the alternative is deploying code
    // whose schema was never applied.
    console.error(`[migrate] prisma migrate deploy exited ${status} on attempt ${attempt} — failing the build`);
    process.exit(status);
  }

  const wait = BACKOFF_MS[attempt - 1];
  console.log(`[migrate] could not reach the database on attempt ${attempt} — retrying in ${wait / 1000}s`);
  await new Promise((resolve) => setTimeout(resolve, wait));
}
