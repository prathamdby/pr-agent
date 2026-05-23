import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

function testPrivateKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

const BASE_ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "",
  WEBHOOK_SECRET: "secret",
  DATABASE_URL: "postgres://u:p@localhost/db",
};

describe("loadConfig cursor provider", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("accepts PI_PROVIDER=cursor when CURSOR_API_KEY is set", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem(),
      PI_PROVIDER: "cursor",
      CURSOR_API_KEY: "cursor_test_key",
    };
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.piProvider).toBe("cursor");
    expect(cfg.cursorApiKey).toBe("cursor_test_key");
  });

  it("rejects PI_PROVIDER=cursor without CURSOR_API_KEY", async () => {
    process.env = {
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem(),
      PI_PROVIDER: "cursor",
      CURSOR_API_KEY: "",
    };
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig()).toThrow(/CURSOR_API_KEY/);
  });
});
