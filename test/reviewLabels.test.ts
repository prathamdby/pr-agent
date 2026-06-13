import { describe, expect, it } from "vitest";
import type { ReviewPayload } from "../src/review/reviewSchema.js";
import {
  dominantReviewCategory,
  hasManagedCategoryLabel,
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
        category: false,
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
          category: false,
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
          category: false,
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
          category: false,
        },
        "review-quality",
      ),
    ).toBe(false);
  });

  it("returns false when category label is stale", () => {
    expect(
      labelsAlreadySynced(
        ["Category: bug"],
        {
          ...basePayload,
          findings: [
            {
              severity: "P2",
              file: "a.ts",
              startLine: 1,
              endLine: 1,
              title: "t",
              detail: "d",
              fixPrompt: "fix",
              category: "security",
            },
          ],
        },
        {
          effort: false,
          security: false,
          category: true,
        },
      ),
    ).toBe(false);
  });
});

describe("dominantReviewCategory", () => {
  it("picks plurality and breaks ties by first enum value", () => {
    const findings = [
      {
        severity: "P2" as const,
        file: "a.ts",
        startLine: 1,
        endLine: 1,
        title: "a",
        detail: "d",
        fixPrompt: "fix",
        category: "security" as const,
      },
      {
        severity: "P1" as const,
        file: "b.ts",
        startLine: 1,
        endLine: 1,
        title: "b",
        detail: "d",
        fixPrompt: "fix",
        category: "bug" as const,
      },
      {
        severity: "P0" as const,
        file: "c.ts",
        startLine: 1,
        endLine: 1,
        title: "c",
        detail: "d",
        fixPrompt: "fix",
        category: "bug" as const,
      },
    ];
    expect(dominantReviewCategory(findings)).toBe("bug");
  });
});

describe("hasManagedCategoryLabel", () => {
  it("detects existing Category labels", () => {
    expect(hasManagedCategoryLabel(["bug", "Category: security"])).toBe(true);
    expect(hasManagedCategoryLabel(["bug"])).toBe(false);
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
          category: false,
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
          category: false,
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
          category: false,
        },
        "review-tests",
      ),
    ).toEqual(["Tests effort 2/5"]);
  });

  it("adds dominant category label when enabled", () => {
    expect(
      reviewLabelsFromPayload(
        {
          ...basePayload,
          findings: [
            {
              severity: "P2",
              file: "a.ts",
              startLine: 1,
              endLine: 1,
              title: "t",
              detail: "d",
              fixPrompt: "fix",
              category: "performance",
            },
          ],
        },
        {
          effort: false,
          security: false,
          category: true,
        },
      ),
    ).toEqual(["Category: performance"]);
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

  it("replaces category labels without touching effort labels", () => {
    const current = ["Review effort 2/5", "Category: bug", "enhancement"];
    const next = syncReviewLabels(current, ["Review effort 2/5", "Category: security"], "review");
    expect(next).toEqual(["enhancement", "Review effort 2/5", "Category: security"]);
  });

  it("removes stale category labels when payload has no dominant category", () => {
    const current = ["Category: bug", "enhancement"];
    const next = syncReviewLabels(current, [], "review");
    expect(next).toEqual(["enhancement"]);
  });
});
