import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: false,
    include: ["test/integration/**/*.test.ts"],
    setupFiles: ["test/setup/evlog.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
