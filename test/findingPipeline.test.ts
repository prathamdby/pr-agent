import { describe, expect, it } from "vitest";
import {
  prepareFindingsForPublish,
  prepareReviewPayloadForPublish,
} from "../src/review/findings/findingPipeline.js";
import { fingerprintFinding } from "../src/review/findings/reviewFindingFingerprint.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
} from "../src/review/placement/reviewDiffIndex.js";
import type { InlinePlacement } from "../src/review/placement/reviewDiffPlacement.js";
import type { ReviewFinding, ReviewPayload } from "../src/review/reviewSchema.js";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
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

function payload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
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

function placement(item: ReviewFinding): InlinePlacement {
  return {
    finding: item,
    inlineLine: item.startLine,
    inlinePosted: true,
  };
}

describe("findingPipeline", () => {
  it("filters low-confidence findings before validating anchors", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [{ filename: "src/a.ts", patch: ["@@ -1,1 +1,2 @@", " x", "+y"].join("\n") }],
    });

    const result = prepareReviewPayloadForPublish({
      payload: payload({
        findings: [finding({ startLine: 99, endLine: 99, confidence: 1 })],
      }),
      mode: "review",
      reviewMinConfidence: 3,
      cachedDiffIndex: index,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.payload.findings).toEqual([]);
    expect(result.prepared.placements).toEqual([]);
  });

  it("returns inline and summary-only targets after fingerprint suppression and inline cap", () => {
    const suppressed = finding({ title: "Suppress repeat", startLine: 1, severity: "P1" });
    const capped = finding({ title: "Cap lower priority", startLine: 2, severity: "P2" });
    const kept = finding({ title: "Keep critical", startLine: 3, severity: "P0" });

    const result = prepareFindingsForPublish({
      payload: payload({ findings: [suppressed, capped, kept] }),
      mode: "review",
      inlinePlacements: [placement(suppressed), placement(capped), placement(kept)],
      storedInlineFingerprints: [fingerprintFinding(suppressed, "review")],
      maxInlineComments: 1,
    });

    expect(result.inline.map((target) => target.finding.title)).toEqual(["Keep critical"]);
    expect(result.summaryOnly.map((target) => target.finding.title).toSorted()).toEqual([
      "Cap lower priority",
      "Suppress repeat",
    ]);
    expect(result.dropped).toEqual({
      suppressedInlineCount: 1,
      inlineCommentCapExcluded: 1,
      anchorUnresolved: 0,
    });
  });
});
