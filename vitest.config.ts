import { configDefaults, defineConfig } from "vitest/config";

const setupFiles = ["test/setup/evlog.ts", "test/setup/ciStatus-mock.ts"];
const excluded = [...configDefaults.exclude, "test/integration/**"];
const slowFiles = [
  "test/agentWorkerShutdown.test.ts",
  "test/createPiSession.test.ts",
  "test/localPrWorkspace.test.ts",
  "test/workspaceToolset.test.ts",
  "test/writablePrCheckout.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          pool: "forks",
          include: ["test/**/*.test.ts"],
          exclude: [...excluded, ...slowFiles],
          setupFiles,
        },
      },
      {
        extends: true,
        test: {
          name: "slow",
          pool: "forks",
          include: slowFiles,
          setupFiles,
          testTimeout: 90_000,
          hookTimeout: 90_000,
        },
      },
    ],
  },
});
