import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup/evlog.ts", "test/setup/cursor-sdk-mock.ts"],
  },
});
