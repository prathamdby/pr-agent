import { describe, expect, it } from "vitest";
import {
  AUTO_TRIGGER_ACTIONS,
  DEFAULT_FEATURE_ASK,
  DEFAULT_FEATURE_COMMIT_STATUS,
  DEFAULT_FEATURE_DESCRIBE,
  DEFAULT_FEATURE_REVIEW,
  DEFAULT_FEATURE_REVIEW_LABELS,
  DEFAULT_FEATURE_TITLE_REWRITE,
  DEFAULT_FEATURE_TRIAGE,
  DEFAULT_FEATURE_VERIFICATION,
} from "../src/settings/index.js";

describe("feature modes", () => {
  it("defaults preserve current out-of-the-box behavior", () => {
    expect(DEFAULT_FEATURE_REVIEW).toBe("auto");
    expect(DEFAULT_FEATURE_DESCRIBE).toBe("auto");
    expect(DEFAULT_FEATURE_VERIFICATION).toBe("auto");
    expect(DEFAULT_FEATURE_ASK).toBe("manual");
    expect(DEFAULT_FEATURE_TRIAGE).toBe("manual");
    expect(DEFAULT_FEATURE_REVIEW_LABELS).toBe("effort");
    expect(DEFAULT_FEATURE_COMMIT_STATUS).toBe(false);
    expect(DEFAULT_FEATURE_TITLE_REWRITE).toBe(false);
  });

  it("auto triggers match the pre-revision AUTO_ACTIONS defaults", () => {
    expect([...AUTO_TRIGGER_ACTIONS.review]).toEqual(["opened"]);
    expect([...AUTO_TRIGGER_ACTIONS.describe]).toEqual(["opened"]);
    expect([...AUTO_TRIGGER_ACTIONS.verification]).toEqual(["synchronize"]);
  });
});
