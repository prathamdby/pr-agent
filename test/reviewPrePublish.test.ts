import { describe, expect, it } from "vitest";
import { prepareReviewPayloadForPublish } from "../src/review/reviewPrePublish.js";
import { planInlinePlacements } from "../src/review/reviewDiffPlacement.js";
import type { ReviewPayload } from "../src/review/reviewSchema.js";

type ReviewFinding = ReviewPayload["findings"][number];

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "P1",
    file: "src/a.ts",
    startLine: 1,
    endLine: 1,
    title: "Issue",
    detail: "Details.",
    fixPrompt: "Fix it.",
    ...overrides,
  };
}

function makePayload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    prCharacter: "Test.",
    findings: [],
    estimatedEffort: 2,
    relevantTests: "no",
    securityConcerns: null,
    followUps: [],
    ...overrides,
  };
}

const secretDetail = "Found DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent";

describe("prepareReviewPayloadForPublish", () => {
  it("dedupes overlapping findings before publish", () => {
    const payload = makePayload({
      findings: [
        makeFinding({
          severity: "P1",
          startLine: 10,
          endLine: 12,
          title: "Race",
          detail: "Same issue",
          fixPrompt: "fix 2",
        }),
        makeFinding({
          severity: "P0",
          startLine: 11,
          endLine: 13,
          title: "Race",
          detail: "Same issue",
          fixPrompt: "fix 1",
        }),
      ],
    });

    const result = prepareReviewPayloadForPublish({ payload, mode: "review" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.payload.findings).toHaveLength(1);
    expect(result.prepared.payload.findings[0]?.severity).toBe("P0");
    expect(result.prepared.dedupedCount).toBe(1);
  });

  it("passes finding detail with internal failure phrasing through after secret scrub", () => {
    const detail = "Structured publish failed after 1/3 attempt(s).";
    const payload = makePayload({
      findings: [makeFinding({ severity: "P2", detail, fixPrompt: "Fix the handler." })],
    });

    const result = prepareReviewPayloadForPublish({ payload, mode: "review" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.payload.findings[0]?.detail).toBe(detail);
  });

  it("rejects overview with internal failure phrasing instead of redacting", () => {
    const payload = makePayload({
      prCharacter: "Structured publish failed after 3/3 attempt(s). Check server logs.",
    });

    const result = prepareReviewPayloadForPublish({ payload, mode: "review" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/prCharacter/);
  });

  it("scrubs secret assignments in prepared payload", () => {
    const payload = makePayload({
      findings: [
        makeFinding({
          title: "Secret in detail",
          detail: secretDetail,
          fixPrompt: "Rotate credentials.",
        }),
      ],
    });

    const result = prepareReviewPayloadForPublish({ payload, mode: "review" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.payload.findings[0]?.detail).toContain("[redacted]");
    expect(result.prepared.payload.findings[0]?.detail).not.toContain("postgres://");
  });

  it("threads placements aligned to the redacted findings", () => {
    const payload = makePayload({
      findings: [
        makeFinding({
          title: "Secret in detail",
          detail: secretDetail,
          fixPrompt: "Rotate credentials.",
        }),
      ],
    });

    const result = prepareReviewPayloadForPublish({ payload, mode: "review" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.placements).toEqual(
      planInlinePlacements([...result.prepared.payload.findings], undefined),
    );
    expect(result.prepared.placements[0]?.finding).toBe(result.prepared.payload.findings[0]);
  });
});
