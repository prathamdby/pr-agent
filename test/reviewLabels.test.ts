import { describe, expect, it } from "vitest";
import type { ReviewPayload } from "../src/agent/reviewSchema.js";
import { labelsAlreadySynced, syncReviewLabels } from "../src/agent/reviewLabels.js";

const basePayload: ReviewPayload = {
  prCharacter: "Test.",
  findings: [],
  estimatedEffort: 2,
  relevantTests: "no",
  securityConcerns: null,
  followUps: [],
};

describe("labelsAlreadySynced", () => {
  it("returns false when effort matches but security label is stale", () => {
    expect(
      labelsAlreadySynced(["Review effort 2/5", "Possible security concern"], basePayload, {
        effort: true,
        security: true,
      }),
    ).toBe(false);
  });

  it("returns true when effort and security labels match payload", () => {
    expect(
      labelsAlreadySynced(
        ["Review effort 2/5", "Possible security concern"],
        {
          ...basePayload,
          securityConcerns: "xss",
        },
        {
          effort: true,
          security: true,
        },
      ),
    ).toBe(true);
  });
});

describe("syncReviewLabels", () => {
  it("replaces Review effort label and preserves unrelated labels", () => {
    const current = ["Review effort 3/5", "bug", "enhancement"];
    const next = syncReviewLabels(current, ["Review effort 4/5"]);
    expect(next).toEqual(["bug", "enhancement", "Review effort 4/5"]);
  });

  it("drops Possible security concern when not in next managed set", () => {
    const current = ["Possible security concern", "docs"];
    const next = syncReviewLabels(current, ["Review effort 2/5"]);
    expect(next).toEqual(["docs", "Review effort 2/5"]);
  });
});
