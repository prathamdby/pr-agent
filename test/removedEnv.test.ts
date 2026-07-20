import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_PRIVATE_KEY_PEM } from "./helpers/testKey.js";

describe("removed env vars", () => {
  it("loadConfig ignores removed vars (no fail-fast gate)", async () => {
    const saved = { ...process.env };
    process.env = {
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      WEBHOOK_SECRET: "secret",
      DATABASE_URL: "postgres://u:p@localhost/db",
      ENABLE_REVIEW_COMMIT_STATUS: "true",
      MAX_TOOL_ROUNDS: "24",
      REVIEW_INJECT_ANCHOR_MENU: "false",
    } as NodeJS.ProcessEnv;
    try {
      const { loadConfig } = await import("../src/config.js");
      await expect(loadConfig()).resolves.toBeDefined();
    } finally {
      process.env = { ...saved };
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
