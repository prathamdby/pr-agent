import { describe, expect, it } from "vitest";
import { validateReviewPayload } from "../src/agent/reviewFindingValidator.js";
import type { ReviewPayload } from "../src/agent/reviewSchema.js";

function basePayload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    prCharacter: "Updates docs.",
    findings: [],
    estimatedEffort: 2,
    relevantTests: "no",
    securityConcerns: null,
    followUps: [],
    ...overrides,
  };
}

describe("validateReviewPayload", () => {
  it("rejects banned public-output phrasing", () => {
    const error = validateReviewPayload({
      payload: basePayload({ prCharacter: "submitReview failed internally" }),
    });
    expect(error).toMatch(/prCharacter/);
  });

  it("accepts clean payloads without diff cache", () => {
    expect(
      validateReviewPayload({
        payload: basePayload({
          findings: [
            {
              severity: "P3",
              file: "README.md",
              startLine: 1,
              endLine: 1,
              title: "Typo",
              detail: "minor",
            },
          ],
        }),
      }),
    ).toBeNull();
  });
});
