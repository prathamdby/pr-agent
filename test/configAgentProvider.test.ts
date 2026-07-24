import { afterEach, describe, expect, it } from "vitest";
import { isAppError } from "../src/errors/appError.js";
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

  it("rejects AGENT_PROVIDER=cursor as an invalid enum value", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      AGENT_PROVIDER: "cursor",
    };
    const { loadConfig } = await import("../src/config.js");
    await expect(loadConfig()).rejects.toSatisfy((error: unknown) => {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return false;
      expect(error.code).toBe("config.invalid_enum");
      expect(error.message).toBe("AGENT_PROVIDER must be one of pi");
      return true;
    });
  });

  it("rejects PI_PROVIDER=cursor as an unknown provider", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      PI_PROVIDER: "cursor",
    };
    const { loadConfig } = await import("../src/config.js");
    await expect(loadConfig()).rejects.toSatisfy((error: unknown) => {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return false;
      expect(error.code).toMatch(/^settings\.models_json_unknown_provider/);
      expect(error.message).toMatch(/PI_PROVIDER "cursor" is unknown/);
      return true;
    });
  });

  it("does not reinterpret CURSOR_API_KEY as a Pi credential", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      AGENT_PROVIDER: "pi",
      CURSOR_API_KEY: "cursor_should_not_become_openai",
      OPENAI_API_KEY: "openai_test_key",
    };
    const { loadConfig } = await import("../src/config.js");
    const cfg = await loadConfig();
    expect(cfg.agentProvider).toBe("pi");
    expect(cfg.modelProviderKeys.openai).toBe("openai_test_key");
    expect(cfg.modelProviderKeys.openai).not.toBe("cursor_should_not_become_openai");
    expect(cfg).not.toHaveProperty("cursorApiKey");
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
