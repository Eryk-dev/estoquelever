import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/globalSetup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    // vitest 4: poolOptions removed → use top-level maxWorkers=1 pra serializar contra staging
    maxWorkers: 1,
    env: { TINY_DISABLED: "true", PRINTNODE_DISABLED: "true", ML_DISABLED: "true" },
  },
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
});
