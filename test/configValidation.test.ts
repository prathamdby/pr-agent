import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GITHUB_PULL_REQUEST_FILES_API_MAX_FILES } from "../src/settings/index.js";

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
    vi.restoreAllMocks();
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
    expect(cfg.reviewMinConfidence).toBe(1);
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

  it("parses review min confidence", async () => {
    const cfg = await load({ REVIEW_MIN_CONFIDENCE: "3" });
    expect(cfg.reviewMinConfidence).toBe(3);
  });

  it("rejects review min confidence outside the finding confidence range", async () => {
    await expect(load({ REVIEW_MIN_CONFIDENCE: "0" })).rejects.toThrow(
      /REVIEW_MIN_CONFIDENCE must be an integer from 1 to 5/,
    );
    await expect(load({ REVIEW_MIN_CONFIDENCE: "6" })).rejects.toThrow(
      /REVIEW_MIN_CONFIDENCE must be an integer from 1 to 5/,
    );
    await expect(load({ REVIEW_MIN_CONFIDENCE: "2.5" })).rejects.toThrow(
      /REVIEW_MIN_CONFIDENCE must be an integer from 1 to 5/,
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

  it("clamps max PR files listed to the GitHub API cap with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cfg = await load({ MAX_PR_FILES_LISTED: "5000" });

    expect(cfg.maxPrFilesListed).toBe(GITHUB_PULL_REQUEST_FILES_API_MAX_FILES);
    expect(warn).toHaveBeenCalledWith(
      `MAX_PR_FILES_LISTED=5000 exceeds GitHub pull request files API cap ${GITHUB_PULL_REQUEST_FILES_API_MAX_FILES}; using ${GITHUB_PULL_REQUEST_FILES_API_MAX_FILES}.`,
    );
  });

  it("keeps max PR files listed below the GitHub API cap unchanged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cfg = await load({ MAX_PR_FILES_LISTED: "2500" });

    expect(cfg.maxPrFilesListed).toBe(2500);
    expect(warn).not.toHaveBeenCalled();
  });
});
