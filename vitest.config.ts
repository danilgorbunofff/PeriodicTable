import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    // Every DB-backed file shares one test database, and the outbox is a single
    // global queue (claim order is nextAttemptAt across all rows). In parallel,
    // one file's drain claims another file's fixtures — rare, load-dependent
    // failures that say nothing about the product. Serialise instead.
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});
