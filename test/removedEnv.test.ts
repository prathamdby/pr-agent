import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOVED_ENV, assertNoRemovedEnv } from "../src/settings/index.js";
import { TEST_PRIVATE_KEY_PEM } from "./helpers/testKey.js";

describe("removed env guard", () => {
  it("passes when no removed vars are set", () => {
    expect(() => assertNoRemovedEnv({ PORT: "7224", FEATURE_ASK: "manual" })).not.toThrow();
  });

  it("throws naming every removed var and its replacement", () => {
    expect(() =>
      assertNoRemovedEnv({
        ENABLE_REVIEW_COMMIT_STATUS: "true",
        MAX_TOOL_ROUNDS: "24",
      }),
    ).toThrow(
      /ENABLE_REVIEW_COMMIT_STATUS.*FEATURE_COMMIT_STATUS[\s\S]*MAX_TOOL_ROUNDS.*hardcoded/,
    );
  });

  it("treats an empty-string value as set (refuses start)", () => {
    expect(() => assertNoRemovedEnv({ MAX_TOOL_ROUNDS: "" })).toThrow(/MAX_TOOL_ROUNDS/);
  });

  it("covers all replaced flag and auto-action vars", () => {
    for (const key of [
      "ENABLE_REVIEW_LABELS_EFFORT",
      "ENABLE_REVIEW_LABELS_SECURITY",
      "ENABLE_REVIEW_COMMIT_STATUS",
      "DESCRIPTION_GENERATE_TITLE",
      "REVIEW_AUTO_ACTIONS",
      "DESCRIPTION_AUTO_ACTIONS",
      "VERIFICATION_AUTO_ACTIONS",
      "REVIEW_INJECT_ANCHOR_MENU",
      "REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT",
      "LOCAL_WORKSPACE_CLONE_TIMEOUT_MS",
    ]) {
      expect(REMOVED_ENV[key], `missing ${key}`).toBeTruthy();
    }
  });

  it("makes loadConfig refuse to start when a removed var is set", async () => {
    const saved = { ...process.env };
    process.env = {
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      WEBHOOK_SECRET: "secret",
      DATABASE_URL: "postgres://u:p@localhost/db",
      ENABLE_REVIEW_COMMIT_STATUS: "true",
    } as NodeJS.ProcessEnv;
    try {
      const { loadConfig } = await import("../src/config.js");
      await expect(loadConfig()).rejects.toThrow(/removed environment variables/);
    } finally {
      process.env = { ...saved };
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
