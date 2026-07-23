import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/integration/**"],
    setupFiles: [
      "test/setup/evlog.ts",
      "test/setup/ciStatus-mock.ts",
      "test/setup/operationIntent-mock.ts",
    ],
  },
});
