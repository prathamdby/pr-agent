import { describe, expect, it } from "vitest";
import type { ReviewPayload } from "../src/review/reviewSchema.js";
import {
  labelsAlreadySynced,
  reviewLabelsFromPayload,
  syncReviewLabels,
} from "../src/review/reviewLabels.js";

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

  it("checks effort labels inside the current lens prefix", () => {
    expect(
      labelsAlreadySynced(
        ["Review effort 4/5", "Quality effort 2/5"],
        basePayload,
        {
          effort: true,
          security: false,
        },
        "review-quality",
      ),
    ).toBe(true);
  });

  it("returns false when the current lens effort label is stale", () => {
    expect(
      labelsAlreadySynced(
        ["Quality effort 1/5"],
        basePayload,
        {
          effort: true,
          security: false,
        },
        "review-quality",
      ),
    ).toBe(false);
  });
});

describe("reviewLabelsFromPayload", () => {
  it("uses lens-specific effort prefixes", () => {
    expect(
      reviewLabelsFromPayload(
        basePayload,
        {
          effort: true,
          security: false,
        },
        "review-security",
      ),
    ).toEqual(["Security effort 2/5"]);
    expect(
      reviewLabelsFromPayload(
        basePayload,
        {
          effort: true,
          security: false,
        },
        "review-quality",
      ),
    ).toEqual(["Quality effort 2/5"]);
    expect(
      reviewLabelsFromPayload(
        basePayload,
        {
          effort: true,
          security: false,
        },
        "review-tests",
      ),
    ).toEqual(["Tests effort 2/5"]);
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

  it("replaces only the current lens effort label family", () => {
    const current = ["Review effort 3/5", "Quality effort 1/5", "bug"];
    const next = syncReviewLabels(current, ["Quality effort 2/5"], "review-quality");
    expect(next).toEqual(["Review effort 3/5", "bug", "Quality effort 2/5"]);
  });
});
