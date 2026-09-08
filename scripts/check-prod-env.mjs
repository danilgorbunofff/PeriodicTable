#!/usr/bin/env node
/**
 * Phase 0 gate: fail explicitly when production config is missing/invalid.
 *
 * Usage:
 *   node scripts/check-prod-env.mjs                 # checks current env
 *   VERCEL_ENV=production NODE_ENV=production node scripts/check-prod-env.mjs
 *
 * Exit 0 = production config valid (or not a production env, skipped).
 * Exit 1 = production env with missing/invalid required values.
 *
 * Note: imports lib/env.ts directly (Node 22.6+ strips types natively).
 * If that import ever fails, the gate fails closed via the fallback list.
 */
async function main() {
  let mod = null;
  try {
    mod = await import("../lib/env.ts");
  } catch {
    mod = null;
  }
  if (!mod) {
    const required = [
      "DATABASE_URL",
      "WHOP_API_KEY",
      "WHOP_WEBHOOK_SECRET",
      "NEXT_PUBLIC_APP_URL",
      "TURNSTILE_SECRET",
      "CLICK_SALT",
      "CRON_SECRET",
      "RESEND_API_KEY",
      "EMAIL_FROM",
    ];
    const vercel = process.env.VERCEL_ENV;
    const isProd = vercel === "production" || process.env.NODE_ENV === "production";
    if (!isProd) {
      console.log("check-prod-env: not a production env, skipping.");
      return;
    }
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      console.error(`Missing production configuration:\n- ${missing.join("\n- ")}`);
      process.exit(1);
    }
    console.log("check-prod-env: production config OK (fallback check).");
    return;
  }
  const { getAppEnv, getMissingProdEnv, isBuildPhase } = mod;
  if (getAppEnv() !== "production") {
    console.log(`check-prod-env: env=${getAppEnv()}, not production — skipping.`);
    return;
  }
  if (isBuildPhase()) {
    console.log("check-prod-env: production build phase — runtime validation deferred.");
    return;
  }
  const missing = getMissingProdEnv(process.env);
  if (missing.length > 0) {
    console.error(`Missing production configuration:\n- ${missing.join("\n- ")}`);
    process.exit(1);
  }
  console.log("check-prod-env: production config OK.");
}

await main();
