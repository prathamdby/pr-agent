import { describe, expect, it } from "vitest";
import type { ListPullRequestFilesResult } from "../src/github/listPullRequestFiles.js";
import type { LocalPrWorkspace } from "../src/prWorkspace/localPrWorkspace.js";
import {
  buildReviewEvidenceSnapshot,
  classifyReviewSloExemption,
  formatReviewEvidenceBlock,
  ReviewEvidenceCoverageError,
} from "../src/review/run/reviewEvidence.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);

function makePrFiles(
  overrides: Partial<ListPullRequestFilesResult> = {},
): ListPullRequestFilesResult {
  return {
    files: [
      { filename: "a.ts", status: "modified", additions: 2, deletions: 1, changes: 3 },
      { filename: "b.ts", status: "added", additions: 5, deletions: 0, changes: 5 },
    ],
    truncated: false,
    omittedCountLowerBound: 0,
    totalChanges: 8,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    baseRef: "main",
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<LocalPrWorkspace> = {}): LocalPrWorkspace {
  const diffByPath = new Map([
    ["a.ts", "@@ -1,1 +1,2 @@\n-old\n+new\n+more"],
    ["b.ts", "@@ -0,0 +1,5 @@\n+added"],
  ]);
  return {
    ...mockLocalPrWorkspace(),
    changedFiles: [
      { path: "b.ts", status: "added" },
      { path: "a.ts", status: "modified" },
    ],
    getDiffForPath: async (path: string) => diffByPath.get(path) ?? "",
    ...overrides,
  };
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    owner: "octo",
    repo: "repo",
    prNumber: 7,
    headSha: HEAD_SHA,
    prFiles: makePrFiles(),
    workspace: makeWorkspace(),
    policyContext: "Trusted context (review budget tier):\n- Tier: small",
    ...overrides,
  };
}

