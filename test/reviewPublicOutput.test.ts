import { describe, expect, it } from "vitest";
import { redactReviewPayloadSecrets, redactReviewText } from "../src/review/reviewPublicOutput.js";
import type { ReviewPayload } from "../src/review/reviewSchema.js";

describe("reviewPublicOutput", () => {
  it("leaves PR #38-shaped finding text mentioning submitReview unchanged", () => {
    const detail =
      "The submitReview gate uses files.size === 0 but an empty PR can have a valid ingested cache.";
    expect(redactReviewText(detail)).toBe(detail);
  });

  it("leaves prCharacter mentioning submitReview unchanged", () => {
    const prCharacter =
      "This PR extends the review harness and touches submitReview and reviewFindingValidator.";
    expect(redactReviewText(prCharacter)).toBe(prCharacter);
  });

  it("redacts Bearer tokens embedded in finding detail", () => {
    const detail = "Auth header uses Bearer ghp_1234567890123456789012345678901234";
    expect(redactReviewText(detail)).toContain("[redacted]");
    expect(redactReviewText(detail)).not.toContain("ghp_");
  });

  it("redacts DATABASE_URL assignments but not bare name mentions", () => {
    const assignment = "Set DATABASE_URL=postgres://user:pass@host/db in compose.";
    expect(redactReviewText(assignment)).toContain("[redacted]");
    expect(redactReviewText(assignment)).not.toContain("postgres://");

    const bare = "Configure DATABASE_URL in compose for local dev.";
    expect(redactReviewText(bare)).toBe(bare);
  });

  it("scrubs secrets across payload fields in redactReviewPayloadSecrets", () => {
    const payload: ReviewPayload = {
      prCharacter: "Safe overview.",
      findings: [
        {
          severity: "P1",
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "Leaked token",
          detail: "Uses OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz in example.",
          fixPrompt: "Remove the assignment from docs.",
        },
      ],
      estimatedEffort: 2,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    };

    const redacted = redactReviewPayloadSecrets(payload);
    expect(redacted.findings[0]?.detail).toContain("[redacted]");
    expect(redacted.findings[0]?.detail).not.toContain("sk-");
  });
});
