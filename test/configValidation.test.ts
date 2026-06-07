import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

function testPrivateKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

const BASE_ENV = {
  GITHUB_APP_ID: "1",
  WEBHOOK_SECRET: "secret",
  DATABASE_URL: "postgres://u:p@localhost/db",
};

async function load(extra: Record<string, string>) {
  process.env = {
    ...BASE_ENV,
    GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem(),
    ...extra,
  } as NodeJS.ProcessEnv;
  const { loadConfig } = await import("../src/config.js");
  return loadConfig();
}

describe("loadConfig validation", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("applies documented defaults", async () => {
    const cfg = await load({});
    expect(cfg.port).toBe(3000);
    expect(cfg.maxToolRounds).toBe(24);
    expect(cfg.providerPromptTimeoutMs).toBe(300_000);
    expect(cfg.queueRetryLimit).toBe(3);
    expect(cfg.queueHeartbeatSeconds).toBe(60);
    expect(cfg.shutdownDrainTimeoutSeconds).toBe(25);
    expect(cfg.retentionEnabled).toBe(true);
    expect(cfg.logRedact).toBe(true);
    expect(cfg.role).toBe("web");
    expect(cfg.logLevel).toBe("info");
  });

  it("rejects a non-numeric positive knob", async () => {
    await expect(load({ MAX_TOOL_ROUNDS: "abc" })).rejects.toThrow(
      /MAX_TOOL_ROUNDS must be a positive number/,
    );
  });

  it("allows zero for zero-or-positive knobs", async () => {
    const cfg = await load({ QUEUE_RETRY_LIMIT: "0" });
    expect(cfg.queueRetryLimit).toBe(0);
  });

  it("rejects zero for positive-only knobs", async () => {
    await expect(load({ REVIEW_CONCURRENCY: "0" })).rejects.toThrow(
      /REVIEW_CONCURRENCY must be a positive number/,
    );
  });

  it("enforces the heartbeat floor", async () => {
    await expect(load({ QUEUE_HEARTBEAT_SECONDS: "5" })).rejects.toThrow(
      /QUEUE_HEARTBEAT_SECONDS must be at least 10/,
    );
  });

  it("parses boolean knobs by exact 'true'", async () => {
    expect((await load({ ENABLE_REVIEW_LABELS_EFFORT: "false" })).enableReviewLabelsEffort).toBe(
      false,
    );
    expect((await load({ ENABLE_REVIEW_LABELS_EFFORT: "true" })).enableReviewLabelsEffort).toBe(
      true,
    );
    expect((await load({ ENABLE_REVIEW_LABELS_EFFORT: "1" })).enableReviewLabelsEffort).toBe(false);
  });

  it("rejects an invalid enum", async () => {
    await expect(load({ ROLE: "bad" })).rejects.toThrow(/ROLE must be one of web, worker/);
  });
});
