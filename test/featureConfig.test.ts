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
  };
  const { loadConfig } = await import("../src/config.js");
  return loadConfig();
}

describe("feature config", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("defaults features to current behavior", async () => {
    const cfg = await load({});
    expect(cfg.features).toEqual({
      review: "auto",
      describe: "auto",
      verification: "auto",
      ask: "manual",
      triage: "manual",
      reviewLabels: "size",
      commitStatus: false,
      titleRewrite: false,
    });
  });

  it("parses explicit modes", async () => {
    const cfg = await load({
      FEATURE_DESCRIBE: "off",
      FEATURE_ASK: "off",
      FEATURE_REVIEW_LABELS: "size+security",
      FEATURE_COMMIT_STATUS: "true",
    });
    expect(cfg.features.describe).toBe("off");
    expect(cfg.features.ask).toBe("off");
    expect(cfg.features.reviewLabels).toBe("size+security");
    expect(cfg.features.commitStatus).toBe(true);
  });

  it("rejects invalid modes", async () => {
    await expect(load({ FEATURE_REVIEW: "off" })).rejects.toThrow(/FEATURE_REVIEW/);
    await expect(load({ FEATURE_TITLE_REWRITE: "yes" })).rejects.toThrow(/FEATURE_TITLE_REWRITE/);
  });

  it("readStrictBoolean error includes allowed values", async () => {
    await expect(load({ FEATURE_COMMIT_STATUS: "1" })).rejects.toThrow(
      /FEATURE_COMMIT_STATUS.*true.*false/,
    );
    await expect(load({ FEATURE_TITLE_REWRITE: "yes" })).rejects.toThrow(
      /FEATURE_TITLE_REWRITE.*true.*false/,
    );
  });
});
