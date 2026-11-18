import { defineConfig } from "vitest/config";
import { integrationWorkerCount } from "./test/integration/workerDatabases.ts";

export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: true,
    maxWorkers: integrationWorkerCount,
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/globalSetup.ts"],
    setupFiles: ["test/integration/selectWorkerDatabase.ts", "test/setup/evlog.ts"],
    hookTimeout: 90_000,
    testTimeout: 90_000,
  },
});
