import { describe, expect, it } from "vitest";
import { validateReviewPayload } from "../src/review/findings/reviewFindingValidator.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
} from "../src/review/placement/reviewDiffIndex.js";
import type { ReviewPayload } from "../src/review/reviewSchema.js";

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
  it("rejects internal failure phrasing on overview fields", () => {
    const result = validateReviewPayload({
      payload: basePayload({
        prCharacter: "Structured publish failed after 3/3 attempt(s). Check server logs.",
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/prCharacter/);
      expect(result.anchorFailures).toEqual([]);
    }
  });

  it("accepts overview mentioning structured publish without failure wording", () => {
    expect(
      validateReviewPayload({
        payload: basePayload({
          prCharacter: "This PR improves structured publish reliability and adds metrics.",
        }),
      }).ok,
    ).toBe(true);
  });

  it("rejects followUps with internal failure phrasing", () => {
    const result = validateReviewPayload({
      payload: basePayload({
        followUps: ["Structured publish failed after 2/3 attempt(s)."],
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/followUps\[0\]/);
    }
  });

  it("accepts findings that mention repository symbols matching banned patterns", () => {
    expect(
      validateReviewPayload({
        payload: basePayload({
          findings: [
            {
              severity: "P1",
              file: "src/submitReviewTool.ts",
              startLine: 1,
              endLine: 1,
              title: "submitReview retry path missing guard",
              detail:
                "The submitReview handler should check publish budget before calling GitHub API.",
              fixPrompt: "Add a guard in submitReview before createPullRequestReviewWithComments.",
            },
          ],
        }),
      }).ok,
    ).toBe(true);
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
      }).ok,
    ).toBe(true);
  });

  it("rejects cap-eligible P1 findings with invalid anchors when diff cache present", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        {
          filename: "src/x.ts",
          patch: ["@@ -4,1 +4,2 @@", " context", "+added"].join("\n"),
        },
      ],
    });

    const result = validateReviewPayload({
      payload: basePayload({
        findings: [
          {
            severity: "P1",
            file: "src/x.ts",
            startLine: 99,
            endLine: 99,
            title: "Off diff",
            detail: "d",
            fixPrompt: "fix",
          },
        ],
      }),
      cachedDiffIndex: index,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.anchorFailures).toHaveLength(1);
      expect(result.anchorFailures[0]?.suggestedRanges?.length).toBeGreaterThan(0);
      expect(result.message).toContain("Inline anchor validation failed");
    }
  });

  it("accepts P1 findings on patchOmitted files", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [{ filename: "src/x.ts", patchOmitted: true }],
    });

    expect(
      validateReviewPayload({
        payload: basePayload({
          findings: [
            {
              severity: "P1",
              file: "src/x.ts",
              startLine: 1,
              endLine: 1,
              title: "Large file",
              detail: "d",
              fixPrompt: "fix",
            },
          ],
        }),
        cachedDiffIndex: index,
      }).ok,
    ).toBe(true);
  });

  it("accepts P1 findings on deletion-only patches with no commentable lines", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        {
          filename: "src/x.ts",
          patch: ["@@ -10,2 +10,0 @@", " context", "-deleted line"].join("\n"),
        },
      ],
    });

    expect(
      validateReviewPayload({
        payload: basePayload({
          findings: [
            {
              severity: "P1",
              file: "src/x.ts",
              startLine: 10,
              endLine: 10,
              title: "Deletion only",
              detail: "d",
              fixPrompt: "fix",
            },
          ],
        }),
        cachedDiffIndex: index,
      }).ok,
    ).toBe(true);
  });

  it("accepts cap-eligible P1 when diff cache is ingested with zero files", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, { files: [] });

    expect(
      validateReviewPayload({
        payload: basePayload({
          findings: [
            {
              severity: "P1",
              file: "src/x.ts",
              startLine: 1,
              endLine: 1,
              title: "Zero-file PR",
              detail: "d",
              fixPrompt: "fix",
            },
          ],
        }),
        cachedDiffIndex: index,
      }).ok,
    ).toBe(true);
  });

  it("accepts cap-eligible P1 when diff cache is truncated and file is absent", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      truncated: true,
      files: [{ filename: "a.ts", patch: ["@@ -1,1 +1,2 @@", " x", "+y"].join("\n") }],
    });

    expect(
      validateReviewPayload({
        payload: basePayload({
          findings: [
            {
              severity: "P1",
              file: "missing.ts",
              startLine: 1,
              endLine: 1,
              title: "Truncated away",
              detail: "d",
              fixPrompt: "fix",
            },
          ],
        }),
        cachedDiffIndex: index,
      }).ok,
    ).toBe(true);
  });

  it("rejects cap-eligible P1 when file is absent from non-truncated diff cache", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [{ filename: "a.ts", patch: ["@@ -1,1 +1,2 @@", " x", "+y"].join("\n") }],
    });

    const result = validateReviewPayload({
      payload: basePayload({
        findings: [
          {
            severity: "P1",
            file: "missing.ts",
            startLine: 1,
            endLine: 1,
            title: "Not in PR",
            detail: "d",
            fixPrompt: "fix",
          },
        ],
      }),
      cachedDiffIndex: index,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.anchorFailures).toHaveLength(1);
      expect(result.anchorFailures[0]?.file).toBe("missing.ts");
    }
  });

  it("aggregates multiple anchor failures with suggested ranges", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        {
          filename: "a.ts",
          patch: ["@@ -1,1 +1,2 @@", " x", "+y"].join("\n"),
        },
        {
          filename: "b.ts",
          patch: ["@@ -2,1 +2,2 @@", " x", "+y"].join("\n"),
        },
      ],
    });

    const result = validateReviewPayload({
      payload: basePayload({
        findings: [
          {
            severity: "P1",
            file: "a.ts",
            startLine: 99,
            endLine: 99,
            title: "Bad a",
            detail: "d",
            fixPrompt: "fix",
          },
          {
            severity: "P1",
            file: "b.ts",
            startLine: 88,
            endLine: 88,
            title: "Bad b",
            detail: "d",
            fixPrompt: "fix",
          },
        ],
      }),
      cachedDiffIndex: index,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.anchorFailures).toHaveLength(2);
      expect(result.message).toContain("findings[0]");
      expect(result.message).toContain("findings[1]");
      expect(result.message).toContain("Commentable RIGHT-side lines");
    }
  });

  it("caps suggested ranges in anchor repair message", () => {
    const index = createCachedPrDiffIndex();
    index.listPullRequestFilesIngested = true;
    index.files.set("a.ts", {
      patchOmitted: false,
      commentableRightLineRanges: Array.from({ length: 25 }, (_, i): [number, number] => [
        i + 1,
        i + 1,
      ]),
      additions: 25,
      deletions: 0,
    });

    const result = validateReviewPayload({
      payload: basePayload({
        findings: [
          {
            severity: "P1",
            file: "a.ts",
            startLine: 99,
            endLine: 99,
            title: "Bad a",
            detail: "d",
            fixPrompt: "fix",
          },
        ],
      }),
      cachedDiffIndex: index,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("…5 more ranges");
      expect(result.message).not.toContain("25");
    }
  });

  it("rejects cap-eligible P1 findings with invalid anchors", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        { filename: "a.ts", patch: ["@@ -1,1 +1,2 @@", " x", "+y"].join("\n") },
        { filename: "b.ts", patch: ["@@ -2,1 +2,2 @@", " x", "+y"].join("\n") },
      ],
    });

    expect(
      validateReviewPayload({
        payload: basePayload({
          findings: [
            {
              severity: "P1",
              file: "a.ts",
              startLine: 1,
              endLine: 1,
              title: "First inline",
              detail: "d",
              fixPrompt: "fix",
            },
            {
              severity: "P1",
              file: "b.ts",
              startLine: 99,
              endLine: 99,
              title: "Bad anchor",
              detail: "d",
              fixPrompt: "fix",
            },
          ],
        }),
        cachedDiffIndex: index,
      }).ok,
    ).toBe(false);
  });

  it("rejects mergeVerdict score > 3 when P1 findings are present", () => {
    const result = validateReviewPayload({
      payload: basePayload({
        findings: [
          {
            severity: "P1",
            file: "src/x.ts",
            startLine: 1,
            endLine: 1,
            title: "Bug",
            detail: "d",
            fixPrompt: "fix",
          },
        ],
        mergeVerdict: { score: 4, rationale: "One minor issue, mostly clean." },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("mergeVerdict.score");
      expect(result.message).toContain("<= 3");
    }
  });

  it("rejects mergeVerdict rationale with safe-to-merge wording when P1 present", () => {
    const result = validateReviewPayload({
      payload: basePayload({
        findings: [
          {
            severity: "P1",
            file: "src/x.ts",
            startLine: 1,
            endLine: 1,
            title: "Bug",
            detail: "d",
            fixPrompt: "fix",
          },
        ],
        mergeVerdict: { score: 2, rationale: "Looks safe to merge despite the finding." },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("mergeVerdict.rationale");
      expect(result.message).toContain("safe-to-merge");
    }
  });

  it("accepts mergeVerdict score 5 when no P0/P1 findings", () => {
    expect(
      validateReviewPayload({
        payload: basePayload({
          findings: [
            {
              severity: "P2",
              file: "src/x.ts",
              startLine: 1,
              endLine: 1,
              title: "Minor",
              detail: "d",
              fixPrompt: "fix",
            },
          ],
          mergeVerdict: { score: 5, rationale: "No blocking issues on this pass." },
        }),
      }).ok,
    ).toBe(true);
  });

  it("accepts absent mergeVerdict", () => {
    expect(
      validateReviewPayload({
        payload: basePayload({
          findings: [
            {
              severity: "P1",
              file: "src/x.ts",
              startLine: 1,
              endLine: 1,
              title: "Bug",
              detail: "d",
              fixPrompt: "fix",
            },
          ],
        }),
      }).ok,
    ).toBe(true);
  });

  it("rejects internal failure phrasing in mergeVerdict.rationale", () => {
    const result = validateReviewPayload({
      payload: basePayload({
        mergeVerdict: {
          score: 3,
          rationale: "Structured publish failed after 2/3 attempt(s).",
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("mergeVerdict.rationale");
    }
  });
});
