import { describe, expect, it } from "vitest";
import {
  prepareFindingsForPublish,
  prepareReviewPayloadForPublish,
} from "../src/review/findings/findingPipeline.js";
import { mintFindingId } from "../src/review/findingIdentity/findingMarker.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
} from "../src/review/placement/reviewDiffIndex.js";
import type { InlinePlacement } from "../src/review/placement/reviewDiffPlacement.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import {
  createTestEvidenceLedger,
  seedEvidenceForFinding,
  seedEvidenceForFindings,
} from "./helpers/evidenceTestHelpers.js";
import { makeReviewPayload } from "./helpers/reviewPayloadFactory.js";

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
      payload: makeReviewPayload({
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
      payload: makeReviewPayload({ findings: [secretFinding] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.placements[0]?.finding).toBe(result.prepared.payload.findings[0]);
    expect(result.prepared.placements[0]?.finding.detail).not.toContain("sk-");
  });

  it("returns inline and summary-only targets after the inline cap with assigned identities", () => {
    const repeated = finding({ title: "Repeat finding", startLine: 1, severity: "P1" });
    const capped = finding({ title: "Cap lower priority", startLine: 2, severity: "P2" });
    const kept = finding({ title: "Keep critical", startLine: 3, severity: "P0" });
    const keptId = mintFindingId();
    const reopened = mintFindingId();

    const result = prepareFindingsForPublish({
      payload: makeReviewPayload({ findings: [repeated, capped, kept] }),
      inlinePlacements: [placement(repeated), placement(capped), placement(kept)],
      identify: (target) =>
        target.finding.title === "Keep critical"
          ? { findingId: keptId, reopens: reopened }
          : { findingId: mintFindingId() },
      maxInlineComments: 1,
    });

    expect(result.planned.map((target) => target.finding.title)).toEqual([
      "Repeat finding",
      "Cap lower priority",
      "Keep critical",
    ]);
    expect(result.planned.map((target) => target.inlinePosted)).toEqual([true, true, true]);
    expect(result.placements.map((target) => target.inlinePosted)).toEqual([false, false, true]);
    expect(result.inline).toEqual([
      expect.objectContaining({ findingId: keptId, reopens: reopened }),
    ]);
    expect(result.summaryOnly.map((target) => target.finding.title).toSorted()).toEqual([
      "Cap lower priority",
      "Repeat finding",
    ]);
    expect(result.dropped).toEqual({
      inlineCommentCapExcluded: 2,
      anchorUnresolved: 0,
    });
  });

  it("returns empty planned and placements when there are no findings", () => {
    const result = prepareFindingsForPublish({
      payload: makeReviewPayload({ findings: [] }),
    });

    expect(result.planned).toEqual([]);
    expect(result.placements).toEqual([]);
    expect(result.inline).toEqual([]);
    expect(result.summaryOnly).toEqual([]);
    expect(result.dropped).toEqual({
      inlineCommentCapExcluded: 0,
      anchorUnresolved: 0,
    });
  });

  it("keeps unresolved anchors in planned and counts them as dropped", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [{ filename: "src/a.ts", patch: ["@@ -1,1 +1,2 @@", " x", "+y"].join("\n") }],
    });
    const anchored = finding({ title: "Anchored", startLine: 2, endLine: 2 });
    const unresolved = finding({ title: "Unresolved", startLine: 99, endLine: 99 });

    const result = prepareFindingsForPublish({
      payload: makeReviewPayload({ findings: [anchored, unresolved] }),
      cachedDiffIndex: index,
    });

    expect(
      result.planned.map((target) => ({
        title: target.finding.title,
        posted: target.inlinePosted,
      })),
    ).toEqual([
      { title: "Anchored", posted: true },
      { title: "Unresolved", posted: false },
    ]);
    expect(result.placements.map((target) => target.inlinePosted)).toEqual([true, false]);
    expect(result.inline.map((target) => target.finding.title)).toEqual(["Anchored"]);
    expect(result.summaryOnly.map((target) => target.finding.title)).toEqual(["Unresolved"]);
    expect(result.dropped).toEqual({
      inlineCommentCapExcluded: 0,
      anchorUnresolved: 1,
    });
  });

  it("strips findings without evidence before publish preparation", () => {
    const evidenced = finding({ title: "Evidenced", startLine: 1 });
    const unevidenced = finding({ title: "Unevidenced", startLine: 2, file: "src/b.ts" });
    const evidenceLedger = createTestEvidenceLedger();
    seedEvidenceForFinding(evidenceLedger, evidenced);

    const result = prepareReviewPayloadForPublish({
      payload: makeReviewPayload({ findings: [evidenced, unevidenced] }),
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
      payload: makeReviewPayload({ findings: items }),
      evidenceLedger,
      headSha: evidenceLedger.headSha,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.payload.findings).toHaveLength(2);
  });

  it("keeps a valid payload when leftover unknown finding keys are already absent", () => {
    const item = finding({ title: "Fork policy" });
    const result = prepareReviewPayloadForPublish({
      payload: makeReviewPayload({ findings: [item] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.payload.findings[0]).not.toHaveProperty("violatedRule");
    expect(result.prepared.payload.findings[0]?.title).toBe("Fork policy");
  });
});
