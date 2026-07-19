import { afterEach, describe, expect, it } from "vitest";
import { TEST_PRIVATE_KEY_PEM } from "./helpers/testKey.js";

const BASE_ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "",
  WEBHOOK_SECRET: "secret",
  DATABASE_URL: "postgres://u:p@localhost/db",
};

describe("loadConfig agent provider", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("accepts AGENT_PROVIDER=cursor when CURSOR_API_KEY is set", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      AGENT_PROVIDER: "cursor",
      PI_MODEL: "composer-2.5",
      CURSOR_API_KEY: "cursor_test_key",
    };
    const { loadConfig } = await import("../src/config.js");
    const cfg = await loadConfig();
    expect(cfg.agentProvider).toBe("cursor");
    expect(cfg.cursorApiKey).toBe("cursor_test_key");
  });

  it("defers PI_MODEL validation until worker boot", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      AGENT_PROVIDER: "cursor",
      PI_MODEL: "not-a-real-model",
      CURSOR_API_KEY: "cursor_test_key",
    };
    const { loadConfig } = await import("../src/config.js");
    await expect(loadConfig()).resolves.toBeDefined();
  });

  it("rejects AGENT_PROVIDER=cursor without CURSOR_API_KEY", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      AGENT_PROVIDER: "cursor",
      CURSOR_API_KEY: "",
    };
    const { loadConfig } = await import("../src/config.js");
    await expect(loadConfig()).rejects.toThrow(/CURSOR_API_KEY/);
  });

  it("rejects legacy PI_PROVIDER=cursor", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      PI_PROVIDER: "cursor",
      CURSOR_API_KEY: "cursor_test_key",
    };
    const { loadConfig } = await import("../src/config.js");
    await expect(loadConfig()).rejects.toThrow(/AGENT_PROVIDER=cursor/);
  });

  it("loads model provider keys without requiring them", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      OPENAI_API_KEY: "openai_test_key",
    };
    const { loadConfig } = await import("../src/config.js");
    const cfg = await loadConfig();
    expect(cfg.agentProvider).toBe("pi");
    expect(cfg.modelProviderKeys.openai).toBe("openai_test_key");
    expect(cfg.modelProviderKeys.anthropic).toBe("");
  });
});
