import { describe, expect, it } from "vitest";
import { assertFindingsHaveEvidence } from "../src/review/findings/evidenceValidator.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import { createTestEvidenceLedger, seedEvidenceForFinding } from "./helpers/evidenceTestHelpers.js";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "P1",
    file: "src/a.ts",
    startLine: 4,
    endLine: 6,
    title: "Issue",
    detail: "Details.",
    fixPrompt: "Fix it.",
    ...overrides,
  };
}

describe("assertFindingsHaveEvidence", () => {
  it("rejects findings without a prior read", () => {
    const ledger = createTestEvidenceLedger();
    const item = finding();

    const result = assertFindingsHaveEvidence([item], ledger, ledger.headSha);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reasonCode).toBe("no_evidence");
  });

  it("accepts findings after a synthetic read covers the cited lines", () => {
    const ledger = createTestEvidenceLedger();
    const item = finding();
    seedEvidenceForFinding(ledger, item);

    const result = assertFindingsHaveEvidence([item], ledger, ledger.headSha);

    expect(result.accepted).toEqual([item]);
    expect(result.rejected).toEqual([]);
  });

  it("rejects sparse-checkout paths outside the checkout without evidence", () => {
    const ledger = createTestEvidenceLedger();
    const item = finding({ file: "src/missing.ts" });

    const result = assertFindingsHaveEvidence([item], ledger, ledger.headSha, {
      checkoutCoverage: {
        mode: "sparse",
        pathsInCheckout: 1,
        changedFileCount: 2,
        changeSetTruncated: false,
      },
      isPathInCheckout: (path) => path === "src/a.ts",
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reasonCode).toBe("sparse_path_no_evidence");
  });
});
