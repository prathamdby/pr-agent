import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_PRIVATE_KEY_PEM } from "./helpers/testKey.js";

const BASE_ENV = {
  GITHUB_APP_ID: "1",
  WEBHOOK_SECRET: "secret",
  DATABASE_URL: "postgres://u:p@localhost/db",
};

async function load(extra: Record<string, string>) {
  process.env = {
    ...BASE_ENV,
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    ...extra,
  } as NodeJS.ProcessEnv;
  const { loadConfig } = await import("../src/config.js");
  return loadConfig();
}

describe("loadConfig validation", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("applies documented defaults", async () => {
    const cfg = await load({});
    expect(cfg.port).toBe(3000);
    expect(cfg.providerPromptTimeoutMs).toBe(300_000);
    expect(cfg.queueRetryLimit).toBe(3);
    expect(cfg.queueHeartbeatSeconds).toBe(60);
    expect(cfg.shutdownDrainTimeoutSeconds).toBe(25);
    expect(cfg.retentionEnabled).toBe(true);
    expect(cfg.logRedact).toBe(true);
    expect(cfg.role).toBe("web");
    expect(cfg.logLevel).toBe("info");
    expect([...cfg.slashAllowedAssociations]).toEqual(["OWNER", "MEMBER", "COLLABORATOR"]);
  });

  it("rejects a non-numeric positive knob", async () => {
    await expect(load({ PROVIDER_PROMPT_TIMEOUT_MS: "abc" })).rejects.toThrow(
      /PROVIDER_PROMPT_TIMEOUT_MS must be a positive number/,
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

  it("normalizes slash command author associations", async () => {
    const cfg = await load({ SLASH_ALLOWED_ASSOCIATIONS: " owner, collaborator " });

    expect([...cfg.slashAllowedAssociations]).toEqual(["OWNER", "COLLABORATOR"]);
  });

  it("allows slash command association opt-out with star", async () => {
    const cfg = await load({ SLASH_ALLOWED_ASSOCIATIONS: "*" });

    expect([...cfg.slashAllowedAssociations]).toEqual(["*"]);
  });

  it("rejects unknown slash command author associations", async () => {
    await expect(load({ SLASH_ALLOWED_ASSOCIATIONS: "OWNER,STRANGER" })).rejects.toThrow(
      /SLASH_ALLOWED_ASSOCIATIONS must be/,
    );
  });

  it("defaults verification concurrency to 1", async () => {
    const cfg = await load({});
    expect(cfg.verificationConcurrency).toBe(1);
  });
});
