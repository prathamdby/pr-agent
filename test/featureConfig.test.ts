import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigWithBaseEnv as load } from "./helpers/config.ts";

describe("feature config", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("defaults features to current behavior", async () => {
    const cfg = await load({});
    expect(cfg.features).toEqual({
      review: "approval",
      reviewCadence: "once",
      describe: "auto",
      verification: "auto",
      ask: "manual",
      triage: "manual",
      reviewLabels: "size",
      commitStatus: false,
      titleRewrite: true,
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
    await expect(load({ FEATURE_REVIEW_CADENCE: "burst" })).rejects.toThrow(/once.*every_push/);
    await expect(
      load({ FEATURE_REVIEW: "manual", FEATURE_REVIEW_CADENCE: "every_push" }),
    ).rejects.toThrow(/FEATURE_REVIEW_CADENCE[\s\S]*FEATURE_REVIEW/);
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
