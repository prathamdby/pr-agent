import { describe, expect, it } from "vitest";
import { buildHybridSynthesisContext } from "../src/review/run/reviewSynthesis.js";
import type { CriticReport } from "../src/review/run/reviewCritics.js";

function finding(
  overrides: Partial<CriticReport["findings"][number]> = {},
): CriticReport["findings"][number] {
  return {
    severity: "P1",
    file: "src/file.ts",
    startLine: 1,
    endLine: 1,
    title: "Finding",
    detail: "Detail",
    fixPrompt: "Fix",
    confidence: 5,
    category: "bug",
    evidence: "Evidence",
    ...overrides,
  };
}

function criticReport(critic: string, findings: CriticReport["findings"]): CriticReport {
  return {
    critic: critic as CriticReport["critic"],
    coverage: "covered",
    findings,
    residualRisks: [],
    testingGaps: [],
  };
}

describe("buildHybridSynthesisContext", () => {
  it("maps critic reports to synthesis input with reviewer field", () => {
    const context = buildHybridSynthesisContext({
      reports: [criticReport("correctness", [finding()])],
      failedCriticIds: [],
    });
    expect(context).toContain("correctness");
    expect(context).toContain("reviewer_reports");
  });

  it("includes failed critic IDs in degraded coverage", () => {
    const context = buildHybridSynthesisContext({
      reports: [criticReport("correctness", [])],
      failedCriticIds: ["change-safety"],
    });
    expect(context).toContain("change-safety");
    expect(context).toContain("degraded_coverage");
  });

  it("includes unvalidated high-risk count in degraded coverage", () => {
    const context = buildHybridSynthesisContext({
      reports: [criticReport("correctness", [finding({ severity: "P0" })])],
      failedCriticIds: [],
      unvalidatedHighRisk: 2,
    });
    expect(context).toContain("Unvalidated high-risk findings");
    expect(context).toContain("2");
  });

  it("uses hybrid synthesis instruction", () => {
    const context = buildHybridSynthesisContext({
      reports: [],
      failedCriticIds: [],
    });
    expect(context).toContain("validated critic reports");
    expect(context).toContain("submitReview exactly once");
  });
});
