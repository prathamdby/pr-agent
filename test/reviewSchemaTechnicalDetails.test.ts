import { describe, expect, it } from "vitest";
import {
  normalizeReviewPayload,
  reviewPayloadSchema,
  type ReviewPayload,
} from "../src/agent/reviewSchema.js";

const basePayload = (): ReviewPayload => ({
  prCharacter: "Test",
  findings: [],
  estimatedEffort: 2,
  relevantTests: "no",
  securityConcerns: null,
  followUps: [],
});

describe("technicalDetails schema", () => {
  it("accepts technicalDetails on P0/P1", () => {
    const parsed = reviewPayloadSchema.parse({
      ...basePayload(),
      findings: [
        {
          severity: "P1",
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "Bug",
          detail: "detail",
          fixPrompt: "fix",
          technicalDetails: "Longer mechanism explanation",
        },
      ],
    });
    expect(parsed.findings[0]?.technicalDetails).toBe("Longer mechanism explanation");
  });

  it("strips technicalDetails on P2 during normalize", () => {
    const normalized = normalizeReviewPayload({
      ...basePayload(),
      findings: [
        {
          severity: "P2",
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "Bug",
          detail: "detail",
          fixPrompt: "fix",
          technicalDetails: "should drop",
        },
      ],
    });
    expect(normalized.findings[0]).not.toHaveProperty("technicalDetails");
  });
});
