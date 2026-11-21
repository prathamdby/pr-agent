import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: true,
    include: ["test/integration/**/*.test.ts"],
    setupFiles: ["test/setup/evlog.ts"],
    hookTimeout: 90_000,
    testTimeout: 90_000,
  },
});
