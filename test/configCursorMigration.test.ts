import { afterEach, describe, expect, it } from "vitest";
import { isAppError } from "../src/errors/appError.js";
import { TEST_PRIVATE_KEY_PEM } from "./helpers/testKey.js";

const BASE_ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "",
  WEBHOOK_SECRET: "secret",
  DATABASE_URL: "postgres://u:p@localhost/db",
};

describe("loadConfig Cursor migration guard", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("rejects AGENT_PROVIDER=cursor with migration guidance", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      AGENT_PROVIDER: "cursor",
      PI_MODEL: "composer-2.5",
      CURSOR_API_KEY: "cursor_test_key",
    };
    const { loadConfig } = await import("../src/config.js");
    await expect(loadConfig()).rejects.toSatisfy((error: unknown) => {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return false;
      expect(error.code).toBe("config.cursor_provider_removed");
      expect(error.message).toContain("AGENT_PROVIDER=cursor");
      expect(error.message).toContain("PI_PROVIDER");
      expect(error.message).toContain("PI_MODEL");
      expect(error.message).toContain("PI_ORCHESTRATOR");
      expect(error.message).toContain("PI_FALLBACK");
      expect(error.message).toMatch(/models\.json|catalog/i);
      expect(error.message).toMatch(/not reinterpreted/i);
      return true;
    });
  });

  it("does not require CURSOR_API_KEY when rejecting cursor provider", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      AGENT_PROVIDER: "cursor",
      CURSOR_API_KEY: "",
    };
    const { loadConfig } = await import("../src/config.js");
    await expect(loadConfig()).rejects.toThrow(/AGENT_PROVIDER=cursor is no longer supported/);
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
    expect(cfg.cursorApiKey).toBe("cursor_should_not_become_openai");
    expect(cfg.modelProviderKeys.openai).toBe("openai_test_key");
    expect(cfg.modelProviderKeys.openai).not.toBe(cfg.cursorApiKey);
  });

  it("rejects legacy PI_PROVIDER=cursor with Pi migration guidance", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      PI_PROVIDER: "cursor",
      CURSOR_API_KEY: "cursor_test_key",
    };
    const { loadConfig } = await import("../src/config.js");
    await expect(loadConfig()).rejects.toSatisfy((error: unknown) => {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return false;
      expect(error.code).toBe("settings.models_json_cursor_provider_removed");
      expect(error.message).toContain("PI_PROVIDER=cursor");
      expect(error.message).toContain("AGENT_PROVIDER=cursor has been removed");
      return true;
    });
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
