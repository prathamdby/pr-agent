import { describe, expect, it } from "vitest";
import { makeReviewPayload } from "./helpers/reviewPayloadFactory.js";
import {
  dominantReviewCategory,
  hasManagedCategoryLabel,
  labelsAlreadySynced,
  reviewLabelsFromPayload,
  syncReviewLabels,
} from "../src/review/run/reviewLabels.js";

const basePayload = makeReviewPayload();

describe("labelsAlreadySynced", () => {
  it("returns false when size matches but security label is stale", () => {
    expect(
      labelsAlreadySynced(["size:S", "Possible security concern"], basePayload, {
        size: true,
        security: true,
        category: false,
      }),
    ).toBe(false);
  });

  it("returns true when size and security labels match payload", () => {
    expect(
      labelsAlreadySynced(
        ["size:S", "Possible security concern"],
        {
          ...basePayload,
          securityConcerns: "xss",
        },
        {
          size: true,
          security: true,
          category: false,
        },
      ),
    ).toBe(true);
  });

  it("returns false when the size label is stale", () => {
    expect(
      labelsAlreadySynced(["size:XS"], basePayload, {
        size: true,
        security: false,
        category: false,
      }),
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
          size: false,
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
  it("uses the size prefix", () => {
    expect(
      reviewLabelsFromPayload(basePayload, {
        size: true,
        security: false,
        category: false,
      }),
    ).toEqual(["size:S"]);
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
          size: false,
          security: false,
          category: true,
        },
      ),
    ).toEqual(["Category: performance"]);
  });
});

describe("syncReviewLabels", () => {
  it("replaces size label and preserves unrelated labels", () => {
    const current = ["size:L", "bug", "enhancement"];
    const next = syncReviewLabels(current, ["size:XL"]);
    expect(next).toEqual(["bug", "enhancement", "size:XL"]);
  });

  it("drops Possible security concern when not in next managed set", () => {
    const current = ["Possible security concern", "docs"];
    const next = syncReviewLabels(current, ["size:S"]);
    expect(next).toEqual(["docs", "size:S"]);
  });

  it("replaces category labels without touching size labels", () => {
    const current = ["size:S", "Category: bug", "enhancement"];
    const next = syncReviewLabels(current, ["size:S", "Category: security"]);
    expect(next).toEqual(["enhancement", "size:S", "Category: security"]);
  });

  it("removes stale category labels when payload has no dominant category", () => {
    const current = ["Category: bug", "enhancement"];
    const next = syncReviewLabels(current, []);
    expect(next).toEqual(["enhancement"]);
  });
});
