import { afterEach, describe, expect, it, vi } from "vitest";
import { GITHUB_PULL_REQUEST_FILES_API_MAX_FILES } from "../src/settings/index.js";
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
    expect([...cfg.slashAllowedAssociations]).toEqual(["OWNER", "MEMBER", "COLLABORATOR"]);
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

  it("defaults description auto actions to opened only", async () => {
    const cfg = await load({});
    expect([...cfg.descriptionAutoActions]).toEqual(["opened"]);
  });

  it("parses description auto actions from env", async () => {
    const cfg = await load({ DESCRIPTION_AUTO_ACTIONS: "opened,synchronize" });
    expect([...cfg.descriptionAutoActions]).toEqual(["opened", "synchronize"]);
  });

  it("rejects unknown description auto actions", async () => {
    await expect(load({ DESCRIPTION_AUTO_ACTIONS: "opened,labeled" })).rejects.toThrow(
      /DESCRIPTION_AUTO_ACTIONS contains unknown action/,
    );
  });

  it("normalizes description auto actions to lowercase", async () => {
    const cfg = await load({ DESCRIPTION_AUTO_ACTIONS: "Opened, SYNCHRONIZE " });
    expect([...cfg.descriptionAutoActions]).toEqual(["opened", "synchronize"]);
  });

  it("defaults review auto actions to opened only", async () => {
    const cfg = await load({});
    expect([...cfg.reviewAutoActions]).toEqual(["opened"]);
  });

  it("parses review auto actions from env", async () => {
    const cfg = await load({ REVIEW_AUTO_ACTIONS: "opened,synchronize" });
    expect([...cfg.reviewAutoActions]).toEqual(["opened", "synchronize"]);
  });

  it("rejects unknown review auto actions", async () => {
    await expect(load({ REVIEW_AUTO_ACTIONS: "opened,labeled" })).rejects.toThrow(
      /REVIEW_AUTO_ACTIONS contains unknown action/,
    );
  });

  it("normalizes review auto actions to lowercase", async () => {
    const cfg = await load({ REVIEW_AUTO_ACTIONS: "Opened, REOPENED " });
    expect([...cfg.reviewAutoActions]).toEqual(["opened", "reopened"]);
  });

  it("defaults verification auto actions to synchronize", async () => {
    const cfg = await load({});
    expect([...cfg.verificationAutoActions]).toEqual(["synchronize"]);
  });

  it("parses verification auto actions from env", async () => {
    const cfg = await load({ VERIFICATION_AUTO_ACTIONS: "synchronize,reopened" });
    expect([...cfg.verificationAutoActions]).toEqual(["synchronize", "reopened"]);
  });

  it("allows empty string to disable verification auto actions", async () => {
    const cfg = await load({ VERIFICATION_AUTO_ACTIONS: "" });
    expect([...cfg.verificationAutoActions]).toEqual([]);
  });

  it("rejects unknown verification auto actions", async () => {
    await expect(load({ VERIFICATION_AUTO_ACTIONS: "synchronize,labeled" })).rejects.toThrow(
      /VERIFICATION_AUTO_ACTIONS contains unknown action/,
    );
  });

  it("defaults verification concurrency to 1", async () => {
    const cfg = await load({});
    expect(cfg.verificationConcurrency).toBe(1);
  });

  it("defaults max tool rounds verification to 32", async () => {
    const cfg = await load({});
    expect(cfg.maxToolRoundsVerification).toBe(32);
  });
});