describe("buildReviewEvidenceSnapshot", () => {
  it("uses the GitHub fast path for complete listings with no coverage gaps", async () => {
    const snapshot = await buildReviewEvidenceSnapshot(baseParams());
    expect(snapshot.source).toBe("github-listing");
    expect(snapshot.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(snapshot.coverageGaps).toEqual([]);
    expect(snapshot.sloExempt).toBe(false);
    expect(snapshot.baseSha).toBe(BASE_SHA);
    expect(snapshot.files[0]?.diff).toContain("+new");
    expect(snapshot.files[0]?.additions).toBe(2);
    expect(snapshot.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails coverage for truncated listings without authoritative git derivation", async () => {
    await expect(
      buildReviewEvidenceSnapshot(
        baseParams({ prFiles: makePrFiles({ truncated: true, omittedCountLowerBound: 3 }) }),
      ),
    ).rejects.toThrow(ReviewEvidenceCoverageError);
  });

  it("uses git-derived source and marks SLO exemption for truncated listings", async () => {
    const workspace = makeWorkspace({
      baseDerivation: {
        baseSha: BASE_SHA,
        mergeBaseSha: MERGE_BASE_SHA,
        changedFiles: [],
        derivedDiffByPath: new Map(),
        diffOmittedByBudgetPaths: new Set(),
      },
      changedFiles: [
        { path: "a.ts", status: "modified" },
        { path: "b.ts", status: "added" },
        { path: "c.ts", status: "deleted" },
      ],
    });
    const snapshot = await buildReviewEvidenceSnapshot(
      baseParams({
        prFiles: makePrFiles({ truncated: true, omittedCountLowerBound: 1 }),
        workspace,
      }),
    );
    expect(snapshot.source).toBe("git-derived");
    expect(snapshot.files.map((file) => file.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(snapshot.truncatedListing).toBe(true);
    expect(snapshot.sloExempt).toBe(true);
    expect(snapshot.sloExemptReasons).toContain("truncated-listing");
  });

  it("records omission reasons and coverage gaps for capped diffs", async () => {
    const workspace = makeWorkspace({
      getDiffForPath: async (path: string) =>
        path === "a.ts"
          ? "[patch omitted: exceeds configured PR patch byte cap]"
          : "[diff omitted: evidence diff byte ceiling exceeded]",
    });
    const snapshot = await buildReviewEvidenceSnapshot(baseParams({ workspace }));
    expect(snapshot.files[0]?.diffOmitted).toBe("patch-byte-cap");
    expect(snapshot.files[1]?.diffOmitted).toBe("evidence-byte-cap");
    expect(snapshot.coverageGaps).toHaveLength(2);
  });

  it("preserves rename and deletion status without reading deleted head content", async () => {
    const workspace = makeWorkspace({
      changedFiles: [
        { path: "renamed.ts", status: "renamed", oldPath: "old.ts" },
        { path: "gone.ts", status: "deleted" },
      ],
      getDiffForPath: async () => "",
    });
    const snapshot = await buildReviewEvidenceSnapshot(baseParams({ workspace }));
    expect(snapshot.files.find((file) => file.path === "renamed.ts")).toMatchObject({
      status: "renamed",
      oldPath: "old.ts",
      diffOmitted: "diff-unavailable",
    });
    expect(snapshot.files.find((file) => file.path === "gone.ts")?.status).toBe("deleted");
  });

  it("produces a deterministic hash that changes with prompt-relevant inputs", async () => {
    const first = await buildReviewEvidenceSnapshot(baseParams());
    const second = await buildReviewEvidenceSnapshot(baseParams());
    expect(first.evidenceHash).toBe(second.evidenceHash);

    const headChanged = await buildReviewEvidenceSnapshot(baseParams({ headSha: "d".repeat(40) }));
    expect(headChanged.evidenceHash).not.toBe(first.evidenceHash);

    const policyChanged = await buildReviewEvidenceSnapshot(
      baseParams({ policyContext: "different policy" }),
    );
    expect(policyChanged.evidenceHash).not.toBe(first.evidenceHash);

    const diffChanged = await buildReviewEvidenceSnapshot(
      baseParams({
        workspace: makeWorkspace({ getDiffForPath: async () => "@@ -1 +1 @@\n-x\n+y" }),
      }),
    );
    expect(diffChanged.evidenceHash).not.toBe(first.evidenceHash);

    const priorFeedbackChanged = await buildReviewEvidenceSnapshot(
      baseParams({ priorInlineFeedback: "prior threads" }),
    );
    expect(priorFeedbackChanged.evidenceHash).not.toBe(first.evidenceHash);
  });

  it("marks large change sets as SLO exempt", async () => {
    const snapshot = await buildReviewEvidenceSnapshot(
      baseParams({ prFiles: makePrFiles({ totalChanges: 5000 }) }),
    );
    expect(snapshot.budgetTier).toBe("large");
    expect(snapshot.sloExempt).toBe(true);
    expect(snapshot.sloExemptReasons).toEqual(["large-change-set"]);
  });
});

describe("classifyReviewSloExemption", () => {
  it("returns no reasons for small non-truncated runs", () => {
    expect(classifyReviewSloExemption({ truncated: false, budgetTier: "small" })).toEqual([]);
  });

  it("collects truncation and size reasons", () => {
    expect(classifyReviewSloExemption({ truncated: true, budgetTier: "large" })).toEqual([
      "truncated-listing",
      "large-change-set",
    ]);
  });
});

describe("formatReviewEvidenceBlock", () => {
  it("renders identity, coverage, trusted policy context, and untrusted diff content", async () => {
    const snapshot = await buildReviewEvidenceSnapshot({
      ...baseParams(),
      policyContext: "severity floor: P1",
      priorInlineFeedback: "prior finding note",
    });
    const block = formatReviewEvidenceBlock(snapshot);
    expect(block).toContain(`Evidence hash: ${snapshot.evidenceHash}`);
    expect(block).toContain("## Repository policy and trusted context");
    expect(block).toContain("severity floor: P1");
    expect(block).toContain("## Prior inline feedback");
    expect(block).toContain("prior finding note");
    expect(block).toContain('<shared_evidence_diffs untrusted="true">');
    expect(block).toContain("### a.ts [modified]");
    expect(block).toContain("+new");
  });
});
