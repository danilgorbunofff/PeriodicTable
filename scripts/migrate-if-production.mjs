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
const { command, args, options } = prismaCommand("migrate", "deploy");
const result = spawnSync(command, args, { stdio: "inherit", ...options });

if (result.error) {
  console.error(`[migrate] failed to run prisma: ${result.error.message}`);
  process.exit(1);
}

// A failed migration must fail the build: the alternative is deploying code whose
// schema was never applied.
process.exit(result.status ?? 1);
