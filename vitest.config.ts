import { configDefaults, defineConfig } from "vitest/config";

const isCI = process.env.CI === "true" || process.env.CI === "1";

export default defineConfig({
  test: {
    pool: "forks",
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/integration/**"],
    setupFiles: [
      "test/setup/evlog.ts",
      "test/setup/ciStatus-mock.ts",
      "test/setup/operationIntent-memory.ts",
    ],
    // Retries only in CI so flakes remain visible in the JSON report (C6/C7).
    retry: isCI ? 2 : 0,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "**/node_modules/**", "dist/**"],
      // Thresholds = measured baseline (2026-08-02) − 5% (ratchet in docs/development.md).
      // Baseline: lines 82.71, statements 80.76, functions 79.16, branches 72.08.
      thresholds: {
        lines: 77.71,
        statements: 75.76,
        functions: 74.16,
        branches: 67.08,
      },
    },
  },
});
