import { describe, expect, it } from "vitest";
import { readTextWithOutputBudget } from "../src/agent/tools/toolOutputBudget.ts";
import { recordDeliveredFileRead } from "../src/review/findings/evidenceLedger.ts";
import { assertFindingsHaveEvidence } from "../src/review/findings/evidenceValidator.ts";
import type { ReviewFinding } from "../src/review/reviewSchema.ts";
import { LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS } from "../src/settings/index.ts";
import { createTestEvidenceLedger, seedEvidenceForFinding } from "./helpers/evidenceTestHelpers.ts";

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

  it("rejects findings when only code index hints were used (no readWorkspaceFile)", () => {
    const ledger = createTestEvidenceLedger();
    const item = finding();

    const result = assertFindingsHaveEvidence([item], ledger, ledger.headSha);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reasonCode).toBe("no_evidence");
    expect(ledger.snapshot()).toEqual([]);
  });

  it("rejects a cite recorded only on another specialist ledger", () => {
    const security = createTestEvidenceLedger();
    const tests = createTestEvidenceLedger();
    const item = finding();
    seedEvidenceForFinding(security, item);

    const missing = assertFindingsHaveEvidence([item], tests, tests.headSha);
    expect(missing.accepted).toEqual([]);
    expect(missing.rejected[0]?.reasonCode).toBe("no_evidence");

    seedEvidenceForFinding(tests, item);
    const present = assertFindingsHaveEvidence([item], tests, tests.headSha);
    expect(present.accepted).toEqual([item]);
    expect(present.rejected).toEqual([]);
  });

  it("rejects citations on a prefix-clamped line while accepting whole neighbours", () => {
    const ledger = createTestEvidenceLedger();
    const longLine = "q".repeat(LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS + 100);
    const read = readTextWithOutputBudget(`top\n${longLine}\nbottom\n`, 128_000);
    recordDeliveredFileRead(ledger, {
      path: "src/a.ts",
      headSha: ledger.headSha,
      tool: "readWorkspaceFile",
      startLine: read.startLine,
      endLine: read.endLine,
      content: read.content,
      clampedLines: read.clampedLines,
    });

    expect(ledger.covers("src/a.ts", 1, 1)).toBe(true);
    expect(ledger.covers("src/a.ts", 2, 2)).toBe(false);
    expect(ledger.covers("src/a.ts", 3, 3)).toBe(true);

    const onTop = finding({ startLine: 1, endLine: 1 });
    const onClamped = finding({ startLine: 2, endLine: 2 });
    const onBottom = finding({ startLine: 3, endLine: 3 });
    const result = assertFindingsHaveEvidence([onTop, onClamped, onBottom], ledger, ledger.headSha);

    expect(result.accepted).toEqual([onTop, onBottom]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.finding).toEqual(onClamped);
    expect(result.rejected[0]?.reasonCode).toBe("no_evidence");
  });

  it("rejects a citation on the byte-capped last line of a single-line read", () => {
    const ledger = createTestEvidenceLedger();
    const read = readTextWithOutputBudget(`before\n${"m".repeat(500_000)}`, 64, {
      startLine: 2,
      maxLines: 1,
    });
    recordDeliveredFileRead(ledger, {
      path: "src/a.ts",
      headSha: ledger.headSha,
      tool: "readWorkspaceFile",
      startLine: read.startLine,
      endLine: read.endLine,
      content: read.content,
      clampedLines: read.clampedLines,
    });

    expect(ledger.covers("src/a.ts", 2, 2)).toBe(false);
    const result = assertFindingsHaveEvidence(
      [finding({ startLine: 2, endLine: 2 })],
      ledger,
      ledger.headSha,
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reasonCode).toBe("no_evidence");
  });
});
