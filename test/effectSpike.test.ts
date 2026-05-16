import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { loadConfig } from "../src/config.js";
import { buildEffectWebhookApp } from "../src/effect/server.js";

function testPrivateKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

describe("effect migration phase-0 compatibility", () => {
  it("enforces pinned effect dependency versions", () => {
    const result = spawnSync("node", ["scripts/check-effect-versions.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });

  it("builds the effect webhook app from real config", () => {
    process.env.PORT = "7224";
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_PRIVATE_KEY = testPrivateKeyPem();
    process.env.WEBHOOK_SECRET = "secret";
    process.env.PI_PROVIDER = "openai";
    process.env.PI_MODEL = "gpt-4o-mini";
    process.env.MAX_TOOL_ROUNDS = "24";
    process.env.MAX_FINALIZE_ROUNDS = "6";
    process.env.LOG_LEVEL = "error";

    const cfg = loadConfig();
    const app = buildEffectWebhookApp(cfg);

    expect(app).toBeTruthy();
  });
});
