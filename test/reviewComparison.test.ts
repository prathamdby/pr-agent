import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import {
  compareFindings,
  evaluateGates,
  MAX_FP_REGRESSION_PERCENTAGE_POINTS,
  MIN_REPLAY_CASES,
  MIN_SHADOW_DAYS,
  MIN_SHADOW_REVIEWS,
  normalizeFinding,
  type AdjudicatedFinding,
  type NormalizedFinding,
} from "../src/review/evaluation/reviewComparison.js";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "P1",
    file: "src/file.ts",
    startLine: 10,
    endLine: 10,
    title: "Missing null check",
    detail: "The variable can be null at this point.",
    fixPrompt: "Add a null check before using the variable.",
    confidence: 5,
    category: "bug",
    ...overrides,
  };
}

function adjudicated(overrides: Partial<AdjudicatedFinding> = {}): AdjudicatedFinding {
  return {
    id: "f1",
    file: "src/file.ts",
    lineBucket: 0,
    normalizedTitle: "missing null check",
    severity: "P1",
    valid: true,
    ...overrides,
  };
}

describe("normalizeFinding", () => {
  it("reduces a finding to file, line bucket, normalized title, and severity", () => {
    const n = normalizeFinding(finding({ title: "Missing Null Check!" }));
    expect(n.file).toBe("src/file.ts");
    expect(n.lineBucket).toBe(0);
    expect(n.normalizedTitle).toBe("missing null check");
    expect(n.severity).toBe("P1");
  });
});

describe("compareFindings", () => {
  it("matches findings that agree on file, line bucket, and normalized title", () => {
    const legacy = [normalizeFinding(finding())];
    const hybrid = [normalizeFinding(finding())];
    const result = compareFindings({ legacy, hybrid, adjudicated: [] });
    expect(result.matchedCount).toBe(1);
    expect(result.legacyOnlyCount).toBe(0);
    expect(result.hybridOnlyCount).toBe(0);
  });

  it("counts legacy-only and hybrid-only findings separately", () => {
    const legacy = [
      normalizeFinding(finding({ file: "a.ts" })),
      normalizeFinding(finding({ file: "b.ts" })),
    ];
    const hybrid = [
      normalizeFinding(finding({ file: "a.ts" })),
      normalizeFinding(finding({ file: "c.ts" })),
    ];
    const result = compareFindings({ legacy, hybrid, adjudicated: [] });
    expect(result.matchedCount).toBe(1);
    expect(result.legacyOnlyCount).toBe(1);
    expect(result.hybridOnlyCount).toBe(1);
  });
});

describe("evaluateGates", () => {
  it("passes recall when hybrid finds all valid findings legacy found", () => {
    const adj = [adjudicated({ id: "f1" })];
    const legacy = [normalizeFinding(finding())];
    const hybrid = [normalizeFinding(finding())];
    const comparison = compareFindings({ legacy, hybrid, adjudicated: adj });
    const gate = evaluateGates({
      comparison,
      adjudicated: adj,
      legacyCaseCount: MIN_REPLAY_CASES,
      shadowReviewCount: MIN_SHADOW_REVIEWS,
      shadowDays: MIN_SHADOW_DAYS,
    });
    expect(gate.recallPass).toBe(true);
  });

  it("fails recall when legacy found a valid finding hybrid missed", () => {
    const adj = [adjudicated({ id: "f1" })];
    const legacy = [normalizeFinding(finding())];
    const hybrid: NormalizedFinding[] = [];
    const comparison = compareFindings({ legacy, hybrid, adjudicated: adj });
    const gate = evaluateGates({
      comparison,
      adjudicated: adj,
      legacyCaseCount: MIN_REPLAY_CASES,
    });
    expect(gate.recallPass).toBe(false);
  });

  it("records hybrid-only valid finding as improvement not failure", () => {
    const adj = [adjudicated({ id: "f1" })];
    const legacy: NormalizedFinding[] = [];
    const hybrid = [normalizeFinding(finding())];
    const comparison = compareFindings({ legacy, hybrid, adjudicated: adj });
    const gate = evaluateGates({
      comparison,
      adjudicated: adj,
      legacyCaseCount: MIN_REPLAY_CASES,
    });
    expect(gate.recallPass).toBe(true);
  });

  it("fails false-positive when hybrid FP rate exceeds legacy by more than tolerance", () => {
    const adj = [adjudicated({ id: "f1", file: "a.ts", normalizedTitle: "known issue" })];
    const legacy = [normalizeFinding(finding({ file: "a.ts", title: "Known issue" }))];
    const hybrid = [
      normalizeFinding(finding({ file: "a.ts", title: "Known issue" })),
      normalizeFinding(finding({ file: "b.ts", title: "False positive 1" })),
      normalizeFinding(finding({ file: "c.ts", title: "False positive 2" })),
    ];
    const comparison = compareFindings({ legacy, hybrid, adjudicated: adj });
    const gate = evaluateGates({
      comparison,
      adjudicated: adj,
      legacyCaseCount: MIN_REPLAY_CASES,
    });
    expect(gate.falsePositivePass).toBe(false);
  });

  it("reports case count and shadow gate status", () => {
    const comparison = compareFindings({ legacy: [], hybrid: [], adjudicated: [] });
    const gate = evaluateGates({
      comparison,
      adjudicated: [],
      legacyCaseCount: 10,
      shadowReviewCount: 50,
      shadowDays: 3,
    });
    expect(gate.details).toContain("10/50 required");
    expect(gate.details).toContain("50/300 reviews");
    expect(gate.details).toContain("3/7 days");
  });

  it("uses the configured max FP regression threshold", () => {
    expect(MAX_FP_REGRESSION_PERCENTAGE_POINTS).toBe(2);
  });
});
