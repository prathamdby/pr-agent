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
import {
  createTestEvidenceLedger,
  seedEvidenceForFinding,
  seedEvidenceForFindings,
} from "./helpers/evidenceTestHelpers.js";

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
    size: "S",
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
      reviewMinConfidence: 3,
      cachedDiffIndex: index,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.payload.findings).toEqual([]);
    expect(result.prepared.placements).toEqual([]);
  });

  it("keeps validated placements aligned with redacted findings", () => {
    const secretFinding = finding({
      title: "Do not expose secret",
      detail: "Leaked key OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
    });

    const result = prepareReviewPayloadForPublish({
      payload: payload({ findings: [secretFinding] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.placements[0]?.finding).toBe(result.prepared.payload.findings[0]);
    expect(result.prepared.placements[0]?.finding.detail).not.toContain("sk-");
  });

  it("returns inline and summary-only targets after fingerprint suppression and inline cap", () => {
    const suppressed = finding({ title: "Suppress repeat", startLine: 1, severity: "P1" });
    const capped = finding({ title: "Cap lower priority", startLine: 2, severity: "P2" });
    const kept = finding({ title: "Keep critical", startLine: 3, severity: "P0" });

    const result = prepareFindingsForPublish({
      payload: payload({ findings: [suppressed, capped, kept] }),
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

  it("keeps inline when cross-PR dismiss history is below threshold", () => {
    const item = finding({ title: "Repeat risk", startLine: 4 });
    const fp = fingerprintFinding(item, "review");

    const result = prepareFindingsForPublish({
      payload: payload({ findings: [item] }),
      inlinePlacements: [placement(item)],
      crossPrSuppressionFingerprints: [],
      storedInlineFingerprints: [],
    });

    expect(result.inline).toHaveLength(1);
    expect(result.inline[0]?.inlineFingerprint).toBe(fp);
  });

  it("downgrades to summary-only when cross-PR dismiss threshold is met", () => {
    const item = finding({ title: "Repeat risk", startLine: 4 });
    const fp = fingerprintFinding(item, "review");

    const result = prepareFindingsForPublish({
      payload: payload({ findings: [item] }),
      inlinePlacements: [placement(item)],
      crossPrSuppressionFingerprints: [fp],
      storedInlineFingerprints: [],
    });

    expect(result.inline).toHaveLength(0);
    expect(result.summaryOnly).toHaveLength(1);
    expect(result.summaryOnly[0]?.finding.title).toBe("Repeat risk");
    expect(result.dropped.suppressedInlineCount).toBe(1);
  });

  it("records new fingerprints under the merged review mode", () => {
    const item = finding();
    const evidenceLedger = createTestEvidenceLedger();
    seedEvidenceForFinding(evidenceLedger, item);
    const result = prepareFindingsForPublish({
      payload: payload({ findings: [item] }),
      inlinePlacements: [placement(item)],
    });

    expect(result.inline[0]?.inlineFingerprint).toBe(fingerprintFinding(item, "review"));
    expect(result.inline[0]?.inlineFingerprint).not.toBe(
      fingerprintFinding(item, "review-security"),
    );
  });

  it("strips findings without evidence before publish preparation", () => {
    const evidenced = finding({ title: "Evidenced", startLine: 1 });
    const unevidenced = finding({ title: "Unevidenced", startLine: 2, file: "src/b.ts" });
    const evidenceLedger = createTestEvidenceLedger();
    seedEvidenceForFinding(evidenceLedger, evidenced);

    const result = prepareReviewPayloadForPublish({
      payload: payload({ findings: [evidenced, unevidenced] }),
      evidenceLedger,
      headSha: evidenceLedger.headSha,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.payload.findings.map((item) => item.title)).toEqual(["Evidenced"]);
  });

  it("keeps publishable findings when evidence covers cited lines", () => {
    const items = [finding({ startLine: 1 }), finding({ startLine: 2, title: "Second" })];
    const evidenceLedger = createTestEvidenceLedger();
    seedEvidenceForFindings(evidenceLedger, items);

    const result = prepareReviewPayloadForPublish({
      payload: payload({ findings: items }),
      evidenceLedger,
      headSha: evidenceLedger.headSha,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.payload.findings).toHaveLength(2);
  });
});
